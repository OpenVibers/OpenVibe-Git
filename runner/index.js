'use strict';

/**
 * The forge CI runner. It polls OpenVibe.Git for the next queued run, executes it in the sandbox (runner/run.js) and
 * reports the log and the verdict. `concurrency` workers claim runs side by side (the shared node runs 3; the forge
 * keeps one live run per repository, so they are always different repositories); the forge decides what is queued and
 * supersedes, so the runner never chooses or trusts a repository itself.
 *
 *   node runner/index.js
 *   GIT_CI_CONFIG=... GIT_CI_RUNNER_TOKEN=... node runner/index.js
 */
const fs = require('node:fs');
const os = require('node:os');
const { loadConfig, registrations } = require('./config');
const { createApi } = require('./api');
const { createRunner } = require('./run');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// tmpfs: the work directories are in memory, so an install's tens of thousands of files never touch the disk.
const TMPFS_MAGIC = 0x01021994;
const inMemory = (dir) => {
    try { return fs.statfsSync(dir).type === TMPFS_MAGIC; } catch { return false; }
};

async function main(env = process.env) {
    const cfg = loadConfig(env);
    fs.mkdirSync(cfg.workRoot, { recursive: true });
    const api = createApi({ baseUrl: cfg.api, token: cfg.token });
    const runner = createRunner({ cfg, api });
    const repos = registrations(cfg);
    let stopping = false;
    const onSignal = (signal) => {
        process.stdout.write(`[git-ci-runner] ${signal}: stopping the current runs\n`);
        stopping = true;
        runner.stop();
    };
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    process.on('SIGINT', () => onSignal('SIGINT'));

    // Register the repositories this runner is configured for. The forge refuses anything not official.
    for (let i = 0; !stopping; i += 1) {
        try {
            const out = await api.register(repos);
            process.stdout.write(`[git-ci-runner] registered ${out.repositories.length} repositories with ${cfg.api}\n`);
            break;
        } catch (err) {
            const seconds = Math.min(60, 5 * (i + 1));
            process.stdout.write(`[git-ci-runner] registration failed (${err.message}); retrying in ${seconds}s\n`);
            await wait(seconds * 1000);
        }
    }
    if (!stopping && !repos.length) process.stdout.write('[git-ci-runner] no repositories configured; only claiming nothing\n');

    process.stdout.write(`[git-ci-runner] ${cfg.concurrency} worker${cfg.concurrency === 1 ? '' : 's'}; work directories ${inMemory(cfg.workRoot) ? 'in memory (tmpfs)' : 'on disk'}\n`);
    let lastEmpty = 0;
    const worker = async (slot) => {
        const name = cfg.concurrency > 1 ? `${os.hostname()}/${slot}` : os.hostname();
        // Spread the first claims so the workers do not ask the forge in the same instant.
        await wait((slot - 1) * Math.round(cfg.pollMs / cfg.concurrency));
        while (!stopping) {
            try {
                const job = await api.claim(name);
                if (!job) {
                    if (slot === 1 && Date.now() - lastEmpty > 60_000) {
                        process.stdout.write(`[git-ci-runner] idle on ${os.hostname()} (${cfg.api})\n`);
                        lastEmpty = Date.now();
                    }
                    await wait(cfg.pollMs);
                    continue;
                }
                lastEmpty = Date.now();
                const out = await runner.runJob(job);
                process.stdout.write(`[git-ci-runner] ${name} ${job.run.id} ${out.state} in ${Math.round(out.duration / 1000)}s\n`);
            } catch (err) {
                process.stdout.write(`[git-ci-runner] ${name} loop: ${err.message}\n`);
                await wait(Math.max(cfg.pollMs, 5000));
            }
        }
    };
    await Promise.all(Array.from({ length: cfg.concurrency }, (_, i) => worker(i + 1)));
    process.stdout.write('[git-ci-runner] stopped\n');
}

if (require.main === module) {
    main().catch((err) => {
        process.stderr.write(`[git-ci-runner] failed: ${err.message}\n`);
        process.exit(1);
    });
}

module.exports = { main };
