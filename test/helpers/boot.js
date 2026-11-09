'use strict';
// Many requests per test file: the per-address limits would answer 429 part-way.
process.env.GIT_RATE_LIMIT_PER_MIN = process.env.GIT_RATE_LIMIT_PER_MIN || '100000';
/**
 * Boots OpenVibe.Git on a temp database and a temp git data directory, with a mock Network (test/helpers/mocks.js).
 * Every test file gets its own process, so its own paths.
 *
 *   const t = await boot();
 *   t.get(path, { as: user, bearer, json, form, headers, method, cookie })   the site and the API
 *   t.signIn(user) → 'ov_token=…'
 *   t.ctx.repos / t.ctx.store                                                 seed and inspect
 *   t.git(args, cwd, { urlToken })                                            runs git, Basic auth in the URL
 */
const http = require('http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startNetwork } = require('./mocks');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'openvibe-git-test-'));
process.env.GIT_DATA_DIR = DATA;

const captured = [];
for (const m of ['log', 'info', 'warn', 'error']) {
    const orig = console[m].bind(console);
    console[m] = (...a) => { captured.push(a.map(String).join(' ')); if (process.env.VERBOSE) orig(...a); };
}

async function boot(opts = {}) {
    const network = await startNetwork();
    const env = {
        NODE_ENV: 'test', PORT: '0', BASE_URL: 'http://127.0.0.1', TRUST_PROXY: '1',
        OV_NETWORK_URL: network.url, OV_NETWORK_INTERNAL_URL: network.url, OV_NETWORK_ISSUER: network.url,
        OV_OAUTH_CLIENT_ID: 'git', OV_OAUTH_CLIENT_SECRET: 'git-secret', COOKIE_SECURE: 'false',
        GIT_DRILL: '1', GIT_GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
        GIT_SECRET_KEY: 'test-git-secret-key-0123456789abcdef', GIT_GITHUB_TOKEN: '',
        GIT_API_RATE_LIMIT_PER_MIN: '100000', GIT_PAGE_RATE_LIMIT_PER_MIN: '100000',
        ...(opts.env || {}),
    };
    const configLib = require('../../server/config');
    const { createApp } = require('../../server/app');
    const { createStore } = require('../../server/db');
    const config = configLib.load(env);
    const testdb = await require('./db').testDb();
    const store = createStore(testdb.db, { now: opts.now });
    const log = { log: () => {}, warn: (...a) => captured.push(a.map(String).join(' ')), error: (...a) => captured.push(a.map(String).join(' ')), info: () => {} };
    const { app, ctx } = await createApp({ config, store, log, fetchImpl: typeof opts.fetchImpl === 'function' ? opts.fetchImpl : undefined });
    const server = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    config.baseUrl = base;
    ctx.config.baseUrl = base;
    const sockets = new Set();
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

    const signIn = (user) => `ov_token=${network.userToken(user)}`;

    async function get(p, o = {}) {
        const headers = { ...(o.headers || {}) };
        if (o.as) headers.cookie = [signIn(o.as), headers.cookie].filter(Boolean).join('; ');
        if (o.cookie) headers.cookie = o.cookie;
        if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
        if (o.basic) headers.authorization = `Basic ${Buffer.from(o.basic).toString('base64')}`;
        let body = o.body;
        if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
        if (o.form) { body = new URLSearchParams({ ...o.form }).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
        const method = o.method || (body ? 'POST' : 'GET');
        if (o.as && method !== 'GET' && method !== 'HEAD' && !headers.origin) headers.origin = config.baseUrl;
        const res = await fetch(base + p, { method, headers, body, redirect: 'manual' });
        const buf = Buffer.from(await res.arrayBuffer());
        const text = buf.toString('utf8');
        return { status: res.status, headers: res.headers, text, buffer: buf, json() { return JSON.parse(text); } };
    }

    /** git with the site's own base URL; async, so the in-process server keeps answering. */
    function git(args, cwd, { urlToken } = {}) {
        const { execFile } = require('node:child_process');
        const env2 = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', HOME: cwd || DATA };
        return new Promise((resolve, reject) => {
            execFile('git', args, { cwd: cwd || DATA, env: env2, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) { err.stderr = stderr; reject(err); return; }
                resolve(stdout);
            });
        });
    }
    const cloneUrl = (owner, name, token) => `http://${token ? `x-access-token:${token}@` : ''}127.0.0.1:${port}/${owner}/${name}.git`;

    return {
        base, port, config, store, ctx, network, logs: () => captured.slice(), get, signIn, git, cloneUrl,
        asUser: (username, extra = {}) => ({ subject: require('./mocks').newSubject(), username, ...extra }),
        close: async () => {
            for (const s of sockets) s.destroy();
            await new Promise((resolve) => server.close(resolve));
            await ctx.git.catFiles.close();
            await store.close();
            await network.close();
            fs.rmSync(DATA, { recursive: true, force: true });
        },
    };
}

module.exports = { boot, DATA };
