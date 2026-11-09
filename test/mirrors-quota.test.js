'use strict';
const assert = require('assert');
const { boot } = require('./helpers/boot');
const { createOfficialMirrors } = require('../server/official');
const { contractRepositories } = require('../server/contracts');
const { createMirrors } = require('../server/mirror');
const { createRepos } = require('../server/repos');

// The quota-free path, with no live GitHub: a 403 listing falls back to the contracts, a private or missing
// repository is skipped through ls-refs, a refused metadata call still clones and marks the card pending, and the
// poll reads refs before it fetches and never asks REST. The git binary and fetch are both stubbed.
const pkt = (text) => (Buffer.byteLength(text) + 4).toString(16).padStart(4, '0') + text;
const publicRefs = (branch = 'main') => ({
    ok: true, status: 200, headers: { get: () => null }, json: async () => ({}),
    text: async () => pkt(`${'b'.repeat(40)} HEAD symref-target:refs/heads/${branch}\n`) + '0000',
});
const status = (code) => ({ ok: false, status: code, headers: { get: () => null }, json: async () => ({}), text: async () => '' });
const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => '' });
const lookup = (host, options, callback) => callback(null, [{ address: '140.82.112.3', family: 4 }]);

const CONTRACTS = [
    { full_name: 'OpenVibers/OpenVibe.Live', name: 'OpenVibe.Live', clone_url: 'https://github.com/OpenVibers/OpenVibe.Live.git' },
    { full_name: 'OpenVibers/OpenVibe.Private', name: 'OpenVibe.Private', clone_url: 'https://github.com/OpenVibers/OpenVibe.Private.git' },
    { full_name: 'OpenVibers/OpenVibe.Gone', name: 'OpenVibe.Gone', clone_url: 'https://github.com/OpenVibers/OpenVibe.Gone.git' },
    { full_name: 'OpenVibers/.github', name: '.github', clone_url: 'https://github.com/OpenVibers/.github.git' },
];

