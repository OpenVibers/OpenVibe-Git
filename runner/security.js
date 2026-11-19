'use strict';

/**
 * The checks GitHub's security workflow (openvibe-shared .github/workflows/security.yml) runs, in the forge's own run
 * (2026-11-19, the owner: "handle CI with our own system"), so forge/test is the whole verdict:
 *
 *   secrets   gitleaks over the pushed commit's files, in the sandbox with no network, with the repository's own
 *             .gitleaks.toml (or .github/gitleaks.toml). A finding fails the run. A runner without gitleaks says so and
 *             skips it (/usr/local/bin/gitleaks on the shared node, the version security.yml pins).
 *   audit     npm audit / pnpm audit for every lockfile in the checkout, through the install proxy (the registry's
 *             advisories), failing at the repository's audit_fail_level: critical by default, as security.yml (high
 *             is reported, not enforced), or high, or none. An audit that returns nothing (the registry unreachable)
 *             is reported and checks nothing, as on GitHub.
 */
const fs = require('node:fs');
const path = require('node:path');

const LEVELS = ['critical', 'high', 'moderate', 'low'];

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The secret scan's script: exit 0 clean, 1 findings (gitleaks' own), 3 no gitleaks here, anything else an error. */
function secretScanScript() {
    return [
        'command -v gitleaks >/dev/null 2>&1 || { echo "secret scan: gitleaks is not installed on this runner"; exit 3; }',
        'cfg=""',
        '[ -f .gitleaks.toml ] && cfg="--config .gitleaks.toml"',
        '[ -z "$cfg" ] && [ -f .github/gitleaks.toml ] && cfg="--config .github/gitleaks.toml"',
        // The runner's own folders are not the repository's.
        'mkdir -p .ci',
        'gitleaks dir . $cfg --no-banner --redact --report-format json --report-path .ci/gitleaks.json --exit-code 1 --log-level warn',
    ].join('\n');
}

/** What the scan found: the findings without their secrets (gitleaks redacts them), the runner's folders left out. */
function readSecretFindings(runDir) {
    let rows = [];
    try { rows = JSON.parse(fs.readFileSync(path.join(runDir, '.ci', 'gitleaks.json'), 'utf8')); } catch { return []; }
    return (Array.isArray(rows) ? rows : [])
        .filter((r) => r && r.File && !/^(\.\/)?\.(ci|home|cache|pnpm)\//.test(String(r.File)))
        .map((r) => ({ rule: String(r.RuleID || ''), file: String(r.File).replace(/^\.\//, ''), line: Number(r.StartLine) || 0 }));
}

/** The audit's script: one JSON report per lockfile under the checkout's .ci, whatever the audit's own exit code. */
function auditScript(lockfiles) {
    const lines = ['ROOT=$(pwd)', 'mkdir -p "$ROOT/.ci"'];
    lockfiles.forEach((lf, i) => {
        const dir = path.posix.dirname(lf);
        const out = `.ci/audit-${i}.json`;
        if (lf.endsWith('pnpm-lock.yaml')) lines.push(`(cd ${q(dir)} && pnpm audit --json > "$ROOT/"${q(out)} 2>/dev/null) || true`);
        else if (lf.endsWith('package-lock.json') || lf.endsWith('npm-shrinkwrap.json')) lines.push(`(cd ${q(dir)} && npm audit --json > "$ROOT/"${q(out)} 2>/dev/null) || true`);
    });
    return lines.join('\n');
}

/** Each lockfile's advisory counts, or null when its audit returned nothing. */
function readAuditCounts(runDir, lockfiles) {
    return lockfiles.map((lockfile, i) => {
        let data = null;
        try { data = JSON.parse(fs.readFileSync(path.join(runDir, '.ci', `audit-${i}.json`), 'utf8')); } catch { data = null; }
        const v = data && data.metadata && data.metadata.vulnerabilities;
        if (!v || typeof v !== 'object') return { lockfile, counts: null };
        return { lockfile, counts: Object.fromEntries(LEVELS.map((l) => [l, Number(v[l]) || 0])) };
    });
}

/** The lockfiles whose advisories reach the fail level (critical: critical; high: high or critical; none: never). */
function auditFailures(results, level = 'critical') {
    if (level === 'none') return [];
    const counted = level === 'high' ? ['critical', 'high'] : ['critical'];
    return results.filter((r) => r.counts && counted.some((l) => r.counts[l] > 0))
        .map((r) => `${r.lockfile}: ${counted.map((l) => `${r.counts[l]} ${l}`).join(', ')}`);
}

module.exports = { secretScanScript, readSecretFindings, auditScript, readAuditCounts, auditFailures, LEVELS };
