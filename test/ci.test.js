'use strict';
/**
 * Forge CI: a branch push by a repository's own writer queues a run; a non-member, a fork and a pull request do
 * not. One run per repository, the newer push supersedes the older. The runner claims, writes a log, reports a
 * verdict and that verdict is the commit status. A run left running past its limit is reaped and reported red.
 */
const assert = require('assert');
const { boot } = require('./helpers/boot');
const { parsePushCommands } = require('../server/git/http-backend');

const TOKEN = 'test-forge-runner-token-0123456789';
const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

(async () => {
    const calls = [];
    const posted = [];
    let statusDeniedFor = null;
    const realFetch = globalThis.fetch;
    const fetchImpl = async (url, init) => {
        const u = String(url);
        if (!u.startsWith('https://api.github.com/')) return realFetch(url, init);
        if (u.includes('/statuses/')) {
            if (statusDeniedFor && u.toLowerCase().includes(`/repos/${statusDeniedFor.toLowerCase()}/`)) {
                return { ok: false, status: 403, json: async () => ({ message: 'Resource not accessible by personal access token' }) };
            }
            const body = JSON.parse(init.body);
            posted.push({ url: u, ...body });
            return ok({ id: posted.length, state: body.state, context: body.context }, 201);
        }
        if (u.includes('/collaborators/')) {
            const login = decodeURIComponent(u.split('/collaborators/')[1].split('/')[0]);
            calls.push(login);
            return login.toLowerCase() === 'mallory' ? { ok: false, status: 404, json: async () => ({}) } : ok({ permission: 'write' });
        }
        throw new Error(`unexpected GitHub call: ${u}`);
    };
    const t = await boot({ fetchImpl, env: { GIT_CI_RUNNER_TOKEN: TOKEN } });
    try {
        const owner = t.asUser('openvibers');
        const make = async (name) => {
            await t.ctx.repos.create({ actor: owner, name, starter: 'static', visibility: 'public' });
            const row = await t.ctx.repos.getRow('openvibers', name);
            const full = `OpenVibers/${name}`;
            await t.store.execute('UPDATE git_repos SET github_full_name = ?, mirror_url = ? WHERE id = ?', [full, `https://github.com/${full}.git`, row.id]);
            const head = await t.ctx.git.resolveCommit('openvibers', name, 'main');
            const fresh = await t.ctx.repos.getRow('openvibers', name);
            await t.ctx.ci.registerRepos([{ full_name: full, install_command: 'npm ci --no-audit --no-fund', test_command: 'npm test', timeout_seconds: 60 }]);
            return { row: fresh, head, full };
        };
        const push = (sha, pusher, full, extra = {}) => ({
            ref: 'refs/heads/main', after: sha, pusher: { name: pusher },
            repository: { full_name: full, fork: false, owner: { login: full.split('/')[0] } },
            ...extra,
        });
        const live = await make('live');

        // The runner registers the repository; a session cannot, and neither can a wrong token.
        assert.equal((await t.get('/api/v1/ci/repos', { json: { repos: [{ full_name: 'openvibers/live' }] } })).status, 401);
        assert.equal((await t.get('/api/v1/ci/repos', { bearer: 'not-the-token', json: { repos: [{ full_name: 'openvibers/live' }] } })).status, 401);
        const reg = await t.get('/api/v1/ci/repos', {
            bearer: TOKEN,
            json: { repos: [{ full_name: 'openvibers/live', install_command: 'npm ci --no-audit --no-fund', test_command: 'npm test', timeout_seconds: 60 }] },
        });
        assert.equal(reg.status, 200, reg.text);
        assert.equal(reg.json().repositories[0].full_name, 'openvibers/live');

        // The owner's account is a member without a GitHub call; the run is queued and the status pends.
        const member = await t.ctx.ci.onGithubPush(live.row, push(live.head, 'OpenVibers', live.full));
        assert.equal(member.run.state, 'queued', JSON.stringify(member));
        assert.equal(calls.length, 0, 'the owning account costs no GitHub call');
        let statuses = await t.get(`/api/v1/repos/openvibers/live/commits/${live.head}/statuses`);
        assert.deepStrictEqual(statuses.json().statuses.map((s) => [s.context, s.state]), [['forge/test', 'pending']]);
        assert.match(statuses.json().statuses[0].target_url, /\/openvibers\/live\/ci\/cir_/);
        assert.deepStrictEqual(posted.map((s) => [s.context, s.state]), [['forge/test', 'pending']], 'the pending status is on GitHub too');
        assert.equal(posted[0].description, 'Queued on the forge runner');
        assert.match(posted[0].target_url, /\/openvibers\/live\/ci\/cir_/);

        // A collaborator with write runs only after GitHub says so; the same answer is cached for ten minutes.
        const friend = await make('friend');
        const friendRun = await t.ctx.ci.onGithubPush(friend.row, push(friend.head, 'Friend', friend.full));
        assert.equal(friendRun.run.state, 'queued');
        assert.deepStrictEqual(calls, ['Friend']);
        assert.equal((await t.ctx.ci.onGithubPush(friend.row, push(friend.head, 'Friend', friend.full))).skipped, 'duplicate');
        assert.deepStrictEqual(calls, ['Friend'], 'the second check is cached');

        // A non-member, a fork, a tag and a pull request never run.
        const stranger = await make('stranger');
        const denied = await t.ctx.ci.onGithubPush(stranger.row, push(stranger.head, 'Mallory', stranger.full));
        assert.equal(denied.skipped, 'not-member');
        const forked = await t.ctx.ci.onGithubPush(stranger.row, push(stranger.head, 'Mallory', stranger.full, { repository: { full_name: stranger.full, fork: true, owner: { login: 'OpenVibers' } } }));
        assert.equal(forked.skipped, 'fork');
        assert.equal((await t.ctx.ci.onGithubPush(stranger.row, push(stranger.head, 'OpenVibers', stranger.full, { ref: 'refs/tags/v1' }))).skipped, 'not-a-branch');
        assert.equal((await t.ctx.ci.onGithubPush(stranger.row, push(stranger.head, 'OpenVibers', 'OpenVibers/SomewhereElse'))).skipped, 'not-this-repository');
        assert.equal((await t.ctx.ci.runsFor(stranger.row)).length, 0);

        // Claim hands out the repository, the clone URL and the commands; a claim is one at a time.
        const claimed = await t.get('/api/v1/ci/runs/claim', { bearer: TOKEN, json: {} });
        assert.equal(claimed.status, 200, claimed.text);
        const job = claimed.json();
        assert.equal(job.repo.full_name, 'openvibers/live');
        assert.match(job.repo.clone_url, /\/openvibers\/live\.git$/);
        assert.equal(job.command.test, 'npm test');
        assert.equal(job.limits.timeout_seconds, 60);
        assert.equal((await t.get(`/api/v1/ci/runs/${job.run.id}/heartbeat`, { bearer: TOKEN })).json().state, 'running');

        // Log chunks reach the run and its page; the verdict becomes the commit status.
        assert.equal((await t.get(`/api/v1/ci/runs/${job.run.id}/log`, { bearer: TOKEN, json: { chunk: 'installing…\n' } })).status, 200);
        assert.equal((await t.get(`/api/v1/ci/runs/${job.run.id}/log`, { bearer: TOKEN, json: { chunk: '47 tests passed\n' } })).status, 200);
        const done = await t.get(`/api/v1/ci/runs/${job.run.id}/status`, { bearer: TOKEN, json: { state: 'success', description: 'Forge runner passed in 9s', exit_code: 0, duration_ms: 9000 } });
        assert.equal(done.status, 200, done.text);
        assert.equal(done.json().run.state, 'success');
        statuses = await t.get(`/api/v1/repos/openvibers/live/commits/${live.head}/statuses`);
        assert.equal(statuses.json().state, 'success');
        const livePosted = posted.filter((s) => s.url.includes(live.head));
        assert.deepStrictEqual(livePosted.map((s) => s.state), ['pending', 'success'], 'the verdict is on GitHub too');
        assert.equal(livePosted[1].context, 'forge/test');
        assert.match(livePosted[1].description, /Forge runner passed in 9s/);
        const page = await t.get(`/openvibers/live/ci/${job.run.id}`);
        assert.match(page.text, /47 tests passed/);
        assert.match(page.text, /Forge runner passed in 9s/);
        const apiRun = await t.get(`/api/v1/repos/openvibers/live/ci/runs/${job.run.id}`);
        assert.equal(apiRun.json().log, 'installing…\n47 tests passed\n');
        assert.equal((await t.get(`/api/v1/ci/runs/${job.run.id}/status`, { bearer: TOKEN, json: { state: 'failure' } })).status, 409, 'a finished run cannot be changed');

        // The collaborator's queued run is drained too, so the next queue is the supersede case alone.
        const friendClaim = (await t.get('/api/v1/ci/runs/claim', { bearer: TOKEN, json: {} })).json();
        assert.equal(friendClaim.run.id, friendRun.run.id);
        assert.equal((await t.get(`/api/v1/ci/runs/${friendClaim.run.id}/status`, { bearer: TOKEN, json: { state: 'success' } })).status, 200);

        // The supersede rule: a newer push cancels the live one, and the runner's heartbeat says so.
        const live2 = await make('live2');
        await t.get('/api/v1/ci/repos', { bearer: TOKEN, json: { repos: [{ full_name: 'openvibers/live2', timeout_seconds: 60 }] } });
        const first = await t.ctx.ci.onGithubPush(live2.row, push(live2.head, 'OpenVibers', live2.full));
        const claimedFirst = (await t.get('/api/v1/ci/runs/claim', { bearer: TOKEN, json: {} })).json();
        assert.equal(claimedFirst.run.id, first.run.id);
        const nextHead = await t.ctx.git.commitFiles('openvibers', 'live2', {
            branch: 'main', base: 'main', message: 'A newer push', files: [{ path: 'new.txt', content: 'new\n' }],
            author: { name: 'OpenVibers', email: 'contact@openvibe.network' },
        });
        const second = await t.ctx.ci.onGithubPush(live2.row, push(nextHead.sha, 'OpenVibers', live2.full));
        assert.equal(second.run.state, 'queued');
        assert.equal(second.run.sha, nextHead.sha);
        assert.equal((await t.get(`/api/v1/ci/runs/${claimedFirst.run.id}/heartbeat`, { bearer: TOKEN })).json().superseded, true);
        assert.equal((await t.get(`/api/v1/ci/runs/${claimedFirst.run.id}/status`, { bearer: TOKEN, json: { state: 'success' } })).status, 409);
        const claimedSecond = (await t.get('/api/v1/ci/runs/claim', { bearer: TOKEN, json: {} })).json();
        assert.equal(claimedSecond.run.id, second.run.id);

        // A runner that disappeared: past its limit, the next sweep times it out and reports it red.
        await t.store.execute("UPDATE git_ci_runs SET started_at = now() - interval '3 minutes' WHERE id = ?", [claimedSecond.run.id]);
        await t.ctx.ci.reap();
        const reaped = await t.ctx.ci.runFor(live2.row, claimedSecond.run.id);
        assert.equal(reaped.state, 'timed_out');
        const reapedStatus = await t.get(`/api/v1/repos/openvibers/live2/commits/${nextHead.sha}/statuses`);
        assert.equal(reapedStatus.json().statuses[0].state, 'failure');
        assert.match(reapedStatus.json().statuses[0].description, /timed out after 1 minutes/);

        // A push that lands on the forge itself: the network's own service token may run it, a person's token
        // may not (the forge knows an OpenVibe account, not the GitHub login the member rule is about).
        const pkt = (line) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, '0')}${line}`;
        const pack = Buffer.from(`${pkt(`0000000000000000000000000000000000000000 ${stranger.head} refs/heads/main\u0000 report-status\n`)}0000PACK`);
        assert.deepStrictEqual(parsePushCommands(pack).map((c) => [c.new, c.ref]), [[stranger.head, 'refs/heads/main']]);
        const forgeRun = await t.ctx.ci.onForgePush(stranger.row, { actor_type: 'service', subject: 'svc:release', scopes: new Set(['git.repo.write']) }, { ref: 'refs/heads/main', sha: stranger.head });
        assert.equal(forgeRun.run.state, 'queued');
        assert.equal((await t.ctx.ci.onForgePush(live.row, { actor_type: 'user', subject: 'usr_x', scopes: new Set(['git.repo.write']) }, { ref: 'refs/heads/main', sha: live.head })).skipped, 'not-a-service');

        // A manual run by the owner starts the head; a stranger cannot start one.
        const manual = await t.get('/api/v1/repos/openvibers/live/ci/runs', { as: owner, json: {} });
        assert.equal(manual.status, 201, manual.text);
        assert.equal(manual.json().run.source, 'manual');
        assert.equal((await t.get('/api/v1/repos/openvibers/live/ci/runs', { as: t.asUser('mallory'), json: {} })).status, 403);
        assert.ok(!t.logs().join('\n').includes(TOKEN), 'the runner token is never logged');

        // A token that cannot write commit statuses: the forge status is still written, the run still queues,
        // and the refusal is logged instead of failing the push.
        statusDeniedFor = 'openvibers/denied';
        const deniedRepo = await make('denied');
        const deniedRun = await t.ctx.ci.onGithubPush(deniedRepo.row, push(deniedRepo.head, 'OpenVibers', deniedRepo.full));
        assert.equal(deniedRun.run.state, 'queued');
        assert.match(t.logs().join('\n'), /GitHub status OpenVibers\/denied .*403/, 'the refusal is logged');
        statusDeniedFor = null;

        console.log('ci: member, non-member, fork, supersede, claim, log, status intake and timeout passed');
    } finally { await t.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
