'use strict';

/**
 * OpenVibe.Git's own PostgreSQL database (ADR-035): migrations/NNNN_*.sql, applied at boot. Production
 * serves through PgBouncer and migrates with the owner role on a direct connection; development without
 * DATABASE_URL uses an embedded PGlite database under data/pglite.
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { ids } = require('openvibe-contracts');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

async function openDb(config, { log = console, registry } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL');
        const dir = config.db.pgliteDir || DEV_PGLITE;
        log.warn(`[OpenVibe.Git] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        const db = createDb({ pglite: dir, service: 'git', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'git-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'git', registry, log });
}

/** `?` → `$1`, `$2`, … (the SDK's raw methods speak PostgreSQL; the code reads like a prepared statement). */
function marks(text) {
    let i = 0;
    return String(text).replace(/\?/g, () => `$${++i}`);
}

function createStore(db, { now = () => Date.now() } = {}) {
    return {
        db,
        now,
        iso: () => new Date(now()).toISOString(),
        newId: (prefix) => `${prefix}_${ids.ulid(now())}`,
        tx: async (fn) => await db.tx((t) => fn(t)),
        // The query methods the service uses: `?` placeholders, in the running transaction when there is one.
        execute: (q, v) => db.exec(typeof q === 'string' ? marks(q) : q, v),
        maybe: (q, v) => db.maybe(typeof q === 'string' ? marks(q) : q, v),
        many: (q, v) => db.many(typeof q === 'string' ? marks(q) : q, v),
        one: (q, v) => db.one(typeof q === 'string' ? marks(q) : q, v),
        value: (q, v) => db.value(typeof q === 'string' ? marks(q) : q, v),
        close: () => db.close(),
    };
}

async function openStore(config, { now, log } = {}) {
    return createStore(await openDb(config, { log }), { now });
}

module.exports = { openDb, openStore, createStore, MIGRATIONS };
