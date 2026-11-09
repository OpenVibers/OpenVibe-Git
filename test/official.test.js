'use strict';
const assert = require('assert');
const { boot } = require('./helpers/boot');
const { createOfficialMirrors } = require('../server/official');

// A GitHub stand-in: two pages of the organisation's repositories (Link pagination), the metadata repo.create
// reads for a mirror, a fork, an archived repository and a name this service cannot use. Nothing touches the
// network, and the clone itself is stubbed below.
const response = (body, link = null) => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'link' ? link : null) },
    json: async () => body,
});

const LISTING = {
    1: [
        { name: 'OpenVibe.Live', full_name: 'OpenVibers/OpenVibe.Live', fork: false, archived: false, private: false, clone_url: 'https://github.com/OpenVibers/OpenVibe.Live.git' },
        { name: 'OpenVibe.Archived', full_name: 'OpenVibers/OpenVibe.Archived', fork: false, archived: true, private: false, clone_url: 'https://github.com/OpenVibers/OpenVibe.Archived.git' },
    ],
    2: [
        { name: 'OpenVibe.Fork', full_name: 'OpenVibers/OpenVibe.Fork', fork: true, archived: false, private: false, clone_url: 'https://github.com/OpenVibers/OpenVibe.Fork.git' },
        { name: 'OpenVibe.Contracts', full_name: 'OpenVibers/OpenVibe.Contracts', fork: false, archived: false, private: false, clone_url: 'https://github.com/OpenVibers/OpenVibe.Contracts.git' },
        { name: '.github', full_name: 'OpenVibers/.github', fork: false, archived: false, private: false, clone_url: 'https://github.com/OpenVibers/.github.git' },
    ],
};

