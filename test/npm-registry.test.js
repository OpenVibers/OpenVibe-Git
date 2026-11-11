'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { boot } = require('./helpers/boot');

(async () => {
    const token = 'test-registry-publisher';
    const t = await boot({ env: { GIT_CI_RUNNER_TOKEN: token } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-git-npm-'));
    try {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'openvibe-shared', version: '9.8.7', main: 'index.js' }));
        fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = 42;\n');
        execFileSync('npm', ['pack', '--ignore-scripts', '--silent'], { cwd: dir, env: { ...process.env, npm_config_cache: path.join(dir, 'cache') } });
        const tarball = fs.readFileSync(path.join(dir, 'openvibe-shared-9.8.7.tgz'));
        const root = '/api/packages/openvibers/npm/openvibe-shared';
        const publish = { name: 'openvibe-shared', versions: { '9.8.7': { name: 'openvibe-shared', version: '9.8.7', main: 'index.js' } },
            'dist-tags': { latest: '9.8.7' }, _attachments: { 'openvibe-shared-9.8.7.tgz': { data: tarball.toString('base64') } } };
        assert.equal((await t.get(root, { method: 'PUT', json: publish })).status, 401, 'publishing requires the runner credential');
        assert.equal((await t.get(root, { method: 'PUT', json: publish, bearer: token })).status, 201);
        assert.equal((await t.get(root, { method: 'PUT', json: publish, bearer: token })).status, 409, 'published versions are immutable');
        const metadata = (await t.get(root)).json();
        assert.equal(metadata['dist-tags'].latest, '9.8.7');
        assert.match(metadata.versions['9.8.7'].dist.integrity, /^sha512-/);
        assert.deepEqual((await t.get(`${root}/-/openvibe-shared-9.8.7.tgz`)).buffer, tarball);
        assert.equal((await t.get('/api/packages/stranger/npm/openvibe-shared')).status, 404);
        const install = path.join(dir, 'install');
        fs.mkdirSync(install);
        fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ name: 'registry-spike-test', version: '1.0.0', private: true }));
        await promisify(execFile)('npm', ['install', 'openvibe-shared@9.8.7', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', `${t.base}/api/packages/openvibers/npm/`],
            { cwd: install, env: { ...process.env, npm_config_cache: path.join(dir, 'install-cache'), npm_config_userconfig: '/dev/null' }, timeout: 30000 });
        assert.equal(require(path.join(install, 'node_modules/openvibe-shared')), 42);
        console.log('npm registry: publish, immutable version, metadata, tarball and npm install passed');
    } finally {
        await t.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
