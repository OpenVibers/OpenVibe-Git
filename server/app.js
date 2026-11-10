'use strict';

/**
 * OpenVibe.Git: the Express app factory. server/index.js listens; tests build their own with a temp database and
 * a data directory of their own.
 *
 *   /<owner>/<name>.git/…     git over HTTPS (git http-backend) — mounted before every page
 *   /                         home, explore, new, profiles and repositories (http/pages.js)
 *   /api/v1/*                 the JSON API and the GitHub webhook (http/api.js)
 *   /auth/*                   OpenVibe sign-in (openvibe-sdk/sso, the `git` OAuth client)
 *   /shared/*                 the shared navbar, footer, kit and theme
 *   /api/health, /api/ready, /release.json, /metrics
 */
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const cache = require('openvibe-shared/cache-policy');
const { createSsoClient } = require('openvibe-sdk/sso');

const configLib = require('./config');
const { openStore } = require('./db');
const git = require('./git/store');
const { createGithubClient } = require('./github');
const { createInsights } = require('./insights');
const { createRepos } = require('./repos');
const { createMirrors } = require('./mirror');
const { createChecksIntake } = require('./checks-intake');
const { createOfficialMirrors } = require('./official');
const { createSmartHttp, parseGitPath } = require('./git/http-backend');
const { identify } = require('./auth/git-auth');
const { createApi } = require('./http/api');
const { createPageRoutes } = require('./http/pages');
const { createReviewRoutes } = require('./http/review');
const { createReviews } = require('./reviews');
const { createChecks } = require('./checks');
const { createArchive } = require('./archive');
const { createReviewServices } = require('./review-services');
const { createLinkRelay } = require('./link-relay');
const { createLinkRoutes } = require('./http/link');
const { setRelease } = require('./render/layout');

