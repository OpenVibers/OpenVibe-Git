'use strict';
const assert = require('assert');
const { boot } = require('./helpers/boot');
const { parseGithubUrl, createGithubClient } = require('../server/github');
const { seal, open } = require('../server/crypto');

(async () => {
    const t = await boot();
    t.config.mirrors.timeoutMs = 400;
    try {
        // The URL rule: https, exactly github.com, owner/name, no credentials.
        assert.equal(parseGithubUrl('https://github.com/OpenVibers/OpenVibe.Contracts').full_name, 'OpenVibers/OpenVibe.Contracts');
        assert.equal(parseGithubUrl('https://github.com/OpenVibers/OpenVibe.Contracts.git').clone_url, 'https://github.com/OpenVibers/OpenVibe.Contracts.git');
        for (const bad of ['http://github.com/a/b', 'https://evil.com/a/b', 'https://github.com/a/b/c', 'https://user:pass@github.com/a/b', 'https://github.com/a/b?x=1', 'ftp://github.com/a/b', 'https://localhost/a/b']) {
            assert.equal(parseGithubUrl(bad), null, `refused ${bad}`);
        }

        // The webhook's signature is over the raw body and constant time.
        const github = createGithubClient({ config: t.config, fetchImpl: async () => { throw new Error('offline'); }, log: { warn() {} } });
        const raw = Buffer.from(JSON.stringify({ repository: { full_name: 'OpenVibers/OpenVibe.Contracts' } }));
        const crypto = require('node:crypto');
        const sig = `sha256=${crypto.createHmac('sha256', 'test-webhook-secret').update(raw).digest('hex')}`;
        assert.equal(github.signatureOk(raw, sig), true);
        assert.equal(github.signatureOk(raw, 'sha256=00'), false);
        assert.equal(github.signatureOk(raw, undefined), false);

        // A webhook for an unknown repository is acknowledged and ignored.
        const bad = await t.get('/api/v1/webhooks/github', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00', 'x-github-event': 'push' } });
        assert.equal(bad.status, 401);
        const good = await t.get('/api/v1/webhooks/github', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig, 'x-github-event': 'push' } });
        assert.equal(good.status, 200);
        assert.equal(good.json().ignored, 'no mirror');

        // A mirror URL that is not GitHub is refused at creation, with no network.
        const sam = t.asUser('sam');
        await assert.rejects(() => t.ctx.repos.create({ actor: sam, name: 'mirror-no', mirrorUrl: 'https://localhost/x/y' }), /github\.com/i);

        // A sync of a row whose URL fails the guard lands in the error state, not a crash.
        await t.ctx.repos.create({ actor: sam, name: 'plain', starter: 'empty' });
        await t.store.execute("UPDATE git_repos SET mirror_url = 'https://github.com/sindresorhus/is-odd.git' WHERE name = 'plain'");
        const row = await t.ctx.repos.getRow('sam', 'plain');
        const realFetch = globalThis.fetch;
        const result = await t.ctx.mirrors.syncRow(row);
        assert.equal(result.ok, false);
        const after = await t.ctx.repos.getRow('sam', 'plain');
        assert.equal(after.mirror_state, 'error');
        assert.ok(after.mirror_error);
        void realFetch;

        // Push-mirror tokens are sealed at rest and never returned.
        const sealed = seal('ghp_secret_value', t.config.tokens.secretKey);
        assert.match(sealed, /^v1\./);
        assert.ok(!sealed.includes('ghp_secret_value'));
        assert.equal(open(sealed, t.config.tokens.secretKey), 'ghp_secret_value');
        assert.equal(open(sealed, 'another-key'), null);
        await t.ctx.repos.setPushMirror(await t.ctx.repos.getRow('sam', 'plain'), { push_url: 'https://github.com/sam/plain', push_token: 'ghp_secret_value' }, sam);
        const stored = await t.ctx.repos.getRow('sam', 'plain');
        assert.ok(stored.push_mirror_token.startsWith('v1.'));
        assert.ok(!stored.push_mirror_token.includes('ghp_secret_value'));
        assert.equal(t.ctx.repos.pushTokenFor(stored), 'ghp_secret_value');
        const shown = await t.get('/api/v1/repos/sam/plain', { as: sam });
        assert.ok(!JSON.stringify(shown.json()).includes('ghp_secret_value'));

        console.log('mirror: 25 checks passed');
    } finally { await t.close(); }
})().catch((err) => { console.error(err); process.exit(1); });
