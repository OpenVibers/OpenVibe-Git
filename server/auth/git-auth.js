'use strict';

/**
 * Who is cloning or pushing. Two kinds of password, both OpenVibe:
 *
 *   1. A Git token made on the repository page: `git_` + 32 random bytes, stored only as a SHA-256 hash,
 *      scoped git.repo.read / git.repo.write, one hour by default. `POST /api/v1/tokens` (signed in) makes one.
 *   2. A typed Network token for audience openvibe.git: `typ`/`purpose` git, `cap` holding git.repo.read or
 *      git.repo.write, sub a person (usr_) or a service (svc:). A service's client-credentials token carries no
 *      `typ`/`purpose`; its `actor_type` and `svc:` subject say it is a service, so it is accepted too.
 *      Verified offline against the Network JWKS.
 *
 * Git sends the token as the Basic password (any username, or the token as the username, as GitHub clients do)
 * or as a Bearer. A public repository's read needs no password at all.
 */
const crypto = require('node:crypto');
const { createJwksClient } = require('openvibe-sdk/auth');

const TOKEN_PREFIX = 'git_';
const SCOPES = Object.freeze(['git.repo.read', 'git.repo.write', 'git.checks.write']);
const USER_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SVC_RE = /^svc:[a-z][a-z0-9-]{1,39}$/;

let jwks = null;
function jwksFor(url) {
    if (!jwks) jwks = createJwksClient(url, { log: null });
    return jwks;
}

const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');
const newToken = () => `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;

/** Make a Git token; the raw value is returned once and never stored. */
async function mintToken(store, { subject, actorType = 'user', scopes = ['git.repo.read'], hours = 1, label = null }) {
    const wanted = [...new Set((Array.isArray(scopes) ? scopes : [scopes]).filter((s) => SCOPES.includes(s)))];
    if (!wanted.length) throw new Error('a token needs git.repo.read, git.repo.write or git.checks.write');
    const raw = newToken();
    const id = store.newId('tok');
    const expiresAt = new Date(store.now() + Math.max(1, Math.min(24 * 30, Number(hours) || 1)) * 3600_000).toISOString();
    await store.execute(
        `INSERT INTO git_tokens (id, subject, actor_type, label, token_hash, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, subject, actorType, label, hashToken(raw), JSON.stringify(wanted), expiresAt],
    );
    return { id, token: raw, scopes: wanted, expires_at: expiresAt, token_type: 'GitToken' };
}

/** The row a presented opaque token names, if it is live. Touches last_used_at at most once a minute. */
async function tokenRow(store, raw) {
    if (!String(raw || '').startsWith(TOKEN_PREFIX)) return null;
    const row = await store.maybe('SELECT * FROM git_tokens WHERE token_hash = ?', [hashToken(raw)]);
    if (!row) return null;
    if (row.revoked_at) return null;
    if (Date.parse(row.expires_at) <= store.now()) return null;
    const last = row.last_used_at ? Date.parse(row.last_used_at) : 0;
    if (store.now() - last > 60_000) {
        await store.execute('UPDATE git_tokens SET last_used_at = now() WHERE id = ?', [row.id]).catch(() => {});
    }
    const scopes = new Set(Array.isArray(row.scopes) ? row.scopes : JSON.parse(row.scopes || '[]'));
    return { subject: row.subject, actor_type: row.actor_type, scopes, token_id: row.id, via: 'token' };
}

function decode(jwt) {
    const parts = String(jwt || '').split('.');
    if (parts.length !== 3) return null;
    try {
        return { header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')), claims: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')), input: `${parts[0]}.${parts[1]}`, sig: Buffer.from(parts[2], 'base64url') };
    } catch { return null; }
}

/**
 * A typed Network token for this audience: RS256, issuer, expiry, aud includes openvibe.git, cap git.repo.read and/or
 * git.repo.write, sub usr_… or svc:…. A service principal's token (client credentials, no typ) counts by its
 * actor_type. Returns the same shape as tokenRow.
 */
async function networkToken(config, raw) {
    const d = decode(raw);
    if (!d || !d.header || d.header.alg !== 'RS256') return null;
    const claims = d.claims || {};
    if (claims.iss !== config.networkIssuer) return null;
    const service = claims.actor_type === 'service' || SVC_RE.test(String(claims.sub || ''));
    if (!service && claims.typ !== 'git' && claims.purpose !== 'git') return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(config.audience)) return null;
    const cap = Array.isArray(claims.cap) ? claims.cap.filter((c) => SCOPES.includes(c)) : [];
    if (!cap.length) return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;
    const subject = String(claims.sub || '');
    if (!USER_RE.test(subject) && !SVC_RE.test(subject)) return null;
    let keys;
    try { keys = await jwksFor(config.jwksUrl).keysForKid(d.header.kid); } catch { return null; }
    const ok = (keys || []).some(({ key }) => { try { return crypto.verify('RSA-SHA256', Buffer.from(d.input), key, d.sig); } catch { return false; } });
    if (!ok) return null;
    return { subject, actor_type: SVC_RE.test(subject) ? 'service' : 'user', scopes: new Set(cap), token_id: claims.jti || null, via: 'network' };
}

function basic(req) {
    const h = String((req.headers && req.headers.authorization) || '');
    if (/^basic /i.test(h)) {
        let decoded = '';
        try { decoded = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8'); } catch { return null; }
        const at = decoded.indexOf(':');
        const user = at >= 0 ? decoded.slice(0, at) : '';
        const pass = at >= 0 ? decoded.slice(at + 1) : '';
        return { user, pass };
    }
    if (/^bearer /i.test(h)) return { user: '', pass: h.slice(7).trim() };
    return null;
}

/** The token a git request presents as its password, or null. */
function presentedToken(req) {
    const b = basic(req);
    if (!b) return null;
    const { user, pass } = b;
    if (pass && pass !== 'x-oauth-basic') return pass;
    if (user && (user.startsWith(TOKEN_PREFIX) || user.split('.').length === 3)) return user;
    return null;
}

/** Resolve a git request's identity: an opaque Git token, a typed Network token, or nothing. */
async function identify(req, { store, config }) {
    const raw = presentedToken(req);
    if (!raw) return null;
    const opaque = await tokenRow(store, raw).catch(() => null);
    if (opaque) return opaque;
    return await networkToken(config, raw).catch(() => null);
}

module.exports = { TOKEN_PREFIX, SCOPES, hashToken, newToken, mintToken, tokenRow, networkToken, identify, presentedToken, basic };
