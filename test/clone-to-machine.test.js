'use strict';
const assert = require('assert');
const { boot } = require('./helpers/boot');

(async () => {
    let nowMs = Date.now();
    const t = await boot({ now: () => nowMs });
    try {
        const sam = t.asUser('sam');
        const other = t.asUser('other');
        const demo = await t.ctx.repos.create({ actor: sam, name: 'demo', description: 'A demo.', starter: 'empty', visibility: 'public' });
        await t.ctx.repos.create({ actor: other, name: 'secret', description: 'Private.', starter: 'empty', visibility: 'private' });

        // Two of sam's computers, and one of other's.
        const madeMine = await t.get('/api/v1/machines', { as: sam, json: { name: 'sam-laptop' } });
        const mine = madeMine.json().machine;
        const mineURL = madeMine.json().link.url;
        const mineToken = new URL(mineURL).searchParams.get('token');
        let helloURL = new URL(mineURL); helloURL.pathname += '/hello';
        await fetch(helloURL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'sam-laptop', os: 'linux', repos: [] }) });

        const madeSecond = await t.get('/api/v1/machines', { as: sam, json: { name: 'sam-tower' } });
        const second = madeSecond.json().machine;
        const secondToken = new URL(madeSecond.json().link.url).searchParams.get('token');
        const madeTheirs = await t.get('/api/v1/machines', { as: other, json: { name: 'other-laptop' } });
        const theirs = madeTheirs.json().machine;
        // A computer that never checks in stays offline in the panel's list.
        await t.get('/api/v1/machines', { as: sam, json: { name: 'sam-desk' } });

        // ── The request and its refusals ────────────────────
        const anon = await t.get('/api/v1/repos/sam/demo/clone-to-machine', { json: { machine: mine.id } });
        assert.equal(anon.status, 401, 'signed out');
        const privateOne = await t.get('/api/v1/repos/other/secret/clone-to-machine', { as: sam, json: { machine: mine.id } });
        assert.equal(privateOne.status, 404, 'a repository sam may not read is 404, never 403');
        const notMyMachine = await t.get('/api/v1/repos/sam/demo/clone-to-machine', { as: sam, json: { machine: theirs.id } });
        assert.equal(notMyMachine.status, 404, "another person's computer cannot be targeted");
        const noMachine = await t.get('/api/v1/repos/sam/demo/clone-to-machine', { as: sam, json: { machine: 'mch_01JQZ8M4T7Y2N5K3B6V9C1X0DA' } });
        assert.equal(noMachine.status, 404, 'an id that is nobody\'s is 404');
        const theirRepo = await t.get('/api/v1/repos/other/secret/clone-to-machine', { as: other, json: { machine: mine.id } });
        assert.equal(theirRepo.status, 404, 'other cannot address sam\'s machine even for their own repository');

        // An offline computer: 409, nothing queued.
        const offlineMachine = madeSecond.json().machine;
        const offline = await t.get('/api/v1/repos/sam/demo/clone-to-machine', { as: sam, json: { machine: offlineMachine.id } });
        assert.equal(offline.status, 409);
        assert.equal(offline.json().code, 'machine.offline');

        // ── Sent to the computer over its own watch ─────────
        const made = await t.get('/api/v1/repos/sam/demo/clone-to-machine', { as: sam, json: { machine: mine.id } });
        assert.equal(made.status, 201);
        const request = made.json().request;
        assert.match(request.id, /^clr_[0-9A-Z]{26}$/);
        assert.equal(request.state, 'queued');
        assert.equal(request.machine_id, mine.id);
        assert.equal(request.repo, 'sam/demo');
        assert.equal(request.clone_url, undefined, 'the page never sees a clone URL');

        const watchURL = new URL(mineURL); watchURL.pathname += '/watch';
        const watch = await fetch(watchURL);
        assert.equal(watch.status, 200);
        const item = (await watch.json()).request;
        assert.equal(item.kind, 'clone');
        assert.equal(item.clone_id, request.id);
        assert.equal(item.repo, 'sam/demo');
        assert.match(item.url, /^https:\/\/x-access-token:git_/);
        assert.equal(item.requested_by, 'sam');

        // The page sees each step the computer reports; only that computer can report it.
        const progressURL = new URL(mineURL); progressURL.pathname += `/clone-requests/${request.id}`;
        const pageState = async (as) => (await t.get(`/api/v1/repos/sam/demo/clone-to-machine/${request.id}`, { as })).json().request;
        assert.equal((await pageState(sam)).state, 'queued');
        const elsewhere = await t.get(`/api/v1/repos/sam/demo/clone-to-machine/${request.id}`, { as: other });
        assert.equal(elsewhere.status, 404, "another person cannot read sam's request");
        const wrongPath = await t.get(`/api/v1/repos/sam/other-name/clone-to-machine/${request.id}`, { as: sam });
        assert.equal(wrongPath.status, 404);

        const report = (state, extra = {}) => fetch(progressURL, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ state, ...extra }),
        });
        const bareURL = new URL(progressURL); bareURL.searchParams.delete('token');
        assert.equal((await fetch(bareURL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'waiting' }) })).status, 404, 'no token: 404');
        const secondURL = new URL(madeSecond.json().link.url); secondURL.pathname += `/clone-requests/${request.id}`;
        assert.equal((await fetch(secondURL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'waiting' }) })).status, 404, 'another of sam\'s computers has a valid token but is not the one the request went to');
        assert.equal((await pageState(sam)).state, 'queued');
        const theirsURL = new URL(madeTheirs.json().link.url); theirsURL.pathname += `/clone-requests/${request.id}`;
        assert.equal((await fetch(theirsURL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'waiting' }) })).status, 404, "another person's computer cannot move it");

        assert.equal((await report('waiting')).status, 200);
        assert.equal((await pageState(sam)).state, 'waiting');
        assert.equal((await report('approved')).status, 200);
        assert.equal((await pageState(sam)).state, 'approved');
        assert.equal((await report('cloning', { progress: { percent: 42, line: 'Receiving objects: 42%' } })).status, 200);
        const cloning = await pageState(sam);
        assert.equal(cloning.state, 'cloning');
        assert.equal(cloning.progress.percent, 42);
        assert.equal((await report('done', { path: '/home/sam/OpenVibe/demo', progress: { percent: 100, line: 'Cloned into demo' } })).status, 200);
        const done = await pageState(sam);
        assert.equal(done.state, 'done');
        assert.equal(done.path, '/home/sam/OpenVibe/demo');
        assert.equal((await report('failed', { reason: 'late' })).status, 200, 'a terminal request is not moved again');
        assert.equal((await pageState(sam)).state, 'done');

        // ── The panel ───────────────────────────────────────
        const repoPage = await t.get('/sam/demo', { as: sam });
        assert.equal(repoPage.status, 200);
        assert.match(repoPage.text, /Clone to sam-laptop/);
        assert.match(repoPage.text, /action="\/sam\/demo\/clone-to-machine"/);
        assert.match(repoPage.text, /sam-desk is offline since/, 'an offline computer is named, not offered');
        const noMachines = await t.get('/sam/demo', { as: t.asUser('nobody') });
        assert.match(noMachines.text, /No Link computer is online right now/, 'with none online the panel says so…');
        assert.match(noMachines.text, /action="\/sam\/demo\/clone"/, '…and keeps the existing link');
        const withLine = await t.get(`/sam/demo?clone=${request.id}`, { as: sam });
        assert.match(withLine.text, /data-clone-endpoint="\/api\/v1\/repos\/sam\/demo\/clone-to-machine\//);
        assert.match(withLine.text, /Cloned into \/home\/sam\/OpenVibe\/demo/);

        // The plain button goes back to the repository with its progress line.
        const formPost = await t.get('/sam/demo/clone-to-machine', { as: sam, form: { machine: mine.id } });
        assert.equal(formPost.status, 303);
        assert.match(formPost.headers.get('location'), /^\/sam\/demo\?clone=clr_[0-9A-Z]{26}#get$/);
        const progressPage = await t.get(formPost.headers.get('location').split('#')[0], { as: sam });
        assert.equal(progressPage.status, 200);
        assert.match(progressPage.text, /data-clone-request=/);

        // ── Two minutes, then it is over ────────────────────
        const late = await t.get('/api/v1/repos/sam/demo/clone-to-machine', { as: sam, json: { machine: mine.id } });
        const lateRequest = late.json().request;
        nowMs += 3 * 60_000;
        const expiredPage = await t.get(`/api/v1/repos/sam/demo/clone-to-machine/${lateRequest.id}`, { as: sam });
        assert.equal(expiredPage.json().request.state, 'expired');
        const lateURL = new URL(mineURL); lateURL.pathname += `/clone-requests/${lateRequest.id}`;
        const lateReport = await fetch(lateURL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'waiting' }) });
        assert.equal(lateReport.status, 200);
        assert.equal((await lateReport.json()).request.state, 'expired', 'an expired request is refused');
        // …and the computer is not online any more after a gap that long.
        const stale = await t.get('/api/v1/repos/sam/demo/clone-to-machine', { as: sam, json: { machine: mine.id } });
        assert.equal(stale.status, 409);
        assert.equal(stale.json().code, 'machine.offline');

        process.stdout.write('clone-to-machine: ok\n');
    } finally {
        await t.close();
    }
})().catch((err) => { process.stderr.write(`${err && err.stack || err}\n`); process.exit(1); });
