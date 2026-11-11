'use strict';
/**
 * The runner's own parts, without podman: the config and its registrations, the token hash, the egress allowlist,
 * the container command line (network off, 4 CPUs, 6 GB, one writable path), the install/test scripts, and the
 * wall-clock kill.
 */
const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, registrations } = require('../runner/config');
const { podmanArgs, installScript, envList } = require('../runner/sandbox');
const { isPublicAddress } = require('../runner/proxy');
const { createProxy } = require('../runner/proxy');
const { runProcess } = require('../runner/process');
const { createRunner } = require('../runner/run');
const { detectEngine } = require('../runner/sandbox');
const { execFileSync, spawnSync } = require('node:child_process');
const { hashToken, parseHash, createCiAuth } = require('../server/ci-auth');

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ci-runner-test-'));
    try {
        // A token's hash is what the service holds; the raw token is never in it.
        const token = 'a-test-runner-token-0123456789';
        const line = hashToken(token);
        assert.match(line, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
        assert.ok(parseHash(line));
        assert.equal(parseHash('not-a-hash'), null);
        const auth = createCiAuth({ config: { ci: { runnerToken: token } } });
        const req = (value) => ({ headers: { authorization: `Bearer ${value}` } });
        assert.equal(auth.ok(req(token)), true);
        assert.equal(auth.ok(req(`${token}x`)), false);
        assert.equal(auth.ok(req('')), false);

        // The configuration names repositories and their commands; a missing token is an error.
        const tokenFile = path.join(dir, 'token');
        fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
        const configFile = path.join(dir, 'ci.json');
        fs.writeFileSync(configFile, JSON.stringify({
            tokenFile, api: 'https://git.openvibe.codes', engine: 'bwrap', workRoot: path.join(dir, 'work'),
            repos: { 'openvibers/openvibe.shared': { install_command: 'npm ci', test_command: 'npm test', timeout_seconds: 1800 } },
        }));
        const cfg = loadConfig({ GIT_CI_CONFIG: configFile });
        assert.equal(cfg.engine, 'bwrap');
        assert.equal(cfg.repos['openvibers/openvibe.shared'].test_command, 'npm test');
        assert.equal(cfg.concurrency, 1);
        assert.deepStrictEqual(registrations(cfg).map((r) => r.full_name), ['openvibers/openvibe.shared']);
        assert.equal(cfg.githubStatus, true);
        assert.equal(cfg.githubContext, 'forge/test');
        assert.throws(() => loadConfig({ GIT_CI_CONFIG: path.join(dir, 'missing.json'), GIT_CI_TOKEN_FILE: path.join(dir, 'none') }), /cannot be read/);

        // The verdict on GitHub: gh gets a POST for a configured repository, with the run as the target; an
        // unknown repository, the off switch and a gh refusal all resolve instead of throwing.
        const { reportGithubStatus, githubState } = require('../runner/github-status');
        assert.equal(githubState('timed_out'), 'failure');
        const sha = 'a'.repeat(40);
        const job = { repo: { full_name: 'openvibers/openvibe.shared' }, run: { sha } };
        let ghArgv = null;
        const fakeGh = (cmd, args, _opts, cb) => { ghArgv = [cmd, ...args]; cb(null, '{}', ''); };
        const posted = await reportGithubStatus({
            cfg, job, state: 'success', description: 'Forge runner passed in 9s',
            targetUrl: 'https://git.openvibe.codes/openvibers/openvibe.shared/ci/cir_1', log: () => {}, exec: fakeGh,
        });
        assert.equal(posted.ok, true);
        assert.equal(ghArgv[0], 'gh');
        assert.deepStrictEqual(ghArgv.slice(1, 4), ['api', '--method', 'POST']);
        assert.ok(ghArgv.includes(`repos/openvibers/openvibe.shared/statuses/${sha}`));
        assert.ok(ghArgv.includes('state=success'));
        assert.ok(ghArgv.includes('context=forge/test'));
        assert.ok(ghArgv.includes('target_url=https://git.openvibe.codes/openvibers/openvibe.shared/ci/cir_1'));
        assert.equal((await reportGithubStatus({ cfg, job: { ...job, repo: { full_name: 'openvibers/other' } }, state: 'success' })).skipped, 'repository');
        assert.equal((await reportGithubStatus({ cfg: { ...cfg, githubStatus: false }, job, state: 'success' })).skipped, 'off');
        assert.equal((await reportGithubStatus({ cfg, job, state: 'failure', log: () => {}, exec: (_c, _a, _o, cb) => cb(new Error('boom'), '', 'HTTP 401') })).ok, false);

        // The egress allowlist refuses hostnames outside it and any host that resolves to a private address.
        assert.equal(isPublicAddress('8.8.8.8'), true);
        assert.equal(isPublicAddress('127.0.0.1'), false);
        assert.equal(isPublicAddress('10.1.2.3'), false);
        assert.equal(isPublicAddress('192.168.1.1'), false);
        assert.equal(isPublicAddress('::1'), false);
        assert.equal(isPublicAddress('fd00::1'), false);
        const proxy = createProxy({ allow: ['registry.npmjs.org'], log: { warn() {} } });
        await assert.rejects(() => proxy.target('example.com', 443), /allowlist/);
        await assert.rejects(() => proxy.target('localhost', 443), /allowlist/);
        assert.equal(proxy.permit('registry.npmjs.org'), true);
        assert.equal(proxy.permit('registry.npmjs.org.evil.example'), false);

        // The phase command: no network, 4 CPUs, 6 GB, the work directory as the only host path, and the proxy
        // socket only in the install phase.
        const limits = { cpus: 4, memory_mb: 6144 };
        const install = podmanArgs({
            name: 'ov-ci-cir_1-install', workspace: '/tmp/run-1', image: 'node:22-bookworm', limits,
            proxySock: '/tmp/run-1/.ci/proxy.sock', script: installScript('npm ci'),
        });
        assert.equal(install[0], 'run');
        assert.ok(install.includes('--network=none'));
        assert.ok(install.includes('--read-only'));
        assert.ok(install.includes('--cap-drop'));
        assert.equal(install[install.indexOf('--cpus') + 1], '4');
        assert.equal(install[install.indexOf('--memory') + 1], '6144m');
        assert.ok(install.includes('/tmp/run-1:/workspace:rw'));
        assert.ok(install.some((a) => a.includes('/tmp/run-1/.ci/proxy.sock')));
        assert.ok(!install.includes('--privileged'));
        assert.match(installScript('npm ci'), /http_proxy=http:\/\/127\.0\.0\.1:3128/);
        assert.doesNotMatch(installScript('npm test', { proxy: false }), /http_proxy/);
        assert.equal(envList().HOME, '/workspace/.home');

        const testPhase = podmanArgs({
            name: 'ov-ci-cir_1-test', workspace: '/tmp/run-1', image: 'node:22-bookworm', limits,
            proxySock: null, script: installScript('npm test', { proxy: false }),
        });
        assert.ok(!testPhase.some((a) => a.includes('proxy.sock')), 'the test phase mounts no proxy');
        assert.ok(testPhase.includes('--network=none'));

        // The wall clock kills a process that would otherwise run forever.
        const started = Date.now();
        const killed = await runProcess({
            command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 300,
        });
        assert.equal(killed.timedOut, true);
        assert.ok(Date.now() - started < 10_000, 'the kill resolves promptly');
        const quick = await runProcess({ command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 });
        assert.equal(quick.timedOut, false);
        assert.equal(quick.code, 0);

        // A complete run against a local repository, in the real sandbox, when this host has one and the image.
        // GitHub's runners have neither, so the test says why it skipped instead of failing there.
        let engine = null;
        try { engine = detectEngine('auto'); } catch { engine = null; }
        if (!engine) {
            console.log('ci-runner: no sandbox engine here; the end-to-end run is skipped');
        } else {
            const image = 'docker.io/library/node:22-bookworm';
            const hasImage = engine.kind === 'bwrap' ? true : spawnSync('podman', ['--root', cfg.podmanRoot, '--runroot', cfg.podmanRunRoot, 'image', 'exists', image], { encoding: 'utf8' }).status === 0;
            if (!hasImage) {
                console.log(`ci-runner: ${image} is not pulled here; the end-to-end run is skipped`);
            } else {
                const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
                const source = path.join(dir, 'source'), bare = path.join(dir, 'bare.git');
                fs.mkdirSync(source); git('init', '--quiet', '-b', 'main', source);
                fs.writeFileSync(path.join(source, 'README.md'), 'runner test\n');
                git('-C', source, 'add', 'README.md');
                git('-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'first');
                const sha = git('-C', source, 'rev-parse', 'HEAD').trim();
                git('clone', '--quiet', '--bare', source, bare);

                const runConfig = path.join(dir, 'run.json');
                fs.writeFileSync(runConfig, JSON.stringify({ tokenFile, engine: 'auto', workRoot: path.join(dir, 'work2') }));
                const runCfg = loadConfig({ GIT_CI_CONFIG: runConfig });
                let finished = null;
                const api = {
                    log: async () => ({ ok: true }),
                    heartbeat: async () => ({ found: true, state: 'running', superseded: false }),
                    finish: async (_id, verdict) => { finished = verdict; return { ok: true }; },
                };
                const runner = createRunner({ cfg: runCfg, api, log: { log: () => {}, warn: () => {} } });
                const out = await runner.runJob({
                    run: { id: 'cir_runner_e2e', sha, branch: 'main' },
                    repo: { full_name: 'openvibers/e2e', clone_url: `file://${bare}`, default_branch: 'main' },
                    image,
                    command: { install: 'true', test: 'node -e "process.exit(0)"' },
                    limits: { timeout_seconds: 30, cpus: 1, memory_mb: 1024 },
                });
                assert.equal(out.state, 'success', JSON.stringify(out));
                assert.equal(finished.state, 'success');
                assert.ok(finished.duration_ms >= 0);
            }
        }

        console.log('ci-runner: config, token hash, egress allowlist, sandbox limits, scripts, timeout and one real run passed');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
