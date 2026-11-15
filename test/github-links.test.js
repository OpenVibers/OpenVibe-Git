'use strict';
// GitHub, linked once (plan §AD.10 step 3): a person links one GitHub token on Settings → GitHub; it is checked with
// GitHub (whose is it), sealed at rest and never shown again; a push mirror with no token of its own pushes with it.
const assert = require('assert');
const { boot } = require('./helpers/boot');
const { createMirrors } = require('../server/mirror');

const GOOD = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123';
(async () => {
    const asked = [];
    const fetchImpl = async (url, o = {}) => {
        const u = String(url);
        if (u === 'https://api.github.com/user') {
            asked.push(o.headers && o.headers.Authorization);
            const ok = o.headers && o.headers.Authorization === `Bearer ${GOOD}`;
            return { ok, status: ok ? 200 : 401, json: async () => (ok ? { login: 'sam-gh' } : { message: 'Bad credentials' }) };
        }
        return globalThis.fetch(url, o);   // sign-in keys and everything else: the real thing
    };
    const t = await boot({ fetchImpl });
    try {
        const sam = t.asUser('sam');
        const links = t.ctx.githubLinks;

        // Signed out: the page asks to sign in.
        let r = await t.get('/settings/github');
        assert.strictEqual(r.status, 303);
        r = await t.get('/settings/github', { as: sam });
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Nothing is linked'), 'nothing linked yet');

        // A token GitHub does not accept, and one that does not look like a token, are said.
        r = await t.get('/settings/github', { as: sam, form: { token: 'ghp_' + 'x'.repeat(36) } });
        assert.match(String(r.headers.get('location')), /error=GitHub%20does%20not%20accept/);
        r = await t.get('/settings/github', { as: sam, form: { token: 'nope nope' } });
        assert.match(String(r.headers.get('location')), /error=That%20does%20not%20look/);
        r = await t.get('/settings/github', { as: sam, form: { token: GOOD } });
        assert.match(String(r.headers.get('location')), /ok=Linked%20to%20%40sam-gh/);
        assert.deepStrictEqual(await links.get(sam.subject).then((x) => x && x.login), 'sam-gh');
        const stored = await t.ctx.store.maybe('SELECT token FROM git_github_links WHERE subject = ?', [sam.subject]);
        assert.ok(stored && !stored.token.includes(GOOD), 'sealed at rest');
        r = await t.get('/settings/github', { as: sam });
        assert.ok(r.text.includes('Linked to <b>@sam-gh</b>') && !r.text.includes(GOOD), 'the page says the account, never the token');

        // A push mirror with no token of its own pushes with the linked one.
        const row0 = await t.ctx.repos.create({ actor: sam, name: 'mirrored', starter: 'static', visibility: 'public' });
        const row = await t.ctx.store.maybe('SELECT * FROM git_repos WHERE owner_username = ? AND name = ?', ['sam', row0.name]);
        await t.ctx.repos.setPushMirror(row, { push_url: 'https://github.com/sam-gh/mirrored' }, sam);
        const pushed = [];
        const git = { pushMirror: async (owner, name, url, o) => { pushed.push({ owner, name, url, token: o.token }); } };
        const mirrors = createMirrors({ store: t.ctx.store, repos: t.ctx.repos, config: t.ctx.config, git, github: t.ctx.github, githubLinks: links, log: { warn() {}, info() {}, log() {} } });
        await mirrors.afterPush(await t.ctx.store.maybe('SELECT * FROM git_repos WHERE id = ?', [row.id]));
        assert.strictEqual(pushed.length, 1);
        assert.strictEqual(pushed[0].token, GOOD, 'the linked token');

        // Unlinked: the mirror has no token and says so instead of pushing.
        r = await t.get('/settings/github/unlink', { as: sam, form: { x: '1' } });
        assert.match(String(r.headers.get('location')), /ok=Unlinked/);
        await mirrors.afterPush(await t.ctx.store.maybe('SELECT * FROM git_repos WHERE id = ?', [row.id]));
        assert.strictEqual(pushed.length, 1, 'nothing pushed without a token');
        assert.strictEqual((await t.ctx.store.maybe('SELECT push_mirror_state FROM git_repos WHERE id = ?', [row.id])).push_mirror_state, 'error');
        console.log('github-links: one GitHub token, checked, sealed, used by push mirrors without their own');
    } finally {
        await t.close();
    }
})().catch((e) => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exit(1); });
