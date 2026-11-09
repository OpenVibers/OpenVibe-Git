'use strict';

/**
 * /api/v1: repositories, browsing, stars and forks, contents writes, clone tokens, the home numbers and the
 * GitHub webhook. Everything a page shows is here too; nothing here needs a browser.
 *
 * Public reads need no sign-in. A write needs the session or a token with git.write. A private repository
 * answers 404 to anyone who may not see it, never 403: its existence is not public.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { viewerOf, callerOf } = require('./identity');
const { mintToken } = require('../auth/git-auth');

const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });
const fail = (req, res, err) => problem(req, res, err.status || 500, err.code || 'request.failed', err.status ? err.message : undefined);

function boolParam(v) { return v === true || v === '1' || v === 'true' || v === 'yes'; }

function createApi(ctx) {
    const { config, repos, mirrors, git, insights, store, sso } = ctx;
    const r = express.Router();
    const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
    const visible = async (req, owner, name, withCard = false) => {
        const row = await repos.getRow(owner, name);
        if (!row || !repos.canView(row, viewerOf(req))) return null;
        let card = null;
        if (withCard && row.github_full_name) card = await ctx.github.card(row.github_full_name, { branch: row.default_branch });
        return { row, card };
    };
    const repoJson = (row, card) => repos.rowToRepo(row, { card });

    // ── Repositories ────────────────────────────────────────
    r.get('/repos', h(async (req, res) => {
        const viewer = viewerOf(req);
        const out = await repos.list({
            viewer,
            q: String(req.query.q || '').slice(0, 100),
            language: String(req.query.language || '').slice(0, 40),
            official: boolParam(req.query.official),
            mirror: boolParam(req.query.mirror),
            mine: boolParam(req.query.mine),
            starred: boolParam(req.query.starred),
            sort: String(req.query.sort || 'trending'),
            limit: req.query.limit,
            cursor: req.query.cursor,
        });
        res.set('Cache-Control', viewer ? 'no-store' : 'public, max-age=60');
        res.json(out);
    }));

    r.get('/repos/:owner/:name', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name, true);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository, or it is private.');
        const viewer = viewerOf(req);
        const out = repoJson(found.row, found.card);
        out.starred = await repos.isStarred(found.row, viewer && viewer.subject);
        return res.json(out);
    }));

    r.post('/repos', h(async (req, res) => {
        const caller = await callerOf(req, { store, config });
        if (!caller || !caller.username) return problem(req, res, 401, 'auth.required', 'Sign in to make a repository.');
        const body = req.body || {};
        try {
            const repo = await repos.create({
                actor: caller, name: body.name, description: body.description, visibility: body.visibility,
                topics: Array.isArray(body.topics) ? body.topics : [], starter: body.starter,
                mirrorUrl: body.mirror_url || body.mirrorUrl,
            }, { address: req.ip });
            return res.status(201).json(repo);
        } catch (err) { return fail(req, res, err); }
    }));

    r.post('/repos/:owner/:name/fork', h(async (req, res) => {
        const caller = await callerOf(req, { store, config });
        if (!caller || !caller.username) return problem(req, res, 401, 'auth.required', 'Sign in to fork.');
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository, or it is private.');
        try {
            const repo = await repos.fork({ source: found.row, actor: caller, name: (req.body || {}).name }, { address: req.ip });
            return res.status(201).json(repo);
        } catch (err) { return fail(req, res, err); }
    }));

    r.post('/repos/:owner/:name/mirror', h(async (req, res) => {
        const caller = await callerOf(req, { store, config });
        if (!caller) return problem(req, res, 401, 'auth.required', 'Sign in.');
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository, or it is private.');
        try {
            const repo = await repos.setPushMirror(found.row, { push_url: (req.body || {}).push_url, push_token: (req.body || {}).push_token }, caller, { address: req.ip });
            return res.json(repo);
        } catch (err) { return fail(req, res, err); }
    }));

    r.post('/repos/:owner/:name/sync', h(async (req, res) => {
        const caller = await callerOf(req, { store, config });
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        if (!caller || !repos.isOwner(found.row, caller)) return problem(req, res, 403, 'repo.forbidden', 'Only the owner can sync a mirror.');
        if (!found.row.mirror_url) return problem(req, res, 422, 'repo.not_mirror', 'This repository is not a mirror.');
        const result = await mirrors.syncRow(found.row);
        return res.status(result.ok ? 202 : 502).json(result);
    }));

    r.put('/repos/:owner/:name/star', h(async (req, res) => {
        const caller = await callerOf(req, { store, config });
        if (!caller || !caller.subject) return problem(req, res, 401, 'auth.required', 'Sign in to star.');
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        return res.json(await repos.star(found.row, caller.subject, true));
    }));

    r.delete('/repos/:owner/:name/star', h(async (req, res) => {
        const caller = await callerOf(req, { store, config });
        if (!caller || !caller.subject) return problem(req, res, 401, 'auth.required', 'Sign in to unstar.');
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        return res.json(await repos.star(found.row, caller.subject, false));
    }));

    // ── Browsing ────────────────────────────────────────────
    const refOf = (req, row) => String(req.query.ref || row.default_branch || 'main');

    r.get('/repos/:owner/:name/tree', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        const pathAt = String(req.query.path || '');
        const ref = refOf(req, found.row);
        const tree = await git.readTree(found.row.owner_username, found.row.name, ref, pathAt);
        if (!tree) return problem(req, res, 404, 'tree.not_found', 'No such ref or directory.');
        return res.json({
            repo: `${found.row.owner_username}/${found.row.name}`, ref, path: tree.path, commit: tree.commit,
            entries: tree.entries.map((e) => ({ name: e.name, path: e.path, type: e.type, mode: e.mode, sha: e.sha, size: e.size, last_commit: e.last_commit || null })),
            truncated: tree.truncated,
        });
    }));

    r.get('/repos/:owner/:name/blob', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        const pathAt = String(req.query.path || '');
        if (!pathAt) return problem(req, res, 422, 'blob.path_required', 'A path is required.');
        const ref = refOf(req, found.row);
        const blob = await git.readBlob(found.row.owner_username, found.row.name, ref, pathAt, { maxBytes: config.data.maxFileBytes });
        if (!blob) return problem(req, res, 404, 'blob.not_found', 'No such file at that ref.');
        return res.json({ repo: `${found.row.owner_username}/${found.row.name}`, ref, path: pathAt, size: blob.size, binary: blob.binary, truncated: blob.truncated, text: blob.text });
    }));

    r.get('/repos/:owner/:name/raw', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        const pathAt = String(req.query.path || '');
        const ref = refOf(req, found.row);
        const blob = await git.blobBytes(found.row.owner_username, found.row.name, ref, pathAt, { maxBytes: config.data.maxFileBytes });
        if (!blob) return problem(req, res, 404, 'blob.not_found', 'No such file at that ref.');
        res.set('Content-Type', /\.(png|jpe?g|gif|webp|ico)$/i.test(pathAt) ? 'image/' + pathAt.split('.').pop().replace('jpg', 'jpeg') : 'text/plain; charset=utf-8');
        res.set('Content-Length', String(blob.data.length));
        res.set('Cache-Control', 'public, max-age=300');
        return res.end(blob.data);
    }));

    r.get('/repos/:owner/:name/commits', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        const ref = refOf(req, found.row);
        const commits = await git.history(found.row.owner_username, found.row.name, ref, {
            path: String(req.query.path || ''), limit: req.query.limit, skip: req.query.cursor,
        });
        if (!commits) return problem(req, res, 404, 'ref.not_found', 'No such ref.');
        const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
        const skip = Math.max(0, Number(req.query.cursor) || 0);
        return res.json({ repo: `${found.row.owner_username}/${found.row.name}`, ref, commits: commits.map((c) => ({ ...c, message: c.subject })), next_cursor: commits.length === limit ? String(skip + limit) : null });
    }));

    r.get('/repos/:owner/:name/commit/:sha', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        const commit = await git.commitDetail(found.row.owner_username, found.row.name, req.params.sha, { diff: boolParam(req.query.diff) });
        if (!commit) return problem(req, res, 404, 'commit.not_found', 'No such commit.');
        return res.json({
            ...commit, repo: `${found.row.owner_username}/${found.row.name}`, subject: String(commit.message || '').split('\n')[0],
            author: { ...commit.author, username: commit.author.username || null },
        });
    }));

    r.get('/repos/:owner/:name/branches', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        return res.json({ branches: await git.branches(found.row.owner_username, found.row.name) });
    }));
    r.get('/repos/:owner/:name/tags', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        return res.json({ tags: await git.tags(found.row.owner_username, found.row.name) });
    }));
    r.get('/repos/:owner/:name/releases', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        return res.json({ releases: await repos.releases(found.row) });
    }));
    r.post('/repos/:owner/:name/releases', h(async (req, res) => {
        const caller = await callerOf(req, { store, config });
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        if (!caller || !repos.isOwner(found.row, caller)) return problem(req, res, 403, 'repo.forbidden', 'Only the owner can publish a release.');
        try {
            return res.status(201).json({ releases: await repos.publishRelease(found.row, { ...(req.body || {}), actor: caller }) });
        } catch (err) { return fail(req, res, err); }
    }));
    r.get('/repos/:owner/:name/contributors', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        return res.json({ contributors: await repos.contributors(found.row) });
    }));
    r.get('/repos/:owner/:name/insights', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        return res.json(await repos.insightsFor(found.row, { days: req.query.days }));
    }));

    // ── Writes without a clone ─────────────────────────────
    r.post('/repos/:owner/:name/commits', h(async (req, res) => {
        const caller = await callerOf(req, { store, config });
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        if (!caller) return problem(req, res, 401, 'auth.required', 'Sign in or present a token with git.write.');
        if (!caller.scopes.has('git.write')) return problem(req, res, 403, 'token.scope', 'This token may only read (git.read).');
        const own = repos.isOwner(found.row, caller);
        const serviceWrite = caller.actor_type === 'service' && found.row.official && caller.scopes.has('git.write');
        if (!own && !serviceWrite) return problem(req, res, 403, 'repo.forbidden', 'Only the owner (or the service on an official repository) may write.');
        const body = req.body || {};
        try {
            const author = body.author || (caller.username ? { name: caller.username, email: `${caller.username}@users.noreply.openvibe.codes` } : { name: 'OpenVibe Git', email: 'git@openvibe.codes' });
            const out = await git.commitFiles(found.row.owner_username, found.row.name, {
                branch: body.branch, message: body.message, files: body.files, base: body.base, author, committer: author,
            }, { defaultBranch: found.row.default_branch, maxBytes: config.data.maxPushBytes });
            await repos.recordEvent(found.row, 'push', caller, { sha: out.sha, branch: out.branch, via: 'api' });
            await repos.audit(caller, 'git.commit', found.row, { sha: out.sha, branch: out.branch }, req.ip);
            await mirrors.afterPush(found.row);
            return res.status(201).json({ repo: `${found.row.owner_username}/${found.row.name}`, ...out });
        } catch (err) { return fail(req, res, err); }
    }));

    // ── Clone tokens ───────────────────────────────────────
    r.post('/tokens', h(async (req, res) => {
        const caller = await callerOf(req, { store, config });
        if (!caller) return problem(req, res, 401, 'auth.required', 'Sign in to make a clone token.');
        const body = req.body || {};
        try {
            const minted = await mintToken(store, {
                subject: caller.subject, actorType: caller.actor_type, scopes: body.scopes,
                hours: body.hours || config.tokens.ttlHours, label: String(body.label || '').slice(0, 100) || null,
            });
            await repos.audit(caller, 'token.create', null, { scopes: minted.scopes, token_id: minted.id }, req.ip);
            const host = config.baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
            return res.status(201).json({
                token: minted.token, token_type: minted.token_type, expires_at: minted.expires_at, scopes: minted.scopes,
                clone_url: `${config.baseUrl.replace(/\/+$/, '')}/<owner>/<name>.git`,
                command: `git clone https://x-access-token:${minted.token}@${host}/<owner>/<name>.git`,
            });
        } catch (err) { return fail(req, res, err); }
    }));

    // ── Home, activity, profiles ───────────────────────────
    r.get('/stats', h(async (_req, res) => res.json(await repos.stats())));
    r.get('/activity', h(async (req, res) => res.json({ events: await repos.activity(req.query.limit) })));
    r.get('/profile/:username', h(async (req, res) => {
        const profile = await repos.profile(String(req.params.username).toLowerCase(), { viewer: viewerOf(req) });
        if (!profile) return problem(req, res, 404, 'profile.not_found', 'No such person.');
        return res.json(profile);
    }));

    // ── GitHub's push webhook ──────────────────────────────
    r.post('/webhooks/github', h(async (req, res) => {
        if (!Buffer.isBuffer(req.body)) return problem(req, res, 415, 'webhook.raw_required', 'The webhook body is read raw.');
        const out = await mirrors.handleWebhook(req.body, req.headers);
        return res.status(out.status).json(out.body);
    }));

    r.use((req, res) => problem(req, res, 404, 'route.not_found', 'No such API route.'));
    return r;
}

module.exports = { createApi };
