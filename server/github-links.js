'use strict';
/**
 * GitHub, linked once (plan §AD.10 step 3): a person's one GitHub token, so a push mirror needs no token of its own.
 *
 *   link(subject, token)   asks GitHub who the token belongs to (GET /user), then keeps it sealed with that login
 *   get(subject)           → { login, linked_at } | null      (never the token)
 *   tokenFor(subject)      → the token, for a push mirror      (server/mirror.js only)
 *   unlink(subject)        → true when there was one
 *
 * The token is sealed at rest (server/crypto.js) and passed to git in the environment, never in argv or a log.
 */
const { seal, open } = require('./crypto');

const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function createGithubLinks({ store, config, fetchImpl = globalThis.fetch }) {
    const key = () => config.tokens.secretKey;

    async function link(subject, token) {
        const t = String(token || '').trim();
        if (!subject) throw Object.assign(new Error('Sign in first.'), { status: 401 });
        if (!TOKEN_RE.test(t)) throw Object.assign(new Error('That does not look like a GitHub token (ghp_…, github_pat_…).'), { status: 422 });
        let res;
        try {
            res = await fetchImpl('https://api.github.com/user', {
                headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openvibe-git', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${t}` },
                signal: AbortSignal.timeout(10_000),
            });
        } catch {
            throw Object.assign(new Error('GitHub did not answer. Try again in a moment.'), { status: 502 });
        }
        if (res.status === 401) throw Object.assign(new Error('GitHub does not accept that token.'), { status: 422 });
        if (!res.ok) throw Object.assign(new Error(`GitHub answered ${res.status}. Try again in a moment.`), { status: 502 });
        const me = await res.json().catch(() => ({}));
        const login = String((me && me.login) || '');
        if (!LOGIN_RE.test(login)) throw Object.assign(new Error('GitHub did not say whose token that is.'), { status: 502 });
        await store.execute(`INSERT INTO git_github_links (subject, login, token) VALUES (?, ?, ?)
            ON CONFLICT (subject) DO UPDATE SET login = EXCLUDED.login, token = EXCLUDED.token, updated_at = now()`, [subject, login, seal(t, key())]);
        return { login };
    }

    async function get(subject) {
        if (!subject) return null;
        const row = await store.maybe('SELECT login, updated_at FROM git_github_links WHERE subject = ?', [subject]);
        return row ? { login: row.login, linked_at: row.updated_at } : null;
    }

    async function tokenFor(subject) {
        if (!subject) return '';
        const row = await store.maybe('SELECT token FROM git_github_links WHERE subject = ?', [subject]);
        return row ? (open(row.token, key()) || '') : '';
    }

    async function unlink(subject) {
        if (!subject) return false;
        const row = await store.maybe('DELETE FROM git_github_links WHERE subject = ? RETURNING subject', [subject]);
        return Boolean(row);
    }

    return { link, get, tokenFor, unlink };
}

module.exports = { createGithubLinks };