const VERSION = require('../package.json').version;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp(opts = {}) {
    return (async () => {
        const config = opts.config || configLib.load();
        const log = opts.log || console;
        const fetchImpl = opts.fetchImpl || globalThis.fetch;
        const s = opts.store || await openStore(config, { now: opts.now, log });

        const github = opts.github || createGithubClient({ config, fetchImpl, now: s.now, log, lookup: opts.lookup, guard: opts.guard });
        const insights = opts.insights || createInsights({ store: s, log });
        const repos = opts.repos || createRepos({ store: s, config, git, github, insights, log });
        const mirrors = opts.mirrors || createMirrors({ store: s, repos, config, git, github, log });
        const official = opts.official || createOfficialMirrors({ store: s, repos, config, github, log });
        const smartHttp = opts.smartHttp || createSmartHttp({ config, repos, mirrors, insights, log });
        const sso = opts.sso || createSsoClient({
            site: 'git', baseUrl: config.baseUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
            networkUrl: config.networkUrl, networkInternalUrl: config.networkInternalUrl,
            secureCookies: config.cookies.secure, fetch: fetchImpl, log,
        });
        const ctx = { config, store: s, s, git, github, insights, repos, mirrors, official, smartHttp, sso, log };
        ctx.checks = createChecks({ store: s, log });
        ctx.archive = createArchive({ config, git });
        ctx.checksIntake = opts.checksIntake || createChecksIntake({ store: s, checks: ctx.checks, config, git, github, log });
        ctx.relay = createLinkRelay(ctx);

        ctx.reviews = createReviews(ctx, opts.reviewServices || createReviewServices(config, fetchImpl));

        const release = opts.release || require('openvibe-shared/release').createRelease({ service: 'git', root: path.join(__dirname, '..') });
        setRelease(release.release);

        const app = express();
        const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'git', release: release.release });
        ctx.metrics = metrics;
        app.disable('x-powered-by');
        app.set('trust proxy', config.trustProxy);
        app.locals.ctx = ctx;

        app.use(contracts.http.middleware());
        app.use(helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                    styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com'],
                    fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
                    imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media'],
                    connectSrc: ["'self'", 'https://openvibe.network', 'https://openvibe.events', 'https://cloudflareinsights.com'],
                    frameSrc: ["'self'", 'https://openvibe.network'],
                    frameAncestors: ["'none'"],
                    objectSrc: ["'none'"],
                    baseUri: ["'self'"],
                    formAction: ["'self'", 'https://openvibe.network'],
                },
            },
            frameguard: { action: 'deny' },
            crossOriginEmbedderPolicy: false,
            crossOriginResourcePolicy: { policy: 'same-site' },
            referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
        }));
        app.use(cookieParser());

        // Health and the release's own endpoints answer before identity.
        app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-git', name: 'OpenVibe Git', version: VERSION }));
        app.get('/api/ready', async (_req, res) => {
            try {
                await s.db.value('SELECT 1 AS one');
                return res.json({ ok: true, service: 'git', version: VERSION, release: release.release });
            } catch (err) { return res.status(503).json({ ok: false, service: 'git', error: 'database' }); }
        });
        release.mount(app, { registry: metrics.registry });

        app.use('/shared', require('openvibe-shared/serve').handler());

        // ── Git over HTTPS, before every other route ─────────────
        app.use((req, res, next) => {
            const pathname = req.path.startsWith('/git/') ? req.path.slice(4) : req.path;
            const parsed = parseGitPath(pathname);
            if (!parsed) return next();
            return (async () => {
                const row = await repos.getRow(parsed.owner, parsed.name);
                if (!row) return res.status(404).type('text/plain').send('No such repository.');
                const identity = await identify(req, { store: s, config });
                return smartHttp.run(req, res, { row, suffix: parsed.suffix, identity });
            })().catch((err) => {
                log.error('[OpenVibe.Git] git route:', err && err.message);
                if (!res.headersSent) res.status(500).type('text/plain').send('The git server could not answer.');
            });
        });

        // ── Who is asking (a person's session) ───────────────────
        app.use(sso.optionalAuth());

        // ── Sign-in ─────────────────────────────────────────────
        app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
        app.use('/auth', sso.router(express));
        {
            const legal = require('openvibe-shared/legal');
            app.get(legal.PATHS, legal.handler({ id: 'git', service: 'git', host: 'git.openvibe.codes', name: 'OpenVibe Git', profile: 'hosting' }));
        }

        // ── Bodies: the GitHub webhook reads raw, everything else JSON ──
        app.use('/api/v1/webhooks/github', express.raw({ type: '*/*', limit: '5mb' }));
        app.use(express.json({ limit: '4mb' }));

        // ── Static ──────────────────────────────────────────────
        app.use(express.static(PUBLIC_DIR, {
            index: false, redirect: false,
            setHeaders(res, filePath) {
                const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
                const v = res.req && res.req.query && res.req.query.v;
                res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v }));
            },
        }));

        // ── API ─────────────────────────────────────────────────
        app.use('/api/v1', rateLimit({
            windowMs: 60_000, limit: config.apiRateLimitPerMinute, standardHeaders: true, legacyHeaders: false,
            handler: (req, res) => contracts.http.sendProblem(res, 429, 'rate_limited', { detail: 'too many requests from this address; retry shortly', ctx: req.ov }),
        }));
        app.use('/api/v1', createLinkRoutes(ctx));
        app.use('/api/v1', createReviewRoutes(ctx, true));
        app.use('/api/v1', createApi(ctx));
        app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

        // ── Pages ───────────────────────────────────────────────
        app.use(rateLimit({ windowMs: 60_000, limit: config.pageRateLimitPerMinute, standardHeaders: true, legacyHeaders: false }));
        app.use(createReviewRoutes(ctx));
        app.use(createPageRoutes(ctx));

        // eslint-disable-next-line no-unused-vars
        app.use((err, req, res, _next) => {
            log.error('[OpenVibe.Git]', err && err.message ? String(err.message).slice(0, 300) : err);
            if (res.headersSent) return;
            if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, err.status || 500, err.code || 'request.failed', { detail: err.status ? err.message : 'Something went wrong on our side.', ctx: req.ov });
            return res.status(err.status || 500).type('text/plain').send(err.status ? err.message : 'Something went wrong on our side.');
        });

        return { app, ctx, release };
    })();
}

module.exports = { createApp, VERSION };