(async () => {
    let nowMs = Date.now();
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        calls.push({ url: String(url), authorization: opts.headers && opts.headers.authorization });
        const target = new URL(url);
        if (target.pathname === '/orgs/OpenVibers/repos') {
            const page = Number(target.searchParams.get('page') || '1');
            const link = page === 1 ? '<https://api.github.com/orgs/OpenVibers/repos?type=public&per_page=100&page=2>; rel="next"' : null;
            return response(LISTING[page] || [], link);
        }
        // A user account, not an organisation: GitHub answers 404 for /orgs/<name>/repos (OpenVibers is one, 11-09).
        if (target.pathname === '/orgs/Solo/repos') return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ message: 'Not Found' }) };
        if (target.pathname === '/users/Solo/repos') return response([{ name: 'solo-site', full_name: 'Solo/solo-site', fork: false, archived: false, private: false, clone_url: 'https://github.com/Solo/solo-site.git' }], null);
        const meta = /^\/repos\/OpenVibers\/([^/]+)$/.exec(target.pathname);
        if (meta) return response({ full_name: `OpenVibers/${meta[1]}`, description: '', default_branch: 'main', private: false, stargazers_count: 0 });
        throw new Error(`unexpected GitHub request ${url}`);
    };

    const logs = [];
    const log = { log: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) };
    const t = await boot({
        env: { GIT_DRILL: '', GIT_OFFICIAL_ORG: '', GIT_GITHUB_TOKEN: 'test-token' },
        fetchImpl,
        now: () => nowMs,
    });
    const clones = [];
    t.ctx.git.cloneMirror = async (owner, name) => { clones.push(`${owner}/${name}`); return true; };
    t.ctx.git.languages = async () => ({});
    const job = createOfficialMirrors({ store: t.store, repos: t.ctx.repos, config: t.config, github: t.ctx.github, log, clock: { now: () => nowMs } });
    try {
        // Off without GIT_OFFICIAL_ORG, and off in drill mode: no GitHub request either way.
        let result = await job.tick();
        assert.equal(result.ran, false);
        assert.equal(result.reason, 'off');
        assert.equal(calls.length, 0);
        t.config.drill = true;
        result = await job.tick();
        assert.equal(result.reason, 'drill');
        assert.equal(calls.length, 0);
        t.config.drill = false;

        // The first due run: page 1 and page 2, fork and archived skipped, a lower-case mirror per valid name.
        t.config.official.org = 'OpenVibers';
        result = await job.tick();
        assert.equal(result.ran, true);
        assert.equal(result.listed, 5);
        assert.equal(result.created, 2);
        assert.equal(result.existing, 0);
        assert.equal(result.failed, 1);
        assert.deepEqual(clones.sort(), ['openvibers/openvibe.contracts', 'openvibers/openvibe.live']);
        assert.ok(calls.some((c) => c.url.includes('page=2')), 'page 2 was read');
        assert.ok(calls.filter((c) => c.url.includes('/orgs/')).every((c) => c.authorization === 'Bearer test-token'));

        const rows = await t.store.many("SELECT name, official, mirror_url, mirror_state FROM git_repos WHERE owner_username = 'openvibers' ORDER BY name");
        assert.deepEqual(rows.map((r) => r.name), ['openvibe.contracts', 'openvibe.live']);
        assert.ok(rows.every((r) => r.official === true));
        assert.equal(rows[0].mirror_url, 'https://github.com/OpenVibers/OpenVibe.Contracts.git');
        assert.equal(rows[1].mirror_url, 'https://github.com/OpenVibers/OpenVibe.Live.git');
        assert.ok(rows.every((r) => r.mirror_state === 'ready'));
        assert.equal(Number(await t.store.value("SELECT count(*)::int FROM git_repos WHERE name IN ('openvibe.fork', 'openvibe.archived')")), 0);

        const summary = logs.filter((l) => l.includes('official mirrors: created'));
        assert.equal(summary.length, 1);
        assert.match(summary[0], /created 2, existing 0, failed 1/);

        // Not due right away: no second listing and no second clone.
        calls.length = 0;
        result = await job.tick();
        assert.equal(result.ran, false);
        assert.equal(result.reason, 'not due');
        assert.equal(calls.length, 0);

        // Due again: idempotent. The two mirrors exist, so nothing is created and nothing is cloned.
        nowMs += t.config.official.syncMs;
        result = await job.tick();
        assert.equal(result.ran, true);
        assert.equal(result.created, 0);
        assert.equal(result.existing, 2);
        assert.equal(result.failed, 1);
        assert.equal(clones.length, 2);
        assert.equal(Number(await t.store.value("SELECT count(*)::int FROM git_repos WHERE owner_username = 'openvibers'")), 2);
        const state = await job.lastRun();
        assert.ok(state.at);
        assert.equal(state.result.created, 0);

        // A long run is background work: /api/ready answers while the listing is still in flight.
        nowMs += t.config.official.syncMs;
        let release;
        const realOrgRepos = t.ctx.github.orgRepos;
        t.ctx.github.orgRepos = () => new Promise((resolve) => { release = resolve; });
        const pending = job.tick();
        for (let i = 0; i < 200 && !release; i += 1) await new Promise((r) => setTimeout(r, 5));
        assert.ok(release, 'the run reached the listing');
        const ready = await t.get('/api/ready');
        assert.equal(ready.status, 200);
        assert.equal(ready.json().ok, true);
        release([]);
        assert.equal((await pending).ran, true);
        t.ctx.github.orgRepos = realOrgRepos;

        // A user account's repositories: the org listing 404s, the user listing answers.
        const solo = await t.ctx.github.orgRepos('Solo');
        assert.deepEqual(solo.map((r) => r.full_name), ['Solo/solo-site']);
        assert.ok(calls.some((c) => c.url.includes('/users/Solo/repos?type=owner')), 'falls back to /users/<name>/repos');

        console.log('official: 32 checks passed');
    } finally { await t.close(); }
})().catch((err) => { console.error(err); process.exit(1); });
