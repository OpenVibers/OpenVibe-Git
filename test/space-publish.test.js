'use strict';
/**
 * Publish on OpenVibe.Space (plan §AD.10 step 2): the owner names a site, a branch and a folder; Git then sends that
 * folder of every push to the branch to Space's git deploy door, as the owner (its own service token, the owner in
 * X-OV-Subject, the branch and the full commit in the query). Only the folder's files go, at the archive's root; a
 * push to another branch sends nothing; only the owner (or a service acting for them) sees or changes the setting; a
 * missing folder and a refusing Space are said in plain words on the setting.
 */
const assert = require('assert');
const zlib = require('zlib');
const { boot } = require('./helpers/boot');

/** The file names in a tar.gz (regular files only). */
function tarNames(buf) {
    const tar = zlib.gunzipSync(buf);
    const names = [];
    for (let off = 0; off + 512 <= tar.length;) {
        const header = tar.subarray(off, off + 512);
        if (header.every((b) => b === 0)) break;
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
        const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
        const type = String.fromCharCode(header[156] || 48);
        if (type === '0' || type === '\0') names.push(name);
        off += 512 + Math.ceil(size / 512) * 512;
    }
    return names.sort();
}

const SITE = 'sit_01JD0000000000000000000000';
const deploys = [];
let spaceAnswer = () => ({ status: 201, body: { deploy: { id: 'dpl_01JD0000000000000000000001' }, url: 'https://ada-band.openvibe.website/' } });
const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'svc-token-for-space', token_type: 'Bearer', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('http://space.test/')) {
        deploys.push({ url: u, headers: init.headers, names: tarNames(Buffer.from(init.body)) });
        const a = spaceAnswer();
        return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
    }
    return globalThis.fetch(url, init);
};
const settle = async (t, check) => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 40)); } };

