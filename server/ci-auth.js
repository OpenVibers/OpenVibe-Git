'use strict';

/**
 * The forge runner's own credential. The runner holds one random token; this service holds only a scrypt hash
 * (deploy/ci/runner-token, or GIT_CI_RUNNER_TOKEN for a test). A request presents it as `Authorization: Bearer …`
 * or `X-OV-CI-Token`; the comparison is constant time. An absent or malformed token is refused, never logged.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');

const TOKEN_RE = /^[A-Za-z0-9._~-]{16,200}$/;

/** scrypt$<salt hex>$<hash hex> (what deploy/ci/runner-token holds), or null. */
function parseHash(text) {
    const parts = String(text || '').trim().split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return null;
    if (!/^[0-9a-f]{16,64}$/i.test(parts[1]) || !/^[0-9a-f]{64}$/i.test(parts[2])) return null;
    return { salt: Buffer.from(parts[1], 'hex'), hash: Buffer.from(parts[2], 'hex') };
}

function readHash(file) {
    if (!file) return null;
    try { return parseHash(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** A token's raw value → the scrypt line deploy/ci/runner-token holds. Used by the local setup, never by the service. */
function hashToken(token, { salt = crypto.randomBytes(16) } = {}) {
    const hash = crypto.scryptSync(String(token), salt, 32);
    return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function createCiAuth({ config, log = console } = {}) {
    const ci = (config && config.ci) || {};
    const parsed = ci.runnerToken ? parseHash(hashToken(ci.runnerToken)) : readHash(ci.runnerTokenFile);
    const raw = ci.runnerToken ? String(ci.runnerToken) : '';

    function tokenOf(req) {
        const h = String((req.headers && req.headers.authorization) || '');
        if (/^bearer /i.test(h)) return h.slice(7).trim();
        const named = req.get ? req.get('x-ov-ci-token') : (req.headers && req.headers['x-ov-ci-token']);
        return String(named || '').trim();
    }

    /** The raw token from the request, checked against the stored hash. */
    function ok(req) {
        const token = tokenOf(req);
        if (!TOKEN_RE.test(token)) return false;
        if (raw) {
            const a = Buffer.from(token);
            const b = Buffer.from(raw);
            return a.length === b.length && crypto.timingSafeEqual(a, b);
        }
        if (!parsed) return false;
        const got = crypto.scryptSync(token, parsed.salt, 32);
        return got.length === parsed.hash.length && crypto.timingSafeEqual(got, parsed.hash);
    }

    return { ok, configured: Boolean(raw || parsed), tokenOf };
}

module.exports = { createCiAuth, hashToken, parseHash, TOKEN_RE };
