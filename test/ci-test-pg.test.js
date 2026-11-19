'use strict';
// The forge runs a repository's test:pg (the suite on PostgreSQL + PgBouncer + Valkey) when testPg says: 'all' runs,
// 'main' only on the default branch (after a merge), 'off' never; only where package.json has the script. The phase
// starts the services with the repository's own openvibe-sdk script, local binaries, no Docker (2026-11-19).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { wantsTestPg, TEST_PG_SCRIPT } = require('../runner/run');
const { loadConfig } = require('../runner/config');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-ci-pg-'));
try {
    const withPg = path.join(tmp, 'with');
    const without = path.join(tmp, 'without');
    fs.mkdirSync(withPg); fs.mkdirSync(without);
    fs.writeFileSync(path.join(withPg, 'package.json'), JSON.stringify({ scripts: { test: 'node test/run.js', 'test:pg': 'X_TEST_STORE=pg node test/run.js' } }));
    fs.writeFileSync(path.join(without, 'package.json'), JSON.stringify({ scripts: { test: 'node test/run.js' } }));
    const job = { repo: { default_branch: 'main' } };
    const main = { branch: 'main' };
    const branch = { branch: 'feature' };
    assert.strictEqual(wantsTestPg(withPg, main, job, 'main'), true, 'main, after a merge');
    assert.strictEqual(wantsTestPg(withPg, branch, job, 'main'), false, 'not a pull request branch');
    assert.strictEqual(wantsTestPg(withPg, branch, job, 'all'), true, 'every run with all');
    assert.strictEqual(wantsTestPg(withPg, main, job, 'off'), false);
    assert.strictEqual(wantsTestPg(without, main, job, 'all'), false, 'no test:pg script, nothing to run');
    assert.strictEqual(wantsTestPg(withPg, { branch: 'trunk' }, { repo: { default_branch: 'trunk' } }, 'main'), true, 'the repository\'s own default branch');

    assert.match(TEST_PG_SCRIPT, /node_modules\/openvibe-sdk\/scripts\/test-services\.sh/);
    assert.match(TEST_PG_SCRIPT, /OV_TEST_SERVICES=local/, 'local binaries: the sandbox has no Docker');
    assert.match(TEST_PG_SCRIPT, /exit 98/, 'no script: skipped');
    assert.match(TEST_PG_SCRIPT, /exit 97/, 'services that do not start: the runner\'s problem, not counted');
    assert.match(TEST_PG_SCRIPT, /npm run test:pg$/);

    const token = path.join(tmp, 'token');
    fs.writeFileSync(token, 'x'.repeat(40), { mode: 0o600 });
    const conf = path.join(tmp, 'ci.json');
    fs.writeFileSync(conf, JSON.stringify({ tokenFile: token }));
    assert.strictEqual(loadConfig({ GIT_CI_CONFIG: conf }).testPg, 'off', 'off by default');
    fs.writeFileSync(conf, JSON.stringify({ tokenFile: token, testPg: 'main' }));
    assert.strictEqual(loadConfig({ GIT_CI_CONFIG: conf }).testPg, 'main');
    fs.writeFileSync(conf, JSON.stringify({ tokenFile: token, testPg: 'sometimes' }));
    assert.strictEqual(loadConfig({ GIT_CI_CONFIG: conf }).testPg, 'off', 'an unknown value is off');
    console.log('ci-test-pg: when test:pg runs, its script and the configuration passed');
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