(async () => {
    const t = await boot({ fetchImpl, env: { GIT_SPACE_INTERNAL_URL: 'http://space.test' } });
    try {
        const ada = t.asUser('ada');
        const bob = t.asUser('bob');
        const adaToken = t.network.gitToken({ subject: ada.subject, username: 'ada' });
        const service = t.network.gitToken({ subject: 'svc:space', caps: ['git.repo.read', 'git.repo.write'], type: null });
        const made = await t.get('/api/v1/repos', { bearer: service, headers: { 'x-ov-subject': ada.subject }, json: { name: 'band', owner_username: 'ada', visibility: 'private' } });
        assert.equal(made.status, 201, made.text);
        const commit = async (branch, files, message = 'A change') => {
            const r = await t.get('/api/v1/repos/ada/band/commits', { bearer: service, headers: { 'x-ov-subject': ada.subject }, json: { branch, message, files } });
            assert.equal(r.status, 201, r.text);
            return r.json().sha;
        };
        const first = await commit('main', [
            { path: 'site/index.html', content: '<h1>The band</h1>' }, { path: 'site/style.css', content: 'h1 { color: tomato }' },
            { path: 'README.md', content: 'Not for the site' },
        ], 'The site');

        // Only the owner chooses (a service acting for them may), and the setting is checked.
        const put = (as, body) => t.get('/api/v1/repos/ada/band/space-publish', { method: 'PUT', ...as, json: body });
        assert.equal((await put({ bearer: service, headers: { 'x-ov-subject': bob.subject } }, { site_id: SITE, branch: 'main', folder: 'site' })).status, 404, 'bob does not even see it');
        assert.equal((await put({ bearer: service, headers: { 'x-ov-subject': ada.subject } }, { site_id: 'nope', branch: 'main' })).json().code, 'publish.site_invalid');
        assert.equal((await put({ bearer: service, headers: { 'x-ov-subject': ada.subject } }, { site_id: SITE, branch: 'main', folder: '../etc' })).json().code, 'publish.folder_invalid');
        const set = await put({ bearer: service, headers: { 'x-ov-subject': ada.subject } }, { site_id: SITE, branch: 'main', folder: '/site/' });
        assert.equal(set.status, 200, set.text);
        assert.deepEqual([set.json().publish.site_id, set.json().publish.branch, set.json().publish.folder], [SITE, 'main', 'site']);

        // Setting it publishes the branch as it is: the folder's files at the root, as ada, for that commit.
        await settle(t, () => deploys.length === 1);
        assert.equal(deploys.length, 1, 'setting it deploys the branch as it is');
        assert.equal(deploys[0].url, `http://space.test/api/v1/sites/${SITE}/source/deploys?ref=main&commit_sha=${first}`);
        assert.equal(deploys[0].headers['X-OV-Subject'], ada.subject, 'as the owner');
        assert.equal(deploys[0].headers.Authorization, 'Bearer svc-token-for-space', 'with Git\'s own token, never a person\'s');
        assert.equal(deploys[0].headers['Content-Type'], 'application/gzip');
        assert.deepEqual(deploys[0].names, ['index.html', 'style.css'], 'the folder alone, at the root');
        await settle(t, async () => ((await t.get('/api/v1/repos/ada/band/space-publish', { bearer: service, headers: { 'x-ov-subject': ada.subject } })).json().publish.last || {}).state === 'deployed');
        const shown = (await t.get('/api/v1/repos/ada/band/space-publish', { bearer: service, headers: { 'x-ov-subject': ada.subject } })).json().publish;
        assert.deepEqual([shown.last.state, shown.last.sha, shown.last.deploy_id, shown.last.url], ['deployed', first, 'dpl_01JD0000000000000000000001', 'https://ada-band.openvibe.website/']);

        // A push to the branch deploys its commit; a push to another branch does not.
        const second = await commit('main', [{ path: 'site/index.html', content: '<h1>The band, live</h1>' }]);
        await settle(t, () => deploys.length === 2);
        assert.ok(deploys[1].url.endsWith(`commit_sha=${second}`), 'the new commit');
        await commit('draft', [{ path: 'site/index.html', content: 'draft' }]);
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(deploys.length, 2, 'another branch publishes nothing');

        // Deploy now sends the current commit again.
        const now = await t.get('/api/v1/repos/ada/band/space-publish/deploy', { method: 'POST', bearer: service, headers: { 'x-ov-subject': ada.subject }, json: {} });
        assert.equal(now.status, 200, now.text);
        assert.equal(deploys.length, 3);

        // Space refusing, and a folder that is not there, are said on the setting.
        spaceAnswer = () => ({ status: 422, body: { detail: 'This site\'s source is another repository' } });
        await t.get('/api/v1/repos/ada/band/space-publish/deploy', { method: 'POST', bearer: service, headers: { 'x-ov-subject': ada.subject }, json: {} });
        let st = (await t.get('/api/v1/repos/ada/band/space-publish', { bearer: service, headers: { 'x-ov-subject': ada.subject } })).json().publish.last;
        assert.deepEqual([st.state, st.detail], ['failed', 'This site\'s source is another repository']);
        spaceAnswer = () => ({ status: 201, body: { deploy: { id: 'dpl_01JD0000000000000000000002' } } });
        await put({ bearer: service, headers: { 'x-ov-subject': ada.subject } }, { site_id: SITE, branch: 'main', folder: 'dist' });
        await settle(t, async () => ((await t.get('/api/v1/repos/ada/band/space-publish', { bearer: service, headers: { 'x-ov-subject': ada.subject } })).json().publish.last || {}).detail === 'There is no folder "dist" at this commit.');
        st = (await t.get('/api/v1/repos/ada/band/space-publish', { bearer: service, headers: { 'x-ov-subject': ada.subject } })).json().publish.last;
        assert.deepEqual([st.state, st.detail], ['failed', 'There is no folder "dist" at this commit.']);

        // The repository page: the owner sees where it is published and can send it now; nobody else sees it.
        const adaPage = await t.get('/ada/band', { cookie: t.signIn(ada) });
        assert.equal(adaPage.status, 200, adaPage.text.slice(0, 200));
        assert.match(adaPage.text, /<h2>Website<\/h2>/);
        assert.match(adaPage.text, /On OpenVibe\.Space from <b>main<\/b>, its <code>dist\/<\/code> folder/);
        assert.match(adaPage.text, /action="\/ada\/band\/space-publish\/deploy"/);
        assert.match(adaPage.text, new RegExp(`openvibe\\.space/sites/${SITE}`));
        // (bob cannot even see ada's private repository)
        assert.equal((await t.get('/ada/band', { cookie: t.signIn(bob) })).status, 404);

        // Ada's own token works; removing it stops publishing.
        assert.equal((await t.get('/api/v1/repos/ada/band/space-publish', { bearer: adaToken })).status, 200);
        assert.equal((await t.get('/api/v1/repos/ada/band/space-publish', { method: 'DELETE', bearer: service, headers: { 'x-ov-subject': ada.subject } })).status, 204);
        const before = deploys.length;
        await commit('main', [{ path: 'site/index.html', content: '<h1>after</h1>' }]);
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(deploys.length, before, 'removed: nothing is sent');
        const unpublished = await t.get('/ada/band', { cookie: t.signIn(ada) });
        assert.match(unpublished.text, /Host it on OpenVibe\.Space/, 'unpublished: how to start');
        console.log('space-publish: the owner chooses a site, branch and folder; each push to it sends the folder as them; plain words when it fails');
    } finally { await t.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
