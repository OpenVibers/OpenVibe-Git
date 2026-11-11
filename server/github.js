'use strict';

/**
 * GitHub, read only: the repository card (stars, open issues and PRs, the last CI state), the metadata a
 * mirror is created from, the open PR heads and check-runs the checks intake copies, and the signature check on
 * GitHub's push webhook.
 *
 * Every reading is cached for ten minutes (config.github.cacheMs), so a card costs our quota once per ten
 * minutes, not once per view. The API token (for the OpenVibers repositories) is sent only to
 * api.github.com; without one the public limit applies.
 */
const crypto = require('node:crypto');
const { assertPublicUrl } = require('openvibe-shared/egress');

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const FULL_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_WEB = 'https://github.com';

// ls-refs for HEAD in git's protocol v2, with symrefs so the answer names the default branch. Each pkt-line carries
// its own length in hex, four bytes included; 0001 is the delimiter between the command and its arguments.
const pktLine = (text) => (Buffer.byteLength(text, 'utf8') + 4).toString(16).padStart(4, '0') + text;
const LS_REFS_HEAD = pktLine('command=ls-refs\n') + '0001' + pktLine('symrefs\n') + pktLine('ref-prefix HEAD\n') + '0000';

/** The refs in an ls-refs answer: [{ sha, ref, attrs }]. Lengths, delimiters and flushes are skipped. */
function parseRefs(text) {
    const refs = [];
    const body = String(text || '');
    let i = 0;
    while (i + 4 <= body.length) {
        const size = parseInt(body.slice(i, i + 4), 16);
        if (size === 0 || size === 1 || size === 2) { i += 4; continue; }
        if (!Number.isFinite(size) || size < 4 || i + size > body.length) break;
        const line = body.slice(i + 4, i + size).replace(/\n$/, '');
        i += size;
        if (!line) continue;
        const parts = line.split(' ');
        if (parts.length < 2) continue;
        refs.push({ sha: parts[0], ref: parts[1], attrs: parts.slice(2) });
    }
    return refs;
}

/** A public GitHub repository URL → { full_name, clone_url }, or null. No credentials, no other host. */
function parseGithubUrl(input) {
    let u;
    try { u = new URL(String(input || '')); } catch { return null; }
    if (u.protocol !== 'https:' || !GITHUB_HOSTS.has(u.hostname)) return null;
    if (u.username || u.password || u.search || u.hash) return null;
    const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length !== 2) return null;
    const name = parts[1].replace(/\.git$/, '');
    if (!FULL_RE.test(`${parts[0]}/${name}`)) return null;
    if (name === '.' || name === '..') return null;
    return { full_name: `${parts[0]}/${name}`, clone_url: `https://github.com/${parts[0]}/${name}.git` };
}

