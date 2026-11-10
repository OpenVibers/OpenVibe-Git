'use strict';
/**
 * Tarballs: /<owner>/<name>/archive/<ref>.tar.gz (and the API form) streams git archive of the ref. The
 * ETag is the commit; a tag answers the same bytes twice with immutable caching; a branch caches short.
 * A package manager can pin the address: npm installs a fixture package from the test server's own URL
 * (loopback only, no network).
 */
const assert = require('assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const { boot } = require('./helpers/boot');

/** The entry names in a tar.gz buffer, parsed without leaving the process. */
function tarNames(tgz) {
    const tar = zlib.gunzipSync(tgz);
    const names = [];
    let off = 0;
    while (off + 512 <= tar.length) {
        const name = tar.subarray(off, off + 100).toString('utf8').split('\0')[0];
        if (!name) break;
        names.push(name);
        const size = parseInt(tar.subarray(off + 124, off + 136).toString('utf8').trim() || '0', 8);
        off += 512 + Math.ceil(size / 512) * 512;
    }
    return names;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

(async () => {
    const t = await boot();
    try {
        const sam = t.asUser('sam');
        await t.ctx.repos.create({ actor: sam, name: 'pkg', starter: 'empty', visibility: 'public' });
        const made = await t.ctx.git.commitFiles('sam', 'pkg', {
            branch: 'main', base: 'main', message: 'A tiny package',
            files: [
                { path: 'package.json', content: JSON.stringify({ name: 'fixture-pkg', version: '1.0.0', main: 'index.js' }) },
                { path: 'index.js', content: 'module.exports = 42;\n' },
            ],
            author: { name: 'Sam', email: 'sam@example.com' },
        });
        // An empty starter's first commit needs its branch: commitFiles made main from nothing.
        const sha = made.sha;
        await t.git(['tag', 'v1.0.0', sha], t.ctx.git.repoDir('sam', 'pkg'));

        const page = await t.get('/sam/pkg/archive/v1.0.0.tar.gz');
        assert.equal(page.status, 200, page.text.slice(0, 200));
        assert.match(page.headers.get('content-type'), /application\/gzip/);
        assert.match(page.headers.get('content-disposition'), /attachment; filename="pkg-v1\.0\.0\.tar\.gz"/);
        assert.equal(page.headers.get('etag'), `"${sha}-tar.gz"`);
        assert.equal(page.headers.get('cache-control'), 'public, max-age=31536000, immutable');
        const names = tarNames(page.buffer);
        assert.ok(names.includes(`pkg-${sha}/package.json`), names.join(','));
        assert.ok(names.includes(`pkg-${sha}/index.js`));
        // git archive prepends a pax_global_header with the commit id; everything else sits under one folder.
        assert.ok(names.every((n) => n === 'pax_global_header' || n.startsWith(`pkg-${sha}/`)), `one top folder: ${names.join(',')}`);

        // A tag's bytes are stable: the same address twice, and the API form, hash alike.
        const again = await t.get('/sam/pkg/archive/v1.0.0.tar.gz');
        assert.equal(sha256(again.buffer), sha256(page.buffer));
        const api = await t.get('/api/v1/repos/sam/pkg/archive/v1.0.0.tar.gz');
        assert.equal(api.status, 200, api.text.slice(0, 200));
        assert.equal(sha256(api.buffer), sha256(page.buffer));

        // A full commit id caches immutably too; a branch caches short.
        const byId = await t.get(`/sam/pkg/archive/${sha}.tar.gz`);
        assert.equal(byId.status, 200);
        assert.equal(byId.headers.get('cache-control'), 'public, max-age=31536000, immutable');
        const branch = await t.get('/sam/pkg/archive/main.tar.gz');
        assert.equal(branch.status, 200);
        assert.equal(branch.headers.get('cache-control'), 'public, max-age=60');
        assert.equal(branch.headers.get('etag'), `"${sha}-tar.gz"`);

        // A branch with a slash archives under its own name.
        await t.ctx.git.commitFiles('sam', 'pkg', {
            branch: 'agent/run-1', base: 'main', message: 'A slash branch',
            files: [{ path: 'slash.txt', content: 'slashed\n' }],
            author: { name: 'Sam', email: 'sam@example.com' },
        });
        const slashed = await t.get('/sam/pkg/archive/agent/run-1.tar.gz');
        assert.equal(slashed.status, 200, slashed.text.slice(0, 200));
        assert.match(slashed.headers.get('content-disposition'), /filename="pkg-agent-run-1\.tar\.gz"/);
        assert.ok(tarNames(slashed.buffer).some((n) => n.endsWith('/slash.txt')));

        // Conditional reads, unknown refs and the suffix rule.
        assert.equal((await t.get('/sam/pkg/archive/v1.0.0.tar.gz', { headers: { 'if-none-match': `"${sha}-tar.gz"` } })).status, 304);
        assert.equal((await t.get('/sam/pkg/archive/nope.tar.gz')).status, 404);
        assert.equal((await t.get('/sam/pkg/archive/main.zip')).status, 404);
        assert.equal((await t.get('/api/v1/repos/sam/pkg/archive/nope.tar.gz')).status, 404);

        // Private repositories follow the raw file: 404 to strangers, a tarball to the owner.
        await t.ctx.repos.create({ actor: sam, name: 'secret-pkg', starter: 'static', visibility: 'private' });
        assert.equal((await t.get('/sam/secret-pkg/archive/main.tar.gz')).status, 404);
        assert.equal((await t.get('/api/v1/repos/sam/secret-pkg/archive/main.tar.gz')).status, 404);
        assert.equal((await t.get('/sam/secret-pkg/archive/main.tar.gz', { as: sam })).status, 200);
        const token = await t.get('/api/v1/tokens', { as: sam, json: { scopes: ['git.repo.read'] } });
        assert.equal((await t.get('/api/v1/repos/sam/secret-pkg/archive/main.tar.gz', { bearer: token.json().token })).status, 200);

        // npm installs the fixture from the forge address, like a package.json pin would.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openvibe-git-pin-'));
        try {
            const url = `${t.base}/sam/pkg/archive/v1.0.0.tar.gz`;
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pin-consumer', private: true, dependencies: { 'fixture-pkg': url } }));
            await new Promise((resolve, reject) => {
                execFile('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--no-update-notifier'],
                    { cwd: dir, timeout: 90000, env: { ...process.env, HOME: dir, npm_config_cache: path.join(dir, 'cache') } },
                    (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve(stdout)));
            });
            const installed = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', 'fixture-pkg', 'package.json'), 'utf8'));
            assert.equal(installed.name, 'fixture-pkg');
            assert.equal(installed.version, '1.0.0');
            assert.equal(require(path.join(dir, 'node_modules', 'fixture-pkg', 'index.js')), 42);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }

        console.log('archive: page and API tarballs, stable tag bytes, ETag/cache, auth and an npm pin install passed');
    } finally { await t.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
