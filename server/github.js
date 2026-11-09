'use strict';

/**
 * GitHub, read only: the repository card (stars, open issues and PRs, the last CI state), the metadata a
 * mirror is created from, and the signature check on GitHub's push webhook.
 *
 * Every reading is cached for ten minutes (config.github.cacheMs), so a card costs our quota once per ten
 * minutes, not once per view. The API token (for the OpenVibers repositories) is sent only to
 * api.github.com; without one the public limit applies.
 */
const crypto = require('node:crypto');

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const FULL_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

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

function createGithubClient({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const cache = new Map();   // full_name (lower) → { at, card }
    const metaCache = new Map();
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
        };
        metaCache.set(key, { at: now(), meta });
        return meta;
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
            all.push(...batch);
            url = nextLink(res.headers && typeof res.headers.get === 'function' ? res.headers.get('link') : null);
        }
        return all;
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

    return { parseGithubUrl, card, meta, orgRepos, signatureOk, _cache: cache };
}

module.exports = { createGithubClient, parseGithubUrl, FULL_RE };
