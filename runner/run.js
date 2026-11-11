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



const git = (args, cwd, timeoutMs = 180_000) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' } }, (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
        else resolve(String(stdout));
    });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
    let activeKill = null;
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
                    args: [...rootArgs, ...podmanArgs({ name, workspace: runDir, image: job.image, limits, proxySock, script: command })],
                    kill: () => podmanCleanup(name, rootArgs),
                };
            }
            const wrapped = bwrapScope({ name, limits, args: bwrapArgs({ workspace: runDir, limits, proxySock, script: command }).args });
            return { command: wrapped.command, args: wrapped.args, kill: () => scopeCleanup(wrapped.killUnit) };
        };

        const phase = async (label, script, proxySock) => {
            const left = deadline - clock();
            if (left < 5000) return { timedOut: true, code: null, skipped: true };
            const box = sandbox(label, script, proxySock);
            say(`[git-ci-runner] ${run.id} ${label}`);
            activeKill = () => box.kill();
            const res = await runProcess({
                command: box.command, args: box.args, env: sandboxEnv, timeoutMs: left,
                onData,
                onKill: () => { box.kill(); },
            });
            activeKill = null;
            await flush(true);
            return res;
        };

        let state = null;
        let description = '';
        let exitCode = null;
        try {
            say(`[git-ci-runner] ${run.id} ${job.repo.full_name} ${run.branch} ${run.sha.slice(0, 12)}`);
            await cloneAt({ dir: runDir, cloneUrl: job.repo.clone_url, sha: run.sha, branch: run.branch, log: (line) => onData(`${line}\n`) });

            proxy = createProxy({ allow: cfg.proxyAllow, log: { warn: (line) => onData(`${line}\n`) } });
            const socket = path.join(runDir, '.ci', 'proxy.sock');
            await proxy.listen(socket);
            const install = await phase('install', installScript(job.command.install), socket);
            if (superseded) { state = 'superseded'; } else if (install.timedOut) {
                state = 'timed_out'; description = `Timed out installing dependencies after ${words(totalMs)}`;
            } else if (install.code !== 0) {
                state = 'failure'; exitCode = install.code; description = `Dependency install failed (exit ${install.code})`;
            } else {
                const test = await phase('test', installScript(job.command.test, { proxy: false }), null);
                if (superseded) state = 'superseded';
                else if (test.timedOut) { state = 'timed_out'; description = `Timed out after ${words(totalMs)}`; }
                else if (test.code === 0) { state = 'success'; description = `Forge runner passed in ${words(clock() - started)}`; }
                else { state = 'failure'; exitCode = test.code; description = `Forge runner failed (exit ${test.code}) in ${words(clock() - started)}`; }
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
            try {
                await api.finish(run.id, { state, description, exit_code: exitCode, duration_ms: duration });
            } catch (err) {
                say(`[git-ci-runner] ${run.id} verdict not sent (${state}): ${err.message}`);
            }
        }
        fs.rmSync(runDir, { recursive: true, force: true });
        return { state, duration };
    }

    function stop() {
        stopping = true;
        if (activeKill) { try { activeKill(); } catch { /* gone */ } }
    }

    return { engine, runJob, stop };
}

module.exports = { createRunner, cloneAt, RELAY };
