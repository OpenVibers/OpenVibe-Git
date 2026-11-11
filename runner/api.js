'use strict';

/**
 * The runner's HTTP client. One bearer token in the Authorization header, never in a URL, a log or an error.
 * A claim answered 204 is "nothing queued"; a verdict answered 409 is "that run was superseded", not a failure.
 */
const os = require('node:os');

function createApi({ baseUrl, token, log = console }) {
    async function request(pathname, { method = 'GET', body = null, timeoutMs = 20_000 } = {}) {
        const res = await fetch(`${baseUrl}${pathname}`, {
            method,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': `openvibe-git-ci/${os.hostname()}` },
            body: body == null ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        if (!res.ok) {
            const err = new Error(`the forge answered ${res.status} for ${pathname}`);
            err.status = res.status;
            err.body = text.slice(0, 500);
            throw err;
        }
        return text ? JSON.parse(text) : null;
    }

    return {
        request,
        register: (repos) => request('/api/v1/ci/repos', { method: 'POST', body: { repos } }),
        claim: () => request('/api/v1/ci/runs/claim', { method: 'POST', body: { runner: os.hostname() || 'forge-runner' } }),
        heartbeat: (id) => request(`/api/v1/ci/runs/${encodeURIComponent(id)}/heartbeat`),
        log: (id, chunk) => request(`/api/v1/ci/runs/${encodeURIComponent(id)}/log`, { method: 'POST', body: { chunk }, timeoutMs: 30_000 }),
        finish: async (id, verdict) => {
            try {
                return await request(`/api/v1/ci/runs/${encodeURIComponent(id)}/status`, { method: 'POST', body: verdict, timeoutMs: 30_000 });
            } catch (err) {
                if (err.status === 409) return null;
                throw err;
            }
        },
    };
}

module.exports = { createApi };
