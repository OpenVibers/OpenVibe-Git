'use strict';
const assert = require('assert');
const { boot } = require('./helpers/boot');

(async () => {
    let nowMs = Date.now();
    const t = await boot({ now: () => nowMs });
    try {
        const sam = t.asUser('sam');
        const demo = await t.ctx.repos.create({ actor: sam, name: 'demo', description: 'A demo.', starter: 'empty', visibility: 'public' });
        const other = t.asUser('other');
        const secret = await t.ctx.repos.create({ actor: other, name: 'secret', description: 'Private.', starter: 'empty', visibility: 'private' });

        // ── Clone to my computer ────────────────────────────
        const made = await t.get('/api/v1/clone-requests', { as: sam, json: { repo: 'sam/demo' } });
        assert.equal(made.status, 201);
        const request = made.json().request;
        const link = made.json().link;
        assert.match(request.id, /^clr_[0-9A-Z]{26}$/);
        assert.equal(request.state, 'pending');
        assert.ok(Date.parse(request.expires_at) - Date.parse(request.created_at) === 120000);
        assert.match(link.command, /openvibe-link clone '/);

        // Signed out: refused.
        const anon = await t.get('/api/v1/clone-requests', { json: { repo: 'sam/demo' } });
        assert.equal(anon.status, 401);
        // A private repository somebody else owns: 404, its existence is not shown.
        const denied = await t.get('/api/v1/clone-requests', { as: sam, json: { repo: 'other/secret' } });
        assert.equal(denied.status, 404);

        // The page's copy has no clone URL; the Link's has one.
        const pageCopy = await t.get(`/api/v1/clone-requests/${request.id}`, { as: sam });
        assert.equal(pageCopy.status, 200);
        assert.equal(pageCopy.json().request.clone_url, undefined);
        const token = new URL(link.url).searchParams.get('token');
        const linkURL = link.url;
        const linkCopy = await t.get(linkURL.replace(t.base, ''));
        assert.equal(linkCopy.status, 200);
        assert.match(linkCopy.json().clone_url, /^https:\/\/x-access-token:git_/);

        // Link answers, reports progress and finishes; the page sees each one.
        const approved = await fetch(linkURL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'approved' }) });
        assert.equal(approved.status, 200);
        const progress = await fetch(linkURL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'cloning', progress: { percent: 42, line: 'Receiving objects: 42%' } }) });
        assert.equal(progress.status, 200);
        const done = await fetch(linkURL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'done', path: '/home/sam/OpenVibe/demo' }) });
        assert.equal(done.status, 200);
        const final = await t.get(`/api/v1/clone-requests/${request.id}`, { as: sam });
        assert.equal(final.json().request.state, 'done');
        assert.equal(final.json().request.path, '/home/sam/OpenVibe/demo');
        const after = await fetch(linkURL);
        assert.equal(after.status, 200);
        const afterBody = await after.json();
        assert.equal(afterBody.clone_url, undefined, 'the read token is not given back after the clone');
        assert.equal(afterBody.state, 'done');

        // A token that is not the request's is refused without saying which part was wrong.
        const wrong = await fetch(linkURL.replace(token, 'x'.repeat(43)));
        assert.equal(wrong.status, 404);

        // ── Two minutes, then the request is over ───────────
        const made2 = await t.get('/api/v1/clone-requests', { as: sam, json: { repo: 'sam/demo' } });
        const link2 = made2.json().link;
        nowMs += 3 * 60_000;
        const expired = await t.get(`/api/v1/clone-requests/${made2.json().request.id}`, { as: sam });
        assert.equal(expired.json().request.state, 'expired');
        const expiredLink = await fetch(link2.url);
        const expiredBody = await expiredLink.json();
        assert.equal(expiredBody.state, 'expired');
        assert.equal(expiredBody.clone_url, undefined);

        // ── A published machine, read-only ──────────────────
        nowMs = Date.now();
        const madeMachine = await t.get('/api/v1/machines', { as: sam, json: { name: 'sam-laptop' } });
        assert.equal(madeMachine.status, 201);
        const machine = madeMachine.json().machine;
        const machineURL = madeMachine.json().link.url;
        const machineToken = new URL(machineURL).searchParams.get('token');
        const helloURL = new URL(machineURL); helloURL.pathname += '/hello';
        const hello = await fetch(helloURL, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'sam-laptop', os: 'linux', repos: [{ name: 'demo', branch: 'main', head: 'a'.repeat(40), head_subject: 'First', updated_at: new Date(nowMs).toISOString() }] }),
        });
        assert.equal(hello.status, 200);
        const listed = await t.get('/api/v1/machines', { as: sam });
        const mine = listed.json().machines.find((m) => m.id === machine.id);
        assert.equal(mine.online, true);
        assert.equal(mine.repos[0].name, 'demo');

        // Git asks over the watch the machine opened; the machine answers; the page gets the tree.
        const pending = t.ctx.relay.browse({ machineId: machine.id, kind: 'tree', repo: 'demo', ref: 'main', path: '' });
        const watch = await t.ctx.relay.machineWatch({ id: machine.id, token: machineToken });
        assert.equal(watch.request.kind, 'tree');
        await t.ctx.relay.machineResult({
            id: machine.id, token: machineToken,
            body: { request_id: watch.request.id, ok: true, result: { ref: 'main', path: '', entries: [{ name: 'README.md', path: 'README.md', type: 'blob', size: 6 }] } },
        });
        const answer = await pending;
        assert.equal(answer.state, 'ok');
        assert.equal(answer.result.entries[0].name, 'README.md');

        // The page browses it while the machine answers on the poll.
        const page = t.get(`/machines/${machine.id}/demo`, { as: sam });
        const answered = (async () => {
            await new Promise((r) => setTimeout(r, 50));
            const w = await t.ctx.relay.machineWatch({ id: machine.id, token: machineToken });
            await t.ctx.relay.machineResult({
                id: machine.id, token: machineToken,
                body: { request_id: w.request.id, ok: true, result: { ref: 'main', path: '', entries: [{ name: 'src', path: 'src', type: 'tree' }] } },
            });
        })();
        const rendered = await page;
        await answered;
        assert.equal(rendered.status, 200);
        assert.match(rendered.text, /read-only through Link/);
        assert.match(rendered.text, /src/);

        // Offline: the page says since when, and never tries to write.
        nowMs += 60_000;
        const offline = await t.get(`/machines/${machine.id}/demo`, { as: sam });
        assert.equal(offline.status, 200);
        assert.match(offline.text, /offline since/);
        const offList = await t.get('/api/v1/machines', { as: sam });
        assert.equal(offList.json().machines.find((m) => m.id === machine.id).online, false);

        // Somebody else's machine is not listed and not browsable.
        const otherView = await t.get('/api/v1/machines', { as: other });
        assert.equal(otherView.json().machines.some((m) => m.id === machine.id), false);
        const notMine = await t.get(`/machines/${machine.id}/demo`, { as: other });
        assert.equal(notMine.status, 404);

        // The page's "Clone to my computer" button is a plain POST and lands on the progress line.
        const pageForm = await t.get('/sam/demo', { as: sam });
        assert.match(pageForm.text, /Clone to my computer/);
        assert.match(pageForm.text, /action="\/sam\/demo\/clone"/);

        process.stdout.write('link-relay: ok\n');
    } finally {
        await t.close();
    }
})().catch((err) => { process.stderr.write(`${err && err.stack || err}\n`); process.exit(1); });
