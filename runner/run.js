'use strict';

/**
 * One claimed run: clone the pushed commit from the forge, install dependencies in a sandbox whose only network
 * is the allowlisted proxy, then run the tests in a sandbox with no network at all. The log streams to the forge
 * while it runs; the verdict goes back with the duration. A superseded run is killed at the next heartbeat and
 * reports nothing (the newer run owns the status).
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { createProxy } = require('./proxy');
const { runProcess } = require('./process');
const { podmanArgs, bwrapArgs, bwrapScope, installScript, podmanCleanup, scopeCleanup, detectEngine, RELAY } = require('./sandbox');
const { reportGithubStatus } = require('./github-status');
const { createDepsCache, cacheKey, survey, installed, autoCommands, lockfilesIn } = require('./deps-cache');
const security = require('./security');



const git = (args, cwd, timeoutMs = 180_000) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' } }, (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
        else resolve(String(stdout));
    });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// test:pg's phase: the repository's own service script, local binaries (no Docker in the sandbox), then the suite.
const TEST_PG_SCRIPT = [
    'S=node_modules/openvibe-sdk/scripts/test-services.sh',
    '[ -f "$S" ] || { echo "test:pg: no $S"; exit 98; }',
    'export OV_TEST_SERVICES=local',
    'ENVS=$(bash "$S" up) || { echo "test:pg: the services did not start"; exit 97; }',
    'eval "$ENVS"',
    'npm run test:pg',
].join('\n');

const size = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);
const words = (ms) => {
    const s = Math.max(0, Math.round(Number(ms) / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

/** Clone exactly the pushed commit; the mirror may be a few seconds behind the webhook, so retry. */
async function cloneAt({ dir, cloneUrl, sha, branch, log, attempts = 24, waitMs = 5000 }) {
    fs.mkdirSync(dir, { recursive: true });
    await git(['init', '--quiet'], dir);
    await git(['remote', 'add', 'origin', cloneUrl], dir);
    let last = null;
    for (let i = 0; i < attempts; i += 1) {
        try {
            await git(['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', sha], dir);
        } catch (err) {
            last = err;
            try {
                await git(['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], dir);
            } catch (err2) { last = err2; }
        }
        try {
            await git(['cat-file', '-e', `${sha}^{commit}`], dir, 20_000);
            await git(['checkout', '--quiet', '--detach', sha], dir);
            return sha;
        } catch (err) {
            last = err;
            if (i < attempts - 1) {
                log(`the pushed commit is not in the mirror yet (${i + 1}/${attempts}); waiting for the sync`);
                await wait(waitMs);
            }
        }
    }
    throw new Error(`the pushed commit never reached the mirror: ${last ? last.message : sha}`);
}

/** Whether this run runs test:pg: the repository has the script, and testPg is 'all', or 'main' on its default branch. */
function wantsTestPg(runDir, run, job, mode) {
    if (!mode || mode === 'off') return false;
    if (mode === 'main' && run.branch !== ((job.repo && job.repo.default_branch) || 'main')) return false;
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(runDir, 'package.json'), 'utf8'));
        return !!(pkg.scripts && pkg.scripts['test:pg']);
    } catch { return false; }
}

