'use strict';
// GitHub's security workflow in the forge's own run (2026-11-19): a secret scan (gitleaks, with the repository's own
// .gitleaks.toml) and a dependency audit failing at the repository's level, critical by default.
// - The scan's findings are read without the runner's own folders; with gitleaks here, a planted key is found and a
//   narrow allowlist entry clears it.
// - The audit runs npm or pnpm per lockfile, writes a report each, and fails at critical (or high, or never).
// - The configuration turns each on by default and takes a repository's audit_fail_level.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const security = require('../runner/security');
const { loadConfig } = require('../runner/config');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-ci-sec-'));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
try {
    // ── The scan's script and its report ──
    const script = security.secretScanScript();
    assert.match(script, /gitleaks dir \. \$cfg --no-banner --redact/, 'the files at the pushed commit, redacted');
    assert.match(script, /--config \.gitleaks\.toml/);
    assert.match(script, /\.github\/gitleaks\.toml/, 'the config where security.yml looks for it too');
    assert.match(script, /exit 3/, 'a runner without gitleaks says so');
    const run = path.join(tmp, 'run');
    write(path.join(run, '.ci', 'gitleaks.json'), JSON.stringify([
        { RuleID: 'aws-access-token', File: 'src/config.js', StartLine: 3, Secret: 'REDACTED' },
        { RuleID: 'generic-api-key', File: '.ci/etc/passwd', StartLine: 1 },
    ]));
    assert.deepStrictEqual(security.readSecretFindings(run), [{ rule: 'aws-access-token', file: 'src/config.js', line: 3 }], 'the runner\'s folders are not the repository\'s');
    assert.deepStrictEqual(security.readSecretFindings(path.join(tmp, 'none')), [], 'no report, nothing found');

    // A real scan, where gitleaks is installed (the shared node; GitHub's runners skip this part).
    if (spawnSync('gitleaks', ['version']).status === 0) {
        const repo = path.join(tmp, 'repo');
        const key = ['AKIA', 'QYLPMN5HHHFPZAM2'].join('');   // the shape of an AWS key id, made up
        write(path.join(repo, 'src', 'config.js'), `module.exports = { awsKey: '${key}' };\n`);
        const sh = (cwd) => spawnSync('sh', ['-c', script], { cwd, encoding: 'utf8' });
        let out = sh(repo);
        assert.strictEqual(out.status, 1, `a planted key is found (${out.stdout}${out.stderr})`);
        assert.ok(security.readSecretFindings(repo).some((f) => f.file === 'src/config.js'), 'in the file it is in');
        write(path.join(repo, '.gitleaks.toml'), `[extend]\nuseDefault = true\n\n[[allowlists]]\ndescription = "test fixture"\ncondition = "AND"\npaths = ['''^src/config\\.js$''']\nregexes = ['''${key}''']\n`);
        out = sh(repo);
        assert.strictEqual(out.status, 0, `a narrow allowlist entry clears it (${out.stdout}${out.stderr})`);
    } else {
        console.log('ci-security: no gitleaks here; the real scan is skipped');
    }

    // ── The audit ──
    const audit = security.auditScript(['package-lock.json', 'apps/web/pnpm-lock.yaml', 'yarn.lock']);
    assert.match(audit, /\(cd '\.' && npm audit --json > "\$ROOT\/"'\.ci\/audit-0\.json'/);
    assert.match(audit, /\(cd 'apps\/web' && pnpm audit --json > "\$ROOT\/"'\.ci\/audit-1\.json'/);
    assert.doesNotMatch(audit, /yarn/, 'yarn is not audited (as security.yml)');
    write(path.join(run, '.ci', 'audit-0.json'), JSON.stringify({ metadata: { vulnerabilities: { critical: 1, high: 2, moderate: 0, low: 3 } } }));
    write(path.join(run, '.ci', 'audit-1.json'), JSON.stringify({ metadata: { vulnerabilities: { critical: 0, high: 4, moderate: 1, low: 0 } } }));
    const results = security.readAuditCounts(run, ['package-lock.json', 'apps/web/pnpm-lock.yaml', 'other/package-lock.json']);
    assert.deepStrictEqual(results[0].counts, { critical: 1, high: 2, moderate: 0, low: 3 });
    assert.strictEqual(results[2].counts, null, 'no report: nothing was checked, not a failure');
    assert.deepStrictEqual(security.auditFailures(results), ['package-lock.json: 1 critical'], 'critical by default: high is reported, not enforced');
    assert.deepStrictEqual(security.auditFailures(results, 'high'), ['package-lock.json: 1 critical, 2 high', 'apps/web/pnpm-lock.yaml: 0 critical, 4 high']);
    assert.deepStrictEqual(security.auditFailures(results, 'none'), []);

    // ── The configuration ──
    const token = path.join(tmp, 'token');
    fs.writeFileSync(token, 'x'.repeat(40), { mode: 0o600 });
    const conf = path.join(tmp, 'ci.json');
    fs.writeFileSync(conf, JSON.stringify({ tokenFile: token, repos: { 'OpenVibers/A': {}, 'OpenVibers/B': { audit_fail_level: 'none' }, 'OpenVibers/C': { audit_fail_level: 'bogus' } } }));
    const cfg = loadConfig({ GIT_CI_CONFIG: conf });
    assert.strictEqual(cfg.secretScan, true);
    assert.strictEqual(cfg.audit, true);
    assert.strictEqual(cfg.repos['openvibers/a'].audit_fail_level, 'critical');
    assert.strictEqual(cfg.repos['openvibers/b'].audit_fail_level, 'none');
    assert.strictEqual(cfg.repos['openvibers/c'].audit_fail_level, 'critical', 'an unknown level is the default');
    fs.writeFileSync(conf, JSON.stringify({ tokenFile: token, secretScan: false, audit: false }));
    const off = loadConfig({ GIT_CI_CONFIG: conf });
    assert.strictEqual(off.secretScan, false);
    assert.strictEqual(off.audit, false);

    console.log('ci-security: secret scan, its allowlist, the audit at each level and the configuration passed');
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
