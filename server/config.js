'use strict';

/**
 * OpenVibe.Git configuration (git.openvibe.codes). Every value comes from the environment (production:
 * /etc/openvibe/git.env, see .env.example). load(env) is pure so tests build a config without touching
 * process.env. Secrets are never logged.
 */
require('dotenv').config();

const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
const bool = (v, def = false) => (v == null || v === '' ? def : !/^(0|false|no|off)$/i.test(String(v)));
const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 5270);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://git.openvibe.codes' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');
    const officialOwners = list(env.GIT_OFFICIAL_OWNERS || 'openvibers').map((o) => o.toLowerCase());

    return {
        service: 'git',
        name: 'OpenVibe.Git',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        drill: bool(env.GIT_DRILL),

        // PostgreSQL (ADR-035). Development without DATABASE_URL uses an embedded PGlite database.
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.GIT_PGLITE_DIR || '' },

        // The bare repositories (server/paths.js) and the per-push caps.
        data: {
            dir: env.GIT_DATA_DIR || env.DATA_DIR || '',
            maxPushBytes: int(env.GIT_MAX_PUSH_BYTES, 512 * 1024 * 1024),
            maxRepoBytes: int(env.GIT_MAX_REPO_BYTES, 3 * 1024 * 1024 * 1024),
            maxFileBytes: int(env.GIT_MAX_FILE_BYTES, 2 * 1024 * 1024),
        },

        // OpenVibe.Network: SSO (OAuth2 + PKCE), the JWKS for typed git tokens, and the account events.
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        jwksUrl: `${trim(env.OV_NETWORK_JWKS_URL || env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000')}/api/.well-known/jwks`,
        audience: env.GIT_AUDIENCE || 'openvibe.git',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'git',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },
        events: { secrets: list(env.GIT_EVENTS_SECRET) },

        // GitHub: the card and mirror metadata (public API), the push webhook, the push mirror.
        github: {
            apiUrl: trim(env.GIT_GITHUB_API_URL || 'https://api.github.com'),
            token: env.GIT_GITHUB_TOKEN || '',
            webhookSecret: env.GIT_GITHUB_WEBHOOK_SECRET || '',
            pushToken: env.GIT_GITHUB_PUSH_TOKEN || '',
            cacheMs: Math.max(60_000, int(env.GIT_GITHUB_CACHE_MS, 10 * 60_000)),
        },

        // Clone tokens (opaque, hashed at rest) and the key that seals a stored push-mirror token.
        tokens: {
            ttlHours: Math.max(1, Math.min(24 * 30, int(env.GIT_TOKEN_TTL_HOURS, 1))),
            secretKey: env.GIT_SECRET_KEY || (isProduction ? '' : 'development-only-git-secret-key-0123456789'),
        },

        // The mirror poll and one fetch's cap.
        mirrors: {
            pollMs: Math.max(60_000, int(env.GIT_MIRROR_POLL_MS, 10 * 60_000)),
            timeoutMs: Math.max(30_000, int(env.GIT_MIRROR_TIMEOUT_MS, 10 * 60_000)),
            maxBytes: int(env.GIT_MIRROR_MAX_BYTES, 3 * 1024 * 1024 * 1024),
        },

        // Repositories under these owners are "official" (the OpenVibers projects).
        officialOwners,

        // The official mirrors seed (server/official.js): the GitHub organisation to mirror, the OpenVibe owner
        // the mirrors are created under, how often a run is due and how many clones may run at once. An empty
        // GIT_OFFICIAL_ORG turns it off.
        official: {
            org: trim(env.GIT_OFFICIAL_ORG || ''),
            owner: String(env.GIT_OFFICIAL_OWNER || officialOwners[0] || 'openvibers').trim().toLowerCase(),
            syncMs: Math.max(60_000, int(env.GIT_OFFICIAL_SYNC_MS, 6 * 60 * 60 * 1000)),
            concurrency: Math.max(1, Math.min(8, int(env.GIT_OFFICIAL_CONCURRENCY, 3))),
        },

        apiRateLimitPerMinute: Math.max(1, int(env.GIT_API_RATE_LIMIT_PER_MIN, 180)),
        pageRateLimitPerMinute: Math.max(1, int(env.GIT_PAGE_RATE_LIMIT_PER_MIN, 300)),
    };
}

module.exports = { load };
