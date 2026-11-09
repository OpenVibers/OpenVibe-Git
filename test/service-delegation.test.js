'use strict';
/**
 * A service acting for a person (Codes, Run, Link): a typed Network token for audience openvibe.git with
 * sub svc:<service> and git.read/git.write, naming the person in X-OV-Subject. The service makes a
 * repository in the person's name, reads their private one, and mints a Git token for their session; it
 * cannot open a namespace that belongs to someone else.
 */
const assert = require('assert');
const { boot } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const service = t.network.gitToken({ subject: 'svc:codes', caps: ['git.read', 'git.write'], type: null });
        const ada = t.asUser('ada');
        const bob = t.asUser('bob');

        const nameless = await t.get('/api/v1/repos', { bearer: service, json: { name: 'ada-site' } });
        assert.equal(nameless.status, 401);
        assert.equal(nameless.json().code, 'auth.subject_required');

        const unnamedOwner = await t.get('/api/v1/repos', { bearer: service, headers: { 'x-ov-subject': ada.subject }, json: { name: 'ada-site' } });
        assert.equal(unnamedOwner.status, 422);
        assert.equal(unnamedOwner.json().code, 'repo.owner_required');

        const made = await t.get('/api/v1/repos', {
            bearer: service, headers: { 'x-ov-subject': ada.subject },
            json: { name: 'ada-site', owner_username: 'Ada', description: 'Made from Codes.', visibility: 'private' },
        });
        assert.equal(made.status, 201, made.text);
        assert.equal(made.json().full_name, 'ada/ada-site');
        assert.equal(made.json().visibility, 'private');
        assert.equal(made.json().owner.subject, ada.subject, 'the person owns it, not the service');
        assert.match(made.json().clone_url, /\/ada\/ada-site\.git$/);

        const others = await t.get('/api/v1/repos', {
            bearer: service, headers: { 'x-ov-subject': bob.subject },
            json: { name: 'bob-site', owner_username: 'ada' },
        });
        assert.equal(others.status, 409, 'ada is not bob');
        assert.equal(others.json().code, 'repo.owner_mismatch');

        // A private repository is the person's: the service sees it only while it names them.
        assert.equal((await t.get('/api/v1/repos/ada/ada-site', { bearer: service, headers: { 'x-ov-subject': ada.subject } })).status, 200);
        assert.equal((await t.get('/api/v1/repos/ada/ada-site', { bearer: service })).status, 404);
        assert.equal((await t.get('/api/v1/repos/ada/ada-site', { bearer: service, headers: { 'x-ov-subject': bob.subject } })).status, 404);

        const profile = await t.get('/api/v1/profile/ada', { bearer: service, headers: { 'x-ov-subject': ada.subject } });
        assert.equal(profile.status, 200);
        assert.equal(profile.json().repositories[0].full_name, 'ada/ada-site');
        const anonymous = await t.get('/api/v1/profile/ada', { bearer: service });
        assert.equal(anonymous.json().repositories.length, 0, 'nothing of ada\'s is public yet');

        // A Git token for the person's session: theirs, not the service's.
        const minted = await t.get('/api/v1/tokens', {
            bearer: service, headers: { 'x-ov-subject': ada.subject }, json: { scopes: ['git.read', 'git.write'], hours: 2 },
        });
        assert.equal(minted.status, 201, minted.text);
        assert.match(minted.json().token, /^git_/);
        const row = await t.store.maybe('SELECT subject, actor_type FROM git_tokens WHERE token_hash = ?', [require('../server/auth/git-auth').hashToken(minted.json().token)]);
        assert.deepStrictEqual([row.subject, row.actor_type], [ada.subject, 'user']);
        const heads = await t.git(['ls-remote', '--heads', t.cloneUrl('ada', 'ada-site', minted.json().token)]);
        assert.match(heads, /refs\/heads\/main/, 'the token clones the private repository');

        // A contents write with no clone, as the person, on their own (non-official) repository.
        const write = await t.get('/api/v1/repos/ada/ada-site/commits', {
            bearer: service, headers: { 'x-ov-subject': ada.subject },
            json: { branch: 'agent/codes-1', message: 'From a Codes session', files: [{ path: 'notes.txt', content: 'hello\n' }] },
        });
        assert.equal(write.status, 201, write.text);
        assert.equal((await t.get('/api/v1/repos/ada/ada-site/blob?ref=agent/codes-1&path=notes.txt', { bearer: service, headers: { 'x-ov-subject': ada.subject } })).json().text, 'hello\n');

        // A read-only service token may not make a repository or mint one.
        const readOnly = t.network.gitToken({ subject: 'svc:codes', caps: ['git.read'], type: null });
        const refused = await t.get('/api/v1/repos', {
            bearer: readOnly, headers: { 'x-ov-subject': ada.subject }, json: { name: 'read-only', owner_username: 'ada' },
        });
        assert.equal(refused.status, 403);
        assert.equal(refused.json().code, 'token.scope');
        assert.equal((await t.get('/api/v1/tokens', { bearer: readOnly, headers: { 'x-ov-subject': ada.subject }, json: { scopes: ['git.read'] } })).status, 403);
    } finally {
        await t.close();
    }
    console.log('service delegation: ok');
})().catch((e) => { console.error(e); process.exit(1); });
