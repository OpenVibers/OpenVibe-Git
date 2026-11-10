'use strict';
/**
 * Checks intake from GitHub, read-only: for a mirrored repository it copies the check-runs of the open
 * pull-request heads and the default branch into statuses. At most every two minutes per repository, and
 * check-runs are asked only for heads that moved. GitHub is a canned fetch; nothing leaves the process.
 */
const assert = require('assert');
const { boot } = require('./helpers/boot');
const { mapRun } = require('../server/checks-intake');

const ok = (body, link = null) => ({
    ok: true, status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'link' ? link : null) },
    json: async () => body,
});

(async () => {
    const calls = [];
    let prHead;
    const runsBySha = {};
    const fetchImpl = async (url) => {
        calls.push(String(url));
        if (String(url).includes('/pulls')) return ok([{ number: 7, head: { sha: prHead } }]);
        const m = /\/commits\/([0-9a-f]{40})\/check-runs/.exec(String(url));
        if (m) return ok({ check_runs: runsBySha[m[1]] || [] });
        throw new Error(`unexpected GitHub call: ${url}`);
    };
    const t = await boot({ fetchImpl, env: { GIT_GITHUB_TOKEN: 'secret-mirror-token' } });
    try {
        assert.equal(t.ctx.checksIntake.start(), false, 'off in drill mode');

        const sam = t.asUser('sam');
        await t.ctx.repos.create({ actor: sam, name: 'live', starter: 'static', visibility: 'public' });
        const mainSha = await t.ctx.git.resolveCommit('sam', 'live', 'main');
        const pr = await t.ctx.git.commitFiles('sam', 'live', {
            branch: 'pr-branch', base: 'main', message: 'The PR head', files: [{ path: 'pr.txt', content: 'pr\n' }],
            author: { name: 'Sam', email: 'sam@example.com' },
        });
        prHead = pr.sha;
        runsBySha[mainSha] = [
            { name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://github.com/OpenVibers/OpenVibe.Live/runs/1', output: { title: 'All green' } },
            { name: 'security', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/OpenVibers/OpenVibe.Live/runs/2', output: { title: 'Leak found' } },
        ];
        runsBySha[pr.sha] = [{ name: 'test', status: 'in_progress', conclusion: null, html_url: 'https://github.com/OpenVibers/OpenVibe.Live/runs/3' }];
        await t.store.execute("UPDATE git_repos SET mirror_url = 'https://github.com/OpenVibers/OpenVibe.Live.git', github_full_name = 'OpenVibers/OpenVibe.Live' WHERE owner_username = 'sam' AND name = 'live'");
        const row = await t.ctx.repos.getRow('sam', 'live');

        const first = await t.ctx.checksIntake.syncRepo(row, { force: true });
        assert.equal(first.ok, true, JSON.stringify(first));
        assert.equal(first.heads, 2);
        assert.equal(first.fetched, 2);
        assert.equal(first.copied, 3);
        assert.equal(calls.filter((u) => u.includes('/pulls')).length, 1, 'one PR listing');
        assert.equal(calls.filter((u) => u.includes('/check-runs')).length, 2);

        const main = await t.get(`/api/v1/repos/sam/live/commits/${mainSha}/statuses`);
        assert.deepStrictEqual(main.json().statuses.map((s) => [s.context, s.state]), [['security', 'failure'], ['test', 'success']]);
        assert.equal(main.json().state, 'failure');
        assert.equal(main.json().statuses[0].target_url, 'https://github.com/OpenVibers/OpenVibe.Live/runs/2');
        const prStatuses = await t.get(`/api/v1/repos/sam/live/commits/${pr.sha}/statuses`);
        assert.deepStrictEqual(prStatuses.json().statuses.map((s) => [s.context, s.state]), [['test', 'pending']]);

        // A second run inside two minutes does nothing; a forced run with unmoved heads asks no check-runs.
        assert.equal((await t.ctx.checksIntake.syncRepo(await t.ctx.repos.getRow('sam', 'live'))).skipped, 'recent');
        const before = calls.length;
        const forced = await t.ctx.checksIntake.syncRepo(await t.ctx.repos.getRow('sam', 'live'), { force: true });
        assert.equal(forced.fetched, 0, 'unmoved heads cost no check-runs call');
        assert.equal(forced.copied, 0);
        assert.equal(calls.length - before, 1, 'only the PR listing re-ran');

        // A moved head is fetched again; an unchanged one is not.
        const pr2 = await t.ctx.git.commitFiles('sam', 'live', {
            branch: 'pr-branch', base: 'pr-branch', message: 'The PR moves', files: [{ path: 'pr.txt', content: 'pr2\n' }],
            author: { name: 'Sam', email: 'sam@example.com' },
        });
        prHead = pr2.sha;
        runsBySha[pr2.sha] = [{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/runs/4' }];
        const moved = await t.ctx.checksIntake.syncRepo(await t.ctx.repos.getRow('sam', 'live'), { force: true });
        assert.equal(moved.fetched, 1);
        assert.equal(moved.copied, 1);
        assert.deepStrictEqual((await t.get(`/api/v1/repos/sam/live/commits/${pr2.sha}/statuses`)).json().statuses.map((s) => s.state), ['success']);

        // A repository that is no mirror is left alone, and the token never reaches a log.
        await t.ctx.repos.create({ actor: sam, name: 'plain', starter: 'static', visibility: 'public' });
        assert.equal((await t.ctx.checksIntake.syncRepo(await t.ctx.repos.getRow('sam', 'plain'), { force: true })).skipped, 'not-mirrored');
        assert.ok(!t.logs().join('\n').includes('secret-mirror-token'), 'the mirror token is never logged');

        // The check-run mapping: queued work pends, neutral passes, a cancelled run errors.
        assert.equal(mapRun({ name: 't', status: 'queued' }).state, 'pending');
        assert.equal(mapRun({ name: 't', status: 'completed', conclusion: 'neutral' }).state, 'success');
        assert.equal(mapRun({ name: 't', status: 'completed', conclusion: 'cancelled' }).state, 'error');
        assert.equal(mapRun({ name: 't', status: 'completed', conclusion: 'timed_out' }).state, 'error');
        assert.equal(mapRun({ name: '' }), null);
        assert.equal(mapRun(null), null);

        console.log('checks-intake: copy, throttle, moved-heads-only, mapping and token silence passed');
    } finally { await t.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
