'use strict';

/**
 * The forge CI runner's configuration. It lives on the workstation (default ~/.config/openvibe/git-ci.json),
 * never in the repository: it names the API, the token file, the engine, and one entry per repository.
 *
 *   {
 *     "api": "https://git.openvibe.codes",
 *     "tokenFile": "~/.config/openvibe/git-ci.token",
 *     "workRoot": "~/.cache/openvibe-git-ci",
 *     "engine": "auto",                         // auto | podman | bwrap
 *     "concurrency": 1,
 *     "pollMs": 5000,
 *     "proxyAllow": ["registry.npmjs.org", "codeload.github.com"],
 *     "repos": {
 *       "openvibers/openvibe.shared": {
 *         "install_command": "npm ci --no-audit --no-fund",
 *         "test_command": "npm test",
 *         "timeout_seconds": 1800
 *       }
 *     }
 *   }
 *
 * The token file holds the raw runner token (0600); the service holds only its scrypt hash in
 * deploy/ci/runner-token. The config holds no secret.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const expand = (value) => String(value || '').replace(/^~(?=$|\/)/, HOME);
const int = (value, fallback, min, max) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

function loadConfig(env = process.env) {
    const file = expand(env.GIT_CI_CONFIG || path.join(HOME, '.config', 'openvibe', 'git-ci.json'));
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
        if (env.GIT_CI_CONFIG) throw new Error(`the runner configuration ${file} cannot be read: ${err.message}`);
    }
    const tokenFile = expand(raw.tokenFile || env.GIT_CI_TOKEN_FILE || path.join(HOME, '.config', 'openvibe', 'git-ci.token'));
    let token = String(env.GIT_CI_RUNNER_TOKEN || '').trim();
    if (!token) {
        try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { /* reported below */ }
    }
    const cfg = {
        file,
        api: String(raw.api || env.GIT_CI_API || 'https://git.openvibe.codes').replace(/\/+$/, ''),
        token,
        tokenFile,
        workRoot: expand(raw.workRoot || path.join(HOME, '.local', 'share', 'openvibe-git-ci', 'work')),
        stateFile: expand(raw.stateFile || path.join(HOME, '.local', 'share', 'openvibe-git-ci', 'runner.json')),
        // The workstation's shared podman store is on a disk with no inodes left; the runner's own store is on
        // the home filesystem. Both are passed to every podman call, never changed globally.
        podmanRoot: expand(raw.podmanRoot || path.join(HOME, '.local', 'share', 'openvibe-git-ci', 'containers', 'storage')),
        podmanRunRoot: expand(raw.podmanRunRoot || `/run/user/${process.getuid()}/ovci`),
        podmanConf: expand(raw.podmanConf || path.join(HOME, '.config', 'openvibe', 'containers.conf')),
        podmanStorageConf: expand(raw.podmanStorageConf || path.join(HOME, '.config', 'openvibe', 'containers-storage.conf')),
        engine: ['auto', 'podman', 'bwrap'].includes(raw.engine) ? raw.engine : 'auto',
        image: String(raw.image || 'docker.io/library/node:22-bookworm'),
        concurrency: int(raw.concurrency, 1, 1, 4),
        pollMs: int(raw.pollMs, 5000, 1000, 60_000),
        heartbeatMs: int(raw.heartbeatMs, 15_000, 2000, 60_000),
        proxyAllow: Array.isArray(raw.proxyAllow) && raw.proxyAllow.length
            ? raw.proxyAllow.map((h) => String(h).toLowerCase()).filter(Boolean)
            : ['registry.npmjs.org', 'codeload.github.com'],
        repos: raw.repos && typeof raw.repos === 'object' ? raw.repos : {},
    };
    cfg.repos = Object.fromEntries(Object.entries(cfg.repos).map(([full, item]) => [
        String(full).toLowerCase(),
        {
            install_command: String((item && item.install_command) || 'npm ci --no-audit --no-fund'),
            test_command: String((item && item.test_command) || 'npm test'),
            timeout_seconds: int(item && item.timeout_seconds, 1800, 30, 3600),
            image: String((item && item.image) || cfg.image),
            cpus: int(item && item.cpus, 4, 1, 8),
            memory_mb: int(item && item.memory_mb, 6144, 512, 12288),
        },
    ]));
    if (!cfg.token) throw new Error(`no runner token: write it to ${tokenFile} (0600) or set GIT_CI_RUNNER_TOKEN`);
    if (!cfg.api.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(cfg.api)) {
        throw new Error('the API must be https (or loopback http for a test)');
    }
    return cfg;
}

/** What the runner registers with the forge: one object per configured repository. */
function registrations(cfg) {
    return Object.entries(cfg.repos).map(([full_name, item]) => ({ full_name, ...item }));
}

module.exports = { loadConfig, registrations, expand };