(async () => {
    // The contracts themselves name the mirror list, deduplicated and with the OpenVibers fallback for a null
    // repository. Read from the installed openvibe-contracts package, no network.
    const fromContracts = contractRepositories();
    assert.ok(fromContracts.length >= 60, `contracts list has ${fromContracts.length} repositories`);
    assert.ok(fromContracts.every((r) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.full_name)));
    const keys = new Set(fromContracts.map((r) => r.full_name.toLowerCase()));
    assert.equal(keys.size, fromContracts.length, 'deduplicated');
    assert.ok(fromContracts.some((r) => r.full_name === 'OpenVibers/AFResume'), 'a null repository uses OpenVibers/<name>');

    // ── A refused listing falls back to the contracts; private and missing names are skipped, not failed. ──
    {
        const calls = [];
        const fetchImpl = async (url) => {
            const target = new URL(url);
            calls.push(target.toString());
            if (target.hostname === 'api.github.com' && target.pathname.startsWith('/orgs/')) return status(403);
            if (target.hostname === 'github.com') {
                if (target.pathname.includes('/OpenVibe.Live.')) return publicRefs('trunk');
                if (target.pathname.includes('/OpenVibe.Private.')) return status(401);
                if (target.pathname.includes('/OpenVibe.Gone.')) return status(404);
            }
            if (target.hostname === 'api.github.com' && target.pathname.startsWith('/repos/')) return status(403);
            throw new Error(`unexpected request ${url}`);
        };
        const t = await boot({ env: { GIT_DRILL: '' }, fetchImpl, lookup });
        const clones = [];
        t.ctx.git.cloneMirror = async (owner, name) => { clones.push(`${owner}/${name}`); return true; };
        t.ctx.git.languages = async () => ({});
        const repos = createRepos({ store: t.store, config: t.config, git: t.ctx.git, github: t.ctx.github, insights: t.ctx.insights, log: { warn() {} } });
        const job = createOfficialMirrors({
            store: t.store, repos, config: t.config, github: t.ctx.github,
            log: { log() {}, warn() {}, error() {} }, contractList: () => CONTRACTS,
        });
        try {
            t.config.official.org = 'OpenVibers';
            const summary = await job.run();
            assert.equal(summary.source, 'contracts');
            assert.equal(summary.listed, CONTRACTS.length);
            assert.equal(summary.created, 1);
            assert.equal(summary.skipped.private, 1);
            assert.equal(summary.skipped.missing, 1);
            assert.equal(summary.skipped.invalid, 1);
            assert.equal(summary.failed, 0);
            assert.deepEqual(clones, ['openvibers/openvibe.live']);

            // The metadata call was refused: the clone still happened, and the card is pending with the branch
            // ls-refs named.
            const row = await t.ctx.repos.getRow('openvibers', 'openvibe.live');
            assert.equal(row.mirror_state, 'ready');
            assert.equal(row.mirror_meta_state, 'pending');
            assert.equal(row.default_branch, 'trunk');
            assert.equal(row.mirror_url, 'https://github.com/OpenVibers/OpenVibe.Live.git');

            // A later run with REST answering fills the card and clears pending.
            const rest = async (url) => {
                const target = new URL(url);
                if (target.hostname === 'github.com') return publicRefs('trunk');
                if (target.pathname === '/repos/OpenVibers/OpenVibe.Live') {
                    return ok({ full_name: 'OpenVibers/OpenVibe.Live', description: 'Live', default_branch: 'trunk', topics: ['live', 'video'], private: false });
                }
                if (target.pathname.startsWith('/orgs/')) {
                    return ok([{ name: 'OpenVibe.Live', full_name: 'OpenVibers/OpenVibe.Live', private: false, fork: false, archived: false, description: 'Live', default_branch: 'trunk', topics: ['live', 'video'] }]);
                }
                throw new Error(`unexpected request ${url}`);
            };
            const later = await boot({ env: { GIT_DRILL: '' }, fetchImpl: rest, lookup });
            try {
                await later.store.execute(
                    `INSERT INTO git_repos (id, owner_username, name, description, visibility, topics, official, github_full_name,
                        mirror_url, mirror_state, mirror_meta_state)
                     VALUES ('repo_later', 'openvibers', 'openvibe.live', '', 'public', '[]', true, 'OpenVibers/OpenVibe.Live',
                        'https://github.com/OpenVibers/OpenVibe.Live.git', 'ready', 'pending')`,
                );
                later.ctx.git.cloneMirror = async () => true;
                later.ctx.git.languages = async () => ({});
                const job2 = createOfficialMirrors({
                    store: later.store, repos: later.ctx.repos, config: later.config, github: later.ctx.github,
                    log: { log() {}, warn() {}, error() {} }, contractList: () => [CONTRACTS[0]],
                });
                later.config.official.org = 'OpenVibers';
                const again = await job2.run();
                assert.equal(again.existing, 1);
                const filled = await later.ctx.repos.getRow('openvibers', 'openvibe.live');
                assert.equal(filled.mirror_meta_state, 'ready');
                assert.equal(filled.description, 'Live');
                assert.deepEqual(typeof filled.topics === 'string' ? JSON.parse(filled.topics) : filled.topics, ['live', 'video']);
            } finally { await later.close(); }
        } finally { await t.close(); }
    }

    // ── At most a few clones at once. ──
    {
        const many = Array.from({ length: 6 }, (_, i) => ({
            full_name: `OpenVibers/OpenVibe.Many${i}`, name: `OpenVibe.Many${i}`, clone_url: `https://github.com/OpenVibers/OpenVibe.Many${i}.git`,
        }));
        const fetchImpl = async (url) => {
            const target = new URL(url);
            if (target.hostname === 'github.com') return publicRefs('main');
            if (target.pathname.startsWith('/orgs/')) return status(403);
            if (target.pathname.startsWith('/repos/')) return status(403);
            throw new Error(`unexpected request ${url}`);
        };
        const t = await boot({ env: { GIT_DRILL: '' }, fetchImpl, lookup });
        t.config.official.concurrency = 2;
        let active = 0;
        let peak = 0;
        t.ctx.git.cloneMirror = async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 15));
            active -= 1;
            return true;
        };
        t.ctx.git.languages = async () => ({});
        const job = createOfficialMirrors({
            store: t.store, repos: t.ctx.repos, config: t.config, github: t.ctx.github,
            log: { log() {}, warn() {}, error() {} }, contractList: () => many,
        });
        try {
            t.config.official.org = 'OpenVibers';
            const summary = await job.run();
            assert.equal(summary.created, 6);
            assert.ok(peak <= 2, `at most two clones at once (peak ${peak})`);
        } finally { await t.close(); }
    }

    // ── The poll reads refs first: nothing changed means no fetch, and REST is never called. ──
    {
        const restCalls = [];
        const t = await boot({ fetchImpl: async (url) => { restCalls.push(String(url)); throw new Error('REST is not allowed in the poll'); }, lookup });
        try {
            await t.ctx.repos.create({ actor: t.asUser('sam'), name: 'polled', starter: 'empty' });
            await t.store.execute("UPDATE git_repos SET mirror_url = 'https://github.com/OpenVibers/OpenVibe.Live.git' WHERE name = 'polled'");
            let changed = 0;
            let fetched = 0;
            t.ctx.git.mirrorChanged = async () => { changed += 1; return false; };
            t.ctx.git.fetchMirror = async () => { fetched += 1; return true; };
            t.ctx.git.languages = async () => ({});
            const mirrors = createMirrors({ store: t.store, repos: t.ctx.repos, config: t.config, git: t.ctx.git, github: t.ctx.github, log: { warn() {} } });

            await mirrors.poll();
            assert.equal(changed, 1);
            assert.equal(fetched, 0, 'an unchanged mirror is not fetched');
            const after = await t.ctx.repos.getRow('sam', 'polled');
            assert.equal(after.mirror_state, 'ready');
            assert.ok(after.mirror_last_synced_at);
            assert.equal(restCalls.length, 0, 'the poll spent no REST call');

            t.ctx.git.mirrorChanged = async () => true;
            await mirrors.poll();
            assert.equal(fetched, 1, 'a changed mirror is fetched');
            assert.equal(restCalls.length, 0);
        } finally { await t.close(); }
    }

    console.log('mirrors-quota: 27 checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
