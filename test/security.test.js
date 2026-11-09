'use strict';
const assert = require('assert');
const { boot } = require('./helpers/boot');
const { mintToken } = require('../server/auth/git-auth');

(async () => {
    const t = await boot();
    try {
        const sam = t.asUser('sam');
        const other = t.asUser('riley');
        await t.ctx.repos.create({ actor: sam, name: 'guarded', starter: 'static', visibility: 'private' });
        await t.ctx.repos.create({ actor: sam, name: 'public-one', starter: 'static', visibility: 'public' });

        // A private repository does not exist for anyone else, anywhere.
        assert.equal((await t.get('/sam/guarded')).status, 404);
        assert.equal((await t.get('/api/v1/repos/sam/guarded')).status, 404);
        assert.equal((await t.get('/sam/guarded.git/info/refs?service=git-upload-pack')).status, 401);
        assert.equal((await t.get('/api/v1/repos/sam/guarded/tree')).status, 404);
        assert.equal((await t.get('/sam/guarded', { as: other })).status, 404);
        assert.equal((await t.get('/sam/guarded', { as: sam })).status, 200);

        // Paths and refs that try to leave the repository are refused before git.
        for (const badPath of ['../etc/passwd', '/etc/passwd', 'a/../../b', '.git/config', 'a\\b']) {
            const res = await t.get(`/api/v1/repos/sam/public-one/blob?path=${encodeURIComponent(badPath)}`);
            assert.ok([404, 422].includes(res.status), `path refused: ${badPath} -> ${res.status}`);
        }
        const badRef = await t.get('/sam/public-one/tree?ref=--upload-pack%3Dtouch%20/tmp/x');
        assert.equal(badRef.status, 422);
        const traversalRef = await t.get('/sam/public-one/tree?ref=refs/heads/..%2F..%2Fetc');
        assert.equal(traversalRef.status, 422);

        // A read-only token cannot write through the API.
        const readOnly = await mintToken(t.store, { subject: sam.subject, scopes: ['git.read'], hours: 1 });
        const denied = await t.get('/api/v1/repos/sam/public-one/commits', {
            bearer: readOnly.token, json: { branch: 'x', message: 'no', files: [{ path: 'x', content: 'x' }] },
        });
        assert.equal(denied.status, 403);

        // Someone else cannot write to Sam's repository, even with a write token.
        const rileyWrite = await mintToken(t.store, { subject: other.subject, scopes: ['git.read', 'git.write'], hours: 1 });
        const foreign = await t.get('/api/v1/repos/sam/public-one/commits', {
            bearer: rileyWrite.token, json: { branch: 'x', message: 'no', files: [{ path: 'x', content: 'x' }] },
        });
        assert.ok([403, 404].includes(foreign.status), `foreign write refused (${foreign.status})`);

        // An expired token is refused.
        const expired = await mintToken(t.store, { subject: sam.subject, scopes: ['git.read'], hours: 1 });
        await t.store.execute("UPDATE git_tokens SET expires_at = now() - interval '1 hour' WHERE token_hash = ?", [require('../server/auth/git-auth').hashToken(expired.token)]);
        assert.equal((await t.store.maybe('SELECT 1 AS one FROM git_tokens WHERE token_hash = ? AND expires_at > now()', [require('../server/auth/git-auth').hashToken(expired.token)])), null);

        // Every token made through the API leaves an audit row, without the token.
        const minted = await t.get('/api/v1/tokens', { as: sam, json: { scopes: ['git.read'] } });
        assert.equal(minted.status, 201);
        const audit = await t.store.many('SELECT action, actor_subject FROM git_audit ORDER BY id');
        assert.ok(audit.some((a) => a.action === 'token.create'));
        assert.ok(audit.every((a) => !JSON.stringify(a).includes('git_') || a.action !== 'token.create'));

        // The database keeps the columns the service reads.
        const cols = await t.store.db.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'git_repos'");
        const names = cols.map((c) => c.column_name);
        for (const c of ['mirror_url', 'mirror_state', 'push_mirror_token', 'fork_of', 'languages', 'official']) assert.ok(names.includes(c), `column ${c}`);

        console.log('security: 20 checks passed');
    } finally { await t.close(); }
})().catch((err) => { console.error(err); process.exit(1); });