function createGithubClient({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console, lookup = null, guard = null }) {
    const cache = new Map();   // full_name (lower) → { at, card }
    const metaCache = new Map();
    const probeCache = new Map();
    const headers = () => {
        const h = { accept: 'application/vnd.github+json', 'user-agent': 'openvibe-git' };
        if (config.github.token) h.authorization = `Bearer ${config.github.token}`;
        return h;
    };
    async function api(path) {
        const res = await fetchImpl(`${config.github.apiUrl}${path}`, { headers: headers(), signal: AbortSignal.timeout(8000) });
        if (!res.ok) {
            const err = new Error(`GitHub ${res.status} for ${path}`);
            err.status = res.status;
            throw err;
        }
        return res.json();
    }

    /** The cached card for a GitHub twin. Returns null rather than failing a page. */
    async function card(full, { branch = 'main', fresh = false } = {}) {
        const key = String(full || '').toLowerCase();
        if (!FULL_RE.test(String(full || ''))) return null;
        const hit = cache.get(key);
        if (!fresh && hit && now() - hit.at < config.github.cacheMs) return hit.card;
        try {
            const [repo, prs, status] = await Promise.all([
                api(`/repos/${encodeURIComponent(full.split('/')[0])}/${encodeURIComponent(full.split('/')[1])}`).catch(() => null),
                api(`/search/issues?q=${encodeURIComponent(`repo:${full} type:pr state:open`)}&per_page=1`).catch(() => null),
                api(`/repos/${encodeURIComponent(full.split('/')[0])}/${encodeURIComponent(full.split('/')[1])}/commits/${encodeURIComponent(branch)}/status`).catch(() => null),
            ]);
            if (!repo) return hit ? hit.card : null;
            const card = {
                full_name: repo.full_name,
                html_url: repo.html_url,
                stars: Number(repo.stargazers_count) || 0,
                open_issues: Math.max(0, (Number(repo.open_issues_count) || 0) - (Number(prs && prs.total_count) || 0)),
                open_pull_requests: Number(prs && prs.total_count) || 0,
                ci_state: status && ['success', 'failure', 'pending'].includes(status.state) ? status.state : 'unknown',
                fetched_at: new Date(now()).toISOString(),
            };
            cache.set(key, { at: now(), card });
            return card;
        } catch (err) {
            (log.warn || log.log)(`[OpenVibe.Git] GitHub card ${full}: ${err.message}`);
            return hit ? hit.card : null;
        }
    }

    /** Mirror metadata: description, default branch, language. */
    async function meta(full) {
        const key = String(full || '').toLowerCase();
        const hit = metaCache.get(key);
        if (hit && now() - hit.at < config.github.cacheMs) return hit.meta;
        const [owner, name] = String(full).split('/');
        const repo = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
        const meta = {
            full_name: repo.full_name, description: repo.description || '', default_branch: repo.default_branch || 'main',
            language: repo.language || null, stars: Number(repo.stargazers_count) || 0, private: !!repo.private,
            topics: Array.isArray(repo.topics) ? repo.topics.map(String).slice(0, 20) : [],
        };
        metaCache.set(key, { at: now(), meta });
        return meta;
    }

    /**
     * Whether a GitHub repository is public, and its default branch, through git's own protocol: a protocol-v2
     * ls-refs POST needs no REST quota (git clone and fetch need none either). GitHub answers 401 for a private
     * repository and 404 for a missing one; both are skipped by the caller. Through the egress guard like every
     * other connection to github.com.
     */
    async function probe(full) {
        const name = String(full || '');
        if (!FULL_RE.test(name)) return { state: 'invalid', default_branch: null };
        const key = name.toLowerCase();
        const hit = probeCache.get(key);
        if (hit && now() - hit.at < 60_000) return hit.value;
        const url = `${GITHUB_WEB}/${name}.git/git-upload-pack`;
        let res;
        try {
            if (guard) await guard(url);
            else await assertPublicUrl(url, lookup ? { lookup } : undefined);
            res = await fetchImpl(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/x-git-upload-pack-request',
                    accept: 'application/x-git-upload-pack-result',
                    'git-protocol': 'version=2',
                    'accept-encoding': 'identity',
                    'user-agent': 'openvibe-git',
                },
                body: LS_REFS_HEAD,
                signal: AbortSignal.timeout(8000),
            });
        } catch (err) {
            return { state: 'unknown', default_branch: null, error: String(err.message || err).slice(0, 200) };
        }
        let value;
        if (res.status === 401) value = { state: 'private', default_branch: null };
        else if (res.status === 404) value = { state: 'missing', default_branch: null };
        else if (!res.ok) value = { state: 'unknown', default_branch: null, error: `GitHub ${res.status}` };
        else {
            let text = '';
            try { text = typeof res.text === 'function' ? await res.text() : ''; } catch { text = ''; }
            const refs = parseRefs(text);
            const head = refs.find((r) => r.ref === 'HEAD');
            const target = head && head.attrs.map((a) => (a.startsWith('symref-target:') ? a.slice('symref-target:'.length) : '')).find(Boolean);
            const branch = target && target.startsWith('refs/heads/') ? target.slice('refs/heads/'.length) : 'main';
            value = { state: 'public', default_branch: branch, head: head ? head.sha : null };
        }
        probeCache.set(key, { at: now(), value });
        return value;
    }

    /** The `rel="next"` URL in a GitHub Link header, if it stays on the configured API origin. */
    function nextLink(header) {
        if (!header) return null;
        const match = /<([^>]+)>\s*;\s*rel="next"/i.exec(String(header));
        if (!match) return null;
        try {
            const next = new URL(match[1], config.github.apiUrl);
            // The token is on every request: never follow a page onto another host.
            if (next.origin !== new URL(config.github.apiUrl).origin) return null;
            return next.toString();
        } catch { return null; }
    }

    /**
     * Every public repository of an organisation (or of a user account: OpenVibers is one, and GitHub answers 404 for
     * /orgs/<user>/repos, 11-09), following GitHub's Link pagination.
     */
    async function orgRepos(org, { perPage = 100, maxPages = 100 } = {}) {
        const apiOrigin = new URL(config.github.apiUrl).origin;
        let url = `${config.github.apiUrl}/orgs/${encodeURIComponent(org)}/repos?type=public&per_page=${perPage}`;
        let triedUser = false;
        const all = [];
        for (let page = 0; url && page < maxPages; page += 1) {
            const current = new URL(url);
            if (current.origin !== apiOrigin) throw new Error('GitHub pagination left the API origin');
            const res = await fetchImpl(current.toString(), { headers: headers(), signal: AbortSignal.timeout(15_000) });
            if (res.status === 404 && page === 0 && !triedUser) {
                // Not an organisation: the same name as a user account. type=owner lists what it owns; private ones
                // never appear without that account's token, and the seed keeps only public repositories anyway.
                triedUser = true;
                url = `${config.github.apiUrl}/users/${encodeURIComponent(org)}/repos?type=owner&per_page=${perPage}`;
                page -= 1;
                continue;
            }
            if (!res.ok) {
                const err = new Error(`GitHub ${res.status} for ${current.pathname}`);
                err.status = res.status;
                throw err;
            }
            const batch = await res.json();
            if (!Array.isArray(batch)) throw new Error('GitHub returned no repository list');
            // The listing carries what meta() would ask for: cache it, so mirroring 70 repositories costs a page or two
            // of the API, not one call each (the host has 60 an hour without a token).
            for (const repo of batch) {
                if (!repo || !repo.full_name) continue;
                metaCache.set(String(repo.full_name).toLowerCase(), { at: now(), meta: {
                    full_name: repo.full_name, description: repo.description || '', default_branch: repo.default_branch || 'main',
                    language: repo.language || null, stars: Number(repo.stargazers_count) || 0, private: !!repo.private,
                    topics: Array.isArray(repo.topics) ? repo.topics.map(String).slice(0, 20) : [],
                } });
            }
            all.push(...batch);
            url = nextLink(res.headers && typeof res.headers.get === 'function' ? res.headers.get('link') : null);
        }
        return all;
    }

    /**
     * The open pull requests' heads: [{ number, head_sha }]. One REST call per page (a few at most); the
     * checks intake calls this, then asks about the check-runs of the heads that moved only.
     */
    async function openPulls(full) {
        if (!FULL_RE.test(String(full || ''))) return [];
        const [owner, name] = String(full).split('/');
        const out = [];
        let url = `${config.github.apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=open&per_page=100`;
        for (let page = 0; page < 3 && url; page += 1) {
            const res = await fetchImpl(url, { headers: headers(), signal: AbortSignal.timeout(15_000) });
            if (!res.ok) {
                const err = new Error(`GitHub ${res.status} for ${full} pulls`);
                err.status = res.status;
                throw err;
            }
            const batch = await res.json();
            if (!Array.isArray(batch)) break;
            for (const pr of batch) {
                if (pr && pr.head && /^[0-9a-f]{40}$/i.test(pr.head.sha || '')) out.push({ number: pr.number, head_sha: String(pr.head.sha).toLowerCase() });
            }
            if (batch.length < 100) break;
            // The next page stays on the API origin (nextLink refuses anything else).
            url = nextLink(res.headers && typeof res.headers.get === 'function' ? res.headers.get('link') : null);
        }
        return out;
    }

    /** The check-runs GitHub reports for one commit (at most 100): the checks intake copies these. */
    async function checkRuns(full, sha) {
        if (!FULL_RE.test(String(full || ''))) return [];
        if (!/^[0-9a-f]{40}$/i.test(String(sha || ''))) return [];
        const [owner, name] = String(full).split('/');
        const res = await fetchImpl(
            `${config.github.apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(String(sha).toLowerCase())}/check-runs?per_page=100`,
            { headers: headers(), signal: AbortSignal.timeout(15_000) },
        );
        if (!res.ok) {
            const err = new Error(`GitHub ${res.status} for ${full} check-runs`);
            err.status = res.status;
            throw err;
        }
        const body = await res.json();
        return Array.isArray(body && body.check_runs) ? body.check_runs : [];
    }

    /**
     * The permission a GitHub login has on one repository: admin, maintain, write, triage, read, or null when
     * the login is not a collaborator. This is the push-access check the forge runner trusts (10-minute cache
     * in server/ci.js); a 404 is an answer, not an error.
     */
    async function permission(full, login) {
        if (!FULL_RE.test(String(full || ''))) return null;
        const who = String(login || '');
        if (!/^[A-Za-z0-9-]{1,39}$/.test(who)) return null;
        const [owner, name] = String(full).split('/');
        const res = await fetchImpl(
            `${config.github.apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/collaborators/${encodeURIComponent(who)}/permission`,
            { headers: headers(), signal: AbortSignal.timeout(10_000) },
        );
        if (res.status === 404) return null;
        if (!res.ok) {
            const err = new Error(`GitHub ${res.status} for ${full} permission`);
            err.status = res.status;
            throw err;
        }
        const body = await res.json();
        return body && typeof body.permission === 'string' ? body.permission : null;
    }

    /** GitHub's X-Hub-Signature-256 over the raw body, constant time. */
    function signatureOk(rawBody, signature) {
        const secret = config.github.webhookSecret;
        if (!secret || !signature) return false;
        const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
        const a = Buffer.from(expected);
        const b = Buffer.from(String(signature));
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    return { parseGithubUrl, card, meta, probe, orgRepos, openPulls, checkRuns, permission, signatureOk, _cache: cache };
}

module.exports = { createGithubClient, parseGithubUrl, parseRefs, pktLine, FULL_RE };
