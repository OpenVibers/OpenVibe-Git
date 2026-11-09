'use strict';

/**
 * OpenVibe.Git — process entry. `node server/index.js` listens on PORT (5270) behind nginx (deploy/), starts the
 * mirror poll and the due-based official mirrors seed, and stops in order on SIGTERM: the HTTP drain, the timers,
 * the cat-file processes, the database.
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const { catFiles } = require('./git/store');

function createLifecycle({ server, exit, signals, ctx } = {}) {
    const mirrors = ctx && ctx.mirrors;
    const official = ctx && ctx.official;
    const store = ctx && ctx.store;
    return gracefulStop({
        name: 'OpenVibe.Git',
        server,
        deadlineExitCode: 0,
        exit,
        signals,
        deadlineMs: 10_000,
        stop: [() => (mirrors ? mirrors.stop() : undefined), () => (official ? official.stop() : undefined)],
        close: [() => catFiles.close(), () => (store ? store.close() : undefined)],
    });
}

async function start() {
    const { app, ctx, release } = await createApp();
    const { config } = ctx;
    if (config.mirrors.pollMs) ctx.mirrors.start();
    // Due-based and off unless GIT_OFFICIAL_ORG is set: the first check is shortly after boot, never in this path.
    ctx.official.start();
    const server = app.listen(config.port, config.host, () => {
        console.log(`[OpenVibe.Git] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (release ${release.release})`);
    });
    server.keepAliveTimeout = 65_000;
    createLifecycle({ server, ctx });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => {
        console.error('[OpenVibe.Git] failed to start:', err);
        process.exit(1);
    });
}

module.exports = { start, createLifecycle };