function createRunner({ cfg, api, log = console, clock = Date.now }) {
    const say = typeof log === 'function' ? log : (...args) => log.log(...args);
    const engine = detectEngine(cfg.engine);
    const rootArgs = engine.kind === 'podman' ? ['--root', cfg.podmanRoot, '--runroot', cfg.podmanRunRoot] : [];
    // Only what podman and systemd-run need: never the runner's token or the rest of the service environment.
    const sandboxEnv = {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
        USER: process.env.USER, LOGNAME: process.env.LOGNAME, LANG: process.env.LANG, TZ: 'UTC',
        CONTAINERS_CONF: cfg.podmanConf, CONTAINERS_STORAGE_CONF: cfg.podmanStorageConf,
    };
    if (engine.kind === 'podman') {
        const image = spawnSync('podman', [...rootArgs, 'image', 'exists', cfg.image], { encoding: 'utf8', timeout: 20_000 });
        if (image.error || image.status !== 0) say(`[git-ci-runner] image ${cfg.image} is not in ${cfg.podmanRoot}; run deploy/ci/install.sh`);
    }
    say(`[git-ci-runner] sandbox: ${engine.why}; ${Object.keys(cfg.repos).length} repositories configured`);
    const deps = cfg.depsCache ? createDepsCache({ root: cfg.depsCache, maxMb: cfg.depsCacheMb, log: say }) : null;
    if (cfg.sharedCache) for (const sub of ['npm', 'pnpm-store']) fs.mkdirSync(path.join(cfg.sharedCache, sub), { recursive: true, mode: 0o700 });
    const testEnv = cfg.testTimeoutScale > 1 ? { OV_TEST_TIMEOUT_SCALE: String(cfg.testTimeoutScale) } : {};
    // Every phase running now, across the runs this runner holds at once: stop() ends them all.
    const activeKills = new Set();
    let stopping = false;

    async function runJob(job) {
        const started = clock();
        const run = job.run;
        const runDir = path.join(cfg.workRoot, `run-${run.id}`);
        const localLog = path.join(cfg.workRoot, `run-${run.id}.log`);
        fs.rmSync(runDir, { recursive: true, force: true });
        fs.mkdirSync(path.join(runDir, '.ci'), { recursive: true });
        fs.mkdirSync(path.join(runDir, '.home'), { recursive: true });
        fs.mkdirSync(path.join(runDir, '.cache', 'npm'), { recursive: true });
        fs.mkdirSync(path.join(runDir, '.pnpm'), { recursive: true });
        fs.writeFileSync(localLog, '', { mode: 0o600 });

        const limits = job.limits || { timeout_seconds: 1800, cpus: 4, memory_mb: 6144 };
        const totalMs = Math.max(30, Number(limits.timeout_seconds) || 1800) * 1000;
        const deadline = started + totalMs;
        let buffer = '';
        let truncated = false;
        let lastFlush = 0;
        let currentKill = null;
        let superseded = false;
        let proxy = null;

        const appendLocal = (text) => {
            try { fs.appendFileSync(localLog, text); } catch { /* disk */ }
        };
        const flush = async (force = false) => {
            if (!buffer || (!force && clock() - lastFlush < 1000)) return;
            const chunk = buffer;
            buffer = '';
            lastFlush = clock();
            try { await api.log(run.id, chunk); } catch (err) { say(`[git-ci-runner] log not sent: ${err.message}`); }
        };
        const onData = (data) => {
            const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
            appendLocal(text);
            if (truncated) return;
            buffer += text;
            if (Buffer.byteLength(buffer) > 256 * 1024) buffer = buffer.slice(-192 * 1024);
            if (buffer.length > 512 * 1024) { buffer = `${buffer.slice(0, 256 * 1024)}\n[output truncated]\n`; truncated = true; }
        };

        const heartbeat = setInterval(() => {
            api.heartbeat(run.id).then((out) => {
                if (out && out.superseded && !superseded) {
                    superseded = true;
                    say(`[git-ci-runner] ${run.id} was superseded; stopping it`);
                    if (currentKill) currentKill();
                }
            }).catch((err) => say(`[git-ci-runner] heartbeat: ${err.message}`));
        }, cfg.heartbeatMs);

        const sandbox = (phase, command, proxySock) => {
            const name = `ov-ci-${run.id.replace(/[^A-Za-z0-9_.-]/g, '')}-${phase}`;
            if (engine.kind === 'podman') {
                return {
                    command: 'podman',
                    args: [...rootArgs, ...podmanArgs({ name, workspace: runDir, image: job.image, limits, proxySock, sharedCache: cfg.sharedCache || null, testEnv, roBinds: cfg.roBinds, script: command })],
                    kill: () => podmanCleanup(name, rootArgs),
                };
            }
            const wrapped = bwrapScope({ name, limits, args: bwrapArgs({ workspace: runDir, limits, proxySock, sharedCache: cfg.sharedCache || null, testEnv, roBinds: cfg.roBinds, script: command }).args });
            return { command: wrapped.command, args: wrapped.args, kill: () => scopeCleanup(wrapped.killUnit) };
        };

        const phase = async (label, script, proxySock) => {
            const left = deadline - clock();
            if (left < 5000) return { timedOut: true, code: null, skipped: true };
            const box = sandbox(label, script, proxySock);
            say(`[git-ci-runner] ${run.id} ${label}`);
            const kill = () => box.kill();
            activeKills.add(kill);
            currentKill = kill;
            const res = await runProcess({
                command: box.command, args: box.args, env: sandboxEnv, timeoutMs: left,
                onData,
                onKill: () => { box.kill(); },
            });
            activeKills.delete(kill);
            currentKill = null;
            await flush(true);
            return res;
        };

        let state = null;
        let description = '';
        let exitCode = null;
        try {
            say(`[git-ci-runner] ${run.id} ${job.repo.full_name} ${run.branch} ${run.sha.slice(0, 12)}`);
            await cloneAt({ dir: runDir, cloneUrl: job.repo.clone_url, sha: run.sha, branch: run.branch, log: (line) => onData(`${line}\n`) });

            // `auto` (a repository registered without commands): the checkout says how it installs and tests.
            const commands = { install: job.command.install, test: job.command.test };
            if (commands.install === 'auto' || commands.test === 'auto') {
                const auto = autoCommands(runDir);
                if (auto.none) {
                    state = 'success';
                    description = `Nothing to test here (${auto.none})`;
                    onData(`${description}\n`);
                } else {
                    if (commands.install === 'auto') commands.install = auto.install;
                    if (commands.test === 'auto') commands.test = auto.test;
                    onData(`install: ${commands.install}\ntest: ${commands.test}\n`);
                }
            }

            // GitHub's security workflow, here (runner/security.js): what they find fails the run, after the tests ran.
            const problems = [];
            if (!state && cfg.secretScan) {
                const scan = await phase('secrets', installScript(security.secretScanScript(), { proxy: false }), null);
                if (superseded) state = 'superseded';
                else if (scan.code === 0) onData('secret scan: nothing found\n');
                else if (scan.code === 1) {
                    const found = security.readSecretFindings(runDir);
                    if (found.length) {
                        for (const f of found.slice(0, 20)) onData(`secret scan: ${f.rule} at ${f.file}:${f.line} (redacted)\n`);
                        onData('A real secret: rotate it first, then remove it. A proven false positive: a narrow [[allowlists]] entry (path AND value) in .gitleaks.toml.\n');
                        problems.push(`secret scan: ${found.length} finding${found.length === 1 ? '' : 's'}`);
                    } else onData('secret scan: findings only in the runner\'s own folders, ignored\n');
                } else if (scan.code === 3) { /* said so in its own output */ } else onData(`secret scan could not run (exit ${scan.code}); not counted\n`);
            }

            let installMs = 0;
            let fromCache = false;
            if (!state) {
                // The same lockfile as an earlier run: its install comes back from the runner's cache, no install phase.
                const key = deps ? cacheKey({ dir: runDir, repo: job.repo.full_name, install: commands.install, image: job.image, engine: engine.kind }) : null;
                let restored = null;
                if (key) {
                    try { restored = await deps.restore(key, runDir); } catch (err) { onData(`the kept install could not be restored (${err.message}); installing\n`); }
                }
                if (restored) {
                    fromCache = true;
                    installMs = restored.ms;
                    onData(`dependencies: from the runner's cache (${size(restored.bytes)}, saved ${restored.saved_at}) in ${words(restored.ms) === '0s' ? `${restored.ms} ms` : words(restored.ms)}; no install phase\n`);
                } else {
                    const before = key ? survey(runDir) : null;
                    proxy = createProxy({ allow: cfg.proxyAllow, log: { warn: (line) => onData(`${line}\n`) } });
                    const socket = path.join(runDir, '.ci', 'proxy.sock');
                    await proxy.listen(socket);
                    const t0 = clock();
                    const install = await phase('install', installScript(commands.install), socket);
                    installMs = clock() - t0;
                    await proxy.close().catch(() => {});
                    proxy = null;
                    if (superseded) { state = 'superseded'; } else if (install.timedOut) {
                        state = 'timed_out'; description = `Timed out installing dependencies after ${words(totalMs)}`;
                    } else if (install.code !== 0) {
                        state = 'failure'; exitCode = install.code; description = `Dependency install failed (exit ${install.code})`;
                    } else if (key) {
                        // Kept before any test runs, so no test can change what a later run gets.
                        const kept = await deps.save(key, runDir, installed(before, survey(runDir)));
                        if (kept) onData(`dependencies: kept for later runs with this lockfile (${size(kept.bytes)}, ${words(kept.ms)})\n`);
                    }
                }
            }
            const repoConf = cfg.repos[String(job.repo.full_name || '').toLowerCase()] || {};
            const auditLevel = repoConf.audit_fail_level || 'critical';
            if (!state && cfg.audit && auditLevel !== 'none') {
                const locks = lockfilesIn(runDir);
                if (locks.length) {
                    proxy = createProxy({ allow: cfg.proxyAllow, log: { warn: (line) => onData(`${line}\n`) } });
                    const socket = path.join(runDir, '.ci', 'proxy.sock');
                    await proxy.listen(socket);
                    await phase('audit', installScript(security.auditScript(locks)), socket);
                    await proxy.close().catch(() => {});
                    proxy = null;
                    if (superseded) state = 'superseded';
                    const results = security.readAuditCounts(runDir, locks);
                    for (const r of results) {
                        onData(r.counts
                            ? `audit ${r.lockfile}: ${security.LEVELS.map((l) => `${r.counts[l]} ${l}`).join(', ')}\n`
                            : `audit ${r.lockfile}: no answer (the registry unreachable?); nothing was checked\n`);
                    }
                    const failing = security.auditFailures(results, auditLevel);
                    if (failing.length) problems.push(`dependency audit (${auditLevel}): ${failing.join('; ')}`.slice(0, 300));
                }
            }
            if (!state) {
                const t1 = clock();
                const test = await phase('test', installScript(commands.test, { proxy: false }), null);
                const testMs = clock() - t1;
                // The suite again on PostgreSQL + PgBouncer + Valkey (the repository's test:pg), started inside the sandbox
                // by its own openvibe-sdk test-services.sh from the host's packages: what PGlite cannot show (a pooled
                // connection runs un-awaited work out of order). On the runs testPg says (main: after a merge).
                let pgNote = '';
                if (!superseded && !test.timedOut && test.code === 0 && wantsTestPg(runDir, run, job, cfg.testPg)) {
                    const t2 = clock();
                    const pg = await phase('test-pg', installScript(TEST_PG_SCRIPT, { proxy: false }), null);
                    const pgMs = clock() - t2;
                    if (pg.timedOut) problems.push(`test:pg timed out after ${words(pgMs)}`);
                    else if (pg.code === 0) pgNote = `, test:pg ${words(pgMs)}`;
                    else if (pg.code === 98) onData('test:pg: no openvibe-sdk test-services.sh in this checkout; skipped\n');
                    else if (pg.code === 97) onData('test:pg: the local PostgreSQL, PgBouncer and Valkey did not start on this runner; not counted\n');
                    else problems.push(`test:pg failed (exit ${pg.code})`);
                }
                const timing = `install ${words(installMs)}${fromCache ? ' from the cache' : ''}, tests ${words(testMs)}${pgNote}`;
                if (superseded) state = 'superseded';
                else if (test.timedOut) { state = 'timed_out'; description = `Timed out after ${words(totalMs)}`; }
                else if (test.code === 0 && !problems.length) { state = 'success'; description = `Forge runner passed in ${words(clock() - started)} (${timing})`; }
                else if (test.code === 0) { state = 'failure'; exitCode = 1; description = `Forge runner failed: ${problems.join('; ')} (tests passed; ${timing})`; }
                else { state = 'failure'; exitCode = test.code; description = `Forge runner failed (exit ${test.code}) in ${words(clock() - started)} (${timing})${problems.length ? `; also ${problems.join('; ')}` : ''}`; }
            }
        } catch (err) {
            if (superseded) state = 'superseded';
            else { state = 'error'; description = String(err.message || err).slice(0, 500); onData(`\n${err.message}\n`); }
        } finally {
            clearInterval(heartbeat);
            if (proxy) await proxy.close().catch(() => {});
            await flush(true);
        }

        if (stopping) { state = 'error'; description = 'The runner stopped before the run finished'; }
        const duration = clock() - started;
        if (state !== 'superseded') {
            let finished = null;
            try {
                const out = await api.finish(run.id, { state, description, exit_code: exitCode, duration_ms: duration });
                finished = out && out.run ? out.run : null;
            } catch (err) {
                say(`[git-ci-runner] ${run.id} verdict not sent (${state}): ${err.message}`);
            }
            // Only a verdict the forge accepted is repeated on GitHub: the forge's status is the source of truth.
            if (finished) {
                const targetUrl = finished.url || `${cfg.api}/${String(job.repo.full_name).toLowerCase()}/ci/${run.id}`;
                await reportGithubStatus({ cfg, job, state, description, targetUrl, log: (line) => say(line) });
            }
        }
        fs.rmSync(runDir, { recursive: true, force: true });
        return { state, duration };
    }

    function stop() {
        stopping = true;
        for (const kill of activeKills) { try { kill(); } catch { /* gone */ } }
    }

    return { engine, runJob, stop };
}

module.exports = { createRunner, cloneAt, RELAY, wantsTestPg, TEST_PG_SCRIPT };
