'use strict';
const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { boot } = require('./helpers/boot');
const { mintToken } = require('../server/auth/git-auth');

(async () => {
    const t = await boot();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'openvibe-git-http-'));
    try {
        const sam = t.asUser('sam');
        await t.ctx.repos.create({ actor: sam, name: 'clone-me', description: 'Clone this.', starter: 'static', visibility: 'public' });
        await t.ctx.repos.create({ actor: sam, name: 'only-me', description: 'Private.', starter: 'static', visibility: 'private' });

        // A public clone works with no password.
        const publicDir = path.join(work, 'public');
        await t.git(['clone', '--quiet', t.cloneUrl('sam', 'clone-me'), publicDir]);
        assert.ok(fs.existsSync(path.join(publicDir, 'index.html')), 'the file is there');

        // A private clone needs the owner's token.
        await assert.rejects(() => t.git(['clone', '--quiet', t.cloneUrl('sam', 'only-me'), path.join(work, 'no')]));

        const readToken = await mintToken(t.store, { subject: sam.subject, scopes: ['git.read'], hours: 1 });
        const privateDir = path.join(work, 'private');
        await t.git(['clone', '--quiet', t.cloneUrl('sam', 'only-me', readToken.token), privateDir]);
        assert.ok(fs.existsSync(path.join(privateDir, 'README.md')));

        // A push changes the repository.
        const writeToken = await mintToken(t.store, { subject: sam.subject, scopes: ['git.read', 'git.write'], hours: 1 });
        await t.git(['-c', 'user.name=Sam', '-c', 'user.email=sam@example.com', 'checkout', '-b', 'phone'], publicDir);
        fs.writeFileSync(path.join(publicDir, 'phone.txt'), 'a phone-first change\n');
        await t.git(['add', 'phone.txt'], publicDir);
        await t.git(['-c', 'user.name=Sam', '-c', 'user.email=sam@example.com', 'commit', '-q', '-m', 'Add a phone note'], publicDir);
        await t.git(['push', '--quiet', t.cloneUrl('sam', 'clone-me', writeToken.token), 'phone'], publicDir);
        const pushed = await t.ctx.git.readBlob('sam', 'clone-me', 'phone', 'phone.txt');
        assert.equal(pushed.text, 'a phone-first change\n');

        // A typed Network token with git.write works the same way.
        const typed = t.network.gitToken({ subject: sam.subject, caps: ['git.read', 'git.write'] });
        fs.writeFileSync(path.join(publicDir, 'typed.txt'), 'typed\n');
        await t.git(['add', 'typed.txt'], publicDir);
        await t.git(['-c', 'user.name=Sam', '-c', 'user.email=sam@example.com', 'commit', '-q', '-m', 'Add a typed note'], publicDir);
        await t.git(['push', '--quiet', t.cloneUrl('sam', 'clone-me', typed), 'phone'], publicDir);
        assert.equal((await t.ctx.git.readBlob('sam', 'clone-me', 'phone', 'typed.txt')).text, 'typed\n');

        // A read-only token may not push; an anonymous push is refused.
        const readOnly = await mintToken(t.store, { subject: sam.subject, scopes: ['git.read'], hours: 1 });
        fs.writeFileSync(path.join(publicDir, 'more.txt'), 'no\n');
        await t.git(['add', 'more.txt'], publicDir);
        await t.git(['-c', 'user.name=Sam', '-c', 'user.email=sam@example.com', 'commit', '-q', '-m', 'Nope'], publicDir);
        await assert.rejects(() => t.git(['push', '--quiet', t.cloneUrl('sam', 'clone-me', readOnly.token), 'phone'], publicDir));
        await assert.rejects(() => t.git(['push', '--quiet', t.cloneUrl('sam', 'clone-me'), 'phone'], publicDir));

        // The clone count went up (info/refs was served), and the push is in the activity feed.
        const insights = await t.ctx.repos.insightsFor(await t.ctx.repos.byId((await t.ctx.repos.getRow('sam', 'clone-me')).id));
        assert.ok(insights.clones >= 1, 'clones counted');
        const events = await t.ctx.repos.activity(20);
        assert.ok(events.some((e) => e.type === 'push'));

        // Git's own advertisement refuses a bogus service rather than passing it on.
        const bogus = await t.get('/sam/clone-me.git/info/refs?service=git-nonsense');
        assert.equal(bogus.status, 400);

        console.log('git-http: 18 checks passed');
    } finally {
        await t.close();
        fs.rmSync(work, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
