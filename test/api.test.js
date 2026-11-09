'use strict';
const assert = require('assert');
const { boot } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const sam = t.asUser('sam');
        const repo = await t.ctx.repos.create({ actor: sam, name: 'api-demo', description: 'Everything the API says.', starter: 'static', visibility: 'public' });

        const list = await t.get('/api/v1/repos?q=api-demo');
        assert.equal(list.status, 200);
        assert.equal(list.json().repositories[0].full_name, 'sam/api-demo');

        const one = await t.get('/api/v1/repos/sam/api-demo');
        assert.equal(one.status, 200);
        const body = one.json();
        assert.equal(body.name, 'api-demo');
        assert.equal(body.visibility, 'public');
        assert.equal(body.starred, false);
        assert.equal(body.owner.username, 'sam');

        const tree = await t.get('/api/v1/repos/sam/api-demo/tree?ref=main');
        assert.equal(tree.status, 200);
        assert.ok(tree.json().entries.some((e) => e.name === 'index.html'));

        const blob = await t.get('/api/v1/repos/sam/api-demo/blob?ref=main&path=index.html');
        assert.equal(blob.status, 200);
        assert.match(blob.json().text, /Made with OpenVibe\.Git/);

        const raw = await t.get('/api/v1/repos/sam/api-demo/raw?ref=main&path=README.md');
        assert.equal(raw.status, 200);
        assert.match(raw.text, /api-demo/);

        const commits = await t.get('/api/v1/repos/sam/api-demo/commits');
        assert.equal(commits.status, 200);
        assert.ok(commits.json().commits.length >= 1);

        const first = commits.json().commits[0];
        const commit = await t.get(`/api/v1/repos/sam/api-demo/commit/${first.sha}?diff=1`);
        assert.equal(commit.status, 200);
        assert.equal(commit.json().repo, 'sam/api-demo');
        assert.ok(commit.json().stats);

        assert.equal((await t.get('/api/v1/repos/sam/api-demo/branches')).json().branches[0].name, 'main');
        assert.equal((await t.get('/api/v1/repos/sam/api-demo/tags')).status, 200);
        assert.equal((await t.get('/api/v1/repos/sam/api-demo/releases')).status, 200);
        assert.ok((await t.get('/api/v1/repos/sam/api-demo/contributors')).json().contributors.length >= 1);
        const insights = await t.get('/api/v1/repos/sam/api-demo/insights');
        assert.equal(insights.status, 200);
        assert.equal(insights.json().window_days, 30);

        // Star with a session.
        const starred = await t.get('/api/v1/repos/sam/api-demo/star', { as: sam, method: 'PUT' });
        assert.equal(starred.status, 200);
        assert.equal(starred.json().starred, true);
        assert.equal(starred.json().stars, 1);
        assert.equal((await t.get('/api/v1/repos/sam/api-demo', { as: sam })).json().starred, true);
        const unstarred = await t.get('/api/v1/repos/sam/api-demo/star', { as: sam, method: 'DELETE' });
        assert.equal(unstarred.json().stars, 0);

        // A clone token is shown once and stored hashed.
        const minted = await t.get('/api/v1/tokens', { as: sam, json: { scopes: ['git.read'], hours: 1 } });
        assert.equal(minted.status, 201);
        assert.match(minted.json().token, /^git_/);
        assert.match(minted.json().command, /x-access-token:git_/);
        const row = await t.store.maybe('SELECT token_hash, subject, scopes FROM git_tokens WHERE token_hash = ?', [require('../server/auth/git-auth').hashToken(minted.json().token)]);
        assert.ok(!row.token_hash.includes(minted.json().token), 'the raw token is not stored');
        assert.equal(row.subject, sam.subject);

        // A contents write with no clone.
        const write = await t.get('/api/v1/repos/sam/api-demo/commits', {
            as: sam, json: { branch: 'agent/run-1', message: 'Write the title without a clone', files: [{ path: 'notes.txt', content: 'made by the API\n' }] },
        });
        assert.equal(write.status, 201);
        assert.match(write.json().sha, /^[0-9a-f]{40}$/);
        const readBack = await t.get('/api/v1/repos/sam/api-demo/blob?ref=agent/run-1&path=notes.txt');
        assert.equal(readBack.status, 200);
        assert.equal(readBack.json().text, 'made by the API\n');
        const newCommit = await t.get(`/api/v1/repos/sam/api-demo/commit/${write.json().sha}`);
        assert.equal(newCommit.json().subject, 'Write the title without a clone');

        // A private repository answers 404 to everyone else.
        await t.ctx.repos.create({ actor: sam, name: 'secret-notes', starter: 'empty', visibility: 'private' });
        assert.equal((await t.get('/api/v1/repos/sam/secret-notes')).status, 404);
        assert.equal((await t.get('/api/v1/repos/sam/secret-notes', { as: sam })).status, 200);

        // Stats and activity are real counts.
        const stats = await t.get('/api/v1/stats');
        assert.equal(stats.status, 200);
        assert.ok(stats.json().repositories >= 1);
        const activity = await t.get('/api/v1/activity');
        assert.ok(activity.json().events.some((e) => e.type === 'create' || e.type === 'push'));

        console.log('api: 34 checks passed');
    } finally { await t.close(); }
})().catch((err) => { console.error(err); process.exit(1); });
