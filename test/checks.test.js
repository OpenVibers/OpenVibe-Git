'use strict';
/**
 * Commit statuses: a checks service reports {context, state, description, target_url} per commit; reads
 * take the latest per context. A change shows them and is mergeable only when its required contexts are
 * green; an empty required list changes nothing.
 */
const assert = require('assert');
const { boot } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const sam = t.asUser('sam'), pat = t.asUser('pat');
        await t.ctx.repos.create({ actor: sam, name: 'ci', starter: 'static', visibility: 'public' });
        const head = await t.ctx.git.commitFiles('sam', 'ci', {
            branch: 'agent/feat', base: 'main', message: 'A feature', files: [{ path: 'feat.txt', content: 'yes\n' }],
            author: { name: 'Sam', email: 'sam@example.com' },
        });
        const root = '/api/v1/repos/sam/ci';
        const runSvc = t.network.gitToken({ subject: 'svc:run', caps: ['git.checks.write'], type: null });
        const readOnly = t.network.gitToken({ subject: 'svc:run', caps: ['git.repo.read'], type: null });
        const post = (body, bearer = runSvc) => t.get(`${root}/commits/${head.sha}/statuses`, { bearer, json: body });

        // Who may report: a checks service, or the owner with the capability. Nobody else.
        assert.equal((await t.get(`${root}/commits/${head.sha}/statuses`, { json: { context: 'test', state: 'success' } })).status, 401);
        assert.equal((await post({ context: 'test', state: 'success' }, readOnly)).status, 403);
        assert.equal((await post({ context: 'test', state: 'success' }, readOnly)).json().code, 'token.scope');
        assert.equal((await t.get(`${root}/commits/${head.sha}/statuses`, { as: sam, json: { context: 'test', state: 'success' } })).status, 403);
        assert.equal((await post({ context: 'test', state: 'nope' })).status, 422);
        assert.equal((await t.get(`${root}/commits/notasha/statuses`, { bearer: runSvc, json: { context: 'test', state: 'success' } })).status, 422);
        assert.equal((await post({ context: 'test', state: 'success', target_url: 'gopher://x' })).status, 422);
        assert.equal((await post({ context: '', state: 'success' })).status, 422);

        const first = await post({ context: 'test', state: 'pending', description: 'Running', target_url: 'https://ci.example/runs/1' });
        assert.equal(first.status, 201, first.text);
        assert.equal(first.json().context, 'test');
        assert.equal(first.json().state, 'pending');
        await post({ context: 'security', state: 'success' });
        await post({ context: 'test', state: 'success', description: 'Green', target_url: 'https://ci.example/runs/1' });

        // Reads take the latest per context, with the combined state. Public commits read anonymously.
        const listed = await t.get(`${root}/commits/${head.sha}/statuses`);
        assert.equal(listed.status, 200);
        assert.deepStrictEqual(listed.json().statuses.map((s) => [s.context, s.state]), [['security', 'success'], ['test', 'success']]);
        assert.equal(listed.json().statuses.find((s) => s.context === 'test').description, 'Green');
        assert.equal(listed.json().state, 'success');
        assert.equal((await t.get(`${root}/commits/${head.sha}/statuses`)).status, 200);

        // Required contexts: empty by default, the owner sets them, nobody else.
        assert.deepStrictEqual((await t.get(`${root}/required-checks`)).json().required_checks, []);
        assert.equal((await t.get(`${root}/required-checks`, { as: pat, json: { contexts: ['test'] } })).status, 403);
        assert.equal((await t.get(`${root}/required-checks`, { as: sam, json: { contexts: ['x'.repeat(300)] } })).status, 422);
        const required = await t.get(`${root}/required-checks`, { as: sam, json: { contexts: ['test', 'security'] } });
        assert.equal(required.status, 200, required.text);
        assert.deepStrictEqual(required.json().required_checks, ['test', 'security']);

        // A change shows the checks and is mergeable while its required contexts are green.
        const created = await t.get(`${root}/changes`, { as: sam, json: { title: 'Ship the feature', base_ref: 'main', head_ref: 'agent/feat' } });
        assert.equal(created.status, 201, created.text);
        const detail = await t.get(`${root}/changes/${created.json().number}`);
        assert.equal(detail.json().checks.length, 2);
        assert.equal(detail.json().checks_label, '2 checks passed');
        assert.equal(detail.json().state, 'success');
        assert.equal(detail.json().mergeable, true);
        assert.deepStrictEqual(detail.json().required.map((r) => [r.context, r.ok]), [['test', true], ['security', true]]);
        const page = await t.get(`/sam/ci/changes/${created.json().number}`, { as: sam });
        assert.match(page.text, /2 checks passed/);
        assert.match(page.text, /git-check--success/);
        assert.match(page.text, /ci\.example\/runs\/1/);

        // A red required context blocks the merge, on the API and on the page.
        await post({ context: 'test', state: 'failure', description: 'Broke it' });
        const red = await t.get(`${root}/changes/${created.json().number}`);
        assert.equal(red.json().checks_label, '1 of 2 checks failed');
        assert.equal(red.json().mergeable, false);
        assert.equal((await t.get(`${root}/changes/${created.json().number}/merge`, { as: sam, json: { head_sha: head.sha, method: 'squash' } })).status, 409);
        const redPage = await t.get(`/sam/ci/changes/${created.json().number}`, { as: sam });
        assert.match(redPage.text, /Required checks are not passing/);
        await post({ context: 'test', state: 'success', description: 'Fixed' });
        assert.equal((await t.get(`${root}/changes/${created.json().number}`)).json().mergeable, true);
        assert.equal((await t.get(`${root}/changes/${created.json().number}/merge`, { as: sam, json: { head_sha: head.sha, method: 'squash' } })).status, 200);

        // A missing required context blocks too; clearing the list merges as before.
        const head2 = await t.ctx.git.commitFiles('sam', 'ci', {
            branch: 'agent/more', base: 'main', message: 'More', files: [{ path: 'more.txt', content: 'more\n' }],
            author: { name: 'Sam', email: 'sam@example.com' },
        });
        const created2 = await t.get(`${root}/changes`, { as: sam, json: { title: 'More work', base_ref: 'main', head_ref: 'agent/more' } });
        const missing = await t.get(`${root}/changes/${created2.json().number}`);
        assert.equal(missing.json().checks_label, 'No checks');
        assert.equal(missing.json().mergeable, false, 'required contexts with no report block');
        assert.equal((await t.get(`${root}/changes/${created2.json().number}/merge`, { as: sam, json: { head_sha: head2.sha, method: 'merge' } })).status, 409);
        assert.deepStrictEqual((await t.get(`${root}/required-checks`, { as: sam, json: { contexts: [] } })).json().required_checks, []);
        assert.equal((await t.get(`${root}/changes/${created2.json().number}`)).json().mergeable, true);
        assert.equal((await t.get(`${root}/changes/${created2.json().number}/merge`, { as: sam, json: { head_sha: head2.sha, method: 'merge' } })).status, 200);

        console.log('checks: report auth, latest-per-context, required contexts, mergeable and the merge gate passed');
    } finally { await t.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
