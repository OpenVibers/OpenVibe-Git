'use strict';

/**
 * /api/v1: repositories, browsing, archives, stars and forks, contents writes, commit statuses, clone
 * tokens, the home numbers and the GitHub webhook. Everything a page shows is here too; nothing here needs a browser.
 *
 * Public reads need no sign-in. A write needs the session or a token with git.repo.write. A private repository
 * answers 404 to anyone who may not see it, never 403: its existence is not public.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { callerOf, viewerFrom } = require('./identity');
const { mintToken } = require('../auth/git-auth');
const { serveArchive } = require('../archive');

const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });
const fail = (req, res, err) => problem(req, res, err.status || 500, err.code || 'request.failed', err.status ? err.message : undefined);

function boolParam(v) { return v === true || v === '1' || v === 'true' || v === 'yes'; }

function createApi(ctx) {
    const { config, repos, mirrors, git, insights, store, sso, checks, archive, ci, ciAuth, log } = ctx;
    const r = express.Router();
    const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
    // One identity read per request: the session, or a token (a person's or a service's, and for a service the
    // person it names in X-OV-Subject).
    const callerFor = async (req) => {
        if (!Object.prototype.hasOwnProperty.call(req, '_ovCaller')) req._ovCaller = await callerOf(req, { store, config });
        return req._ovCaller;
    };
    const viewerFor = async (req) => viewerFrom(await callerFor(req));
    // The person a service acts for becomes the actor for ownership and personal rows; a person's own caller is
    // unchanged.
    const actingAs = (caller) => ({ ...caller, subject: caller.on_behalf_of || caller.subject });
    const visible = async (req, owner, name, withCard = false) => {
        const row = await repos.getRow(owner, name);
        if (!row || !repos.canView(row, await viewerFor(req))) return null;
        let card = null;
        if (withCard && row.github_full_name) card = await ctx.github.card(row.github_full_name, { branch: row.default_branch });
        return { row, card };
    };
    const repoJson = (row, card) => repos.rowToRepo(row, { card });

    // ── Repositories ────────────────────────────────────────
    r.get('/repos', h(async (req, res) => {
        const viewer = await viewerFor(req);
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
        const viewer = await viewerFor(req);
        const out = repoJson(found.row, found.card);
        out.starred = await repos.isStarred(found.row, viewer && viewer.subject);
        return res.json(out);
    }));

    r.post('/repos', h(async (req, res) => {
        const caller = await callerFor(req);
        if (!caller) return problem(req, res, 401, 'auth.required', 'Sign in to make a repository.');
        const body = req.body || {};
        // A service (Codes, Run, Link) makes a repository for the person it names in X-OV-Subject; the person's
        // username is the repository's namespace, so the service says it in owner_username. It must not open a
        // namespace that already belongs to somebody else.
        let actor = caller;
        if (caller.actor_type === 'service') {
            if (!caller.scopes.has('git.repo.write')) return problem(req, res, 403, 'token.scope', 'This token may only read (git.repo.read).');
            if (!caller.on_behalf_of) return problem(req, res, 401, 'auth.subject_required', 'Name the person this repository is for in X-OV-Subject.');
            const username = String(body.owner_username || '').trim().toLowerCase();
            if (!username) return problem(req, res, 422, 'repo.owner_required', 'owner_username names the person whose repository this is.');
            const other = await store.maybe('SELECT 1 AS one FROM git_repos WHERE owner_username = ? AND owner_subject IS NOT NULL AND owner_subject <> ? LIMIT 1', [username, caller.on_behalf_of]);
            if (other) return problem(req, res, 409, 'repo.owner_mismatch', 'That username belongs to another OpenVibe account.');
            actor = { subject: caller.on_behalf_of, username, actor_type: 'service' };
        } else if (!caller.username) {
            return problem(req, res, 401, 'auth.required', 'Sign in to make a repository.');
        }
        try {
            const repo = await repos.create({
                actor, name: body.name, description: body.description, visibility: body.visibility,
                topics: Array.isArray(body.topics) ? body.topics : [], starter: body.starter,
                mirrorUrl: body.mirror_url || body.mirrorUrl,
            }, { address: req.ip });
            return res.status(201).json(repo);
        } catch (err) { return fail(req, res, err); }
    }));

    r.post('/repos/:owner/:name/fork', h(async (req, res) => {
        const caller = await callerFor(req);
        if (!caller || !caller.username) return problem(req, res, 401, 'auth.required', 'Sign in to fork.');
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository, or it is private.');
        try {
            const repo = await repos.fork({ source: found.row, actor: caller, name: (req.body || {}).name }, { address: req.ip });
            return res.status(201).json(repo);
        } catch (err) { return fail(req, res, err); }
    }));

    r.post('/repos/:owner/:name/mirror', h(async (req, res) => {
        const caller = await callerFor(req);
        if (!caller) return problem(req, res, 401, 'auth.required', 'Sign in.');
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository, or it is private.');
        try {
            const repo = await repos.setPushMirror(found.row, { push_url: (req.body || {}).push_url, push_token: (req.body || {}).push_token }, caller, { address: req.ip });
            return res.json(repo);
        } catch (err) { return fail(req, res, err); }
    }));

    r.post('/repos/:owner/:name/sync', h(async (req, res) => {
        const caller = await callerFor(req);
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        if (!caller || !repos.isOwner(found.row, actingAs(caller))) return problem(req, res, 403, 'repo.forbidden', 'Only the owner can sync a mirror.');
        if (!found.row.mirror_url) return problem(req, res, 422, 'repo.not_mirror', 'This repository is not a mirror.');
        const result = await mirrors.syncRow(found.row);
        return res.status(result.ok ? 202 : 502).json(result);
    }));

    r.put('/repos/:owner/:name/star', h(async (req, res) => {
        const caller = await callerFor(req);
        if (!caller || !actingAs(caller).subject) return problem(req, res, 401, 'auth.required', 'Sign in to star.');
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        return res.json(await repos.star(found.row, actingAs(caller).subject, true));
    }));

    r.delete('/repos/:owner/:name/star', h(async (req, res) => {
        const caller = await callerFor(req);
        if (!caller || !actingAs(caller).subject) return problem(req, res, 401, 'auth.required', 'Sign in to unstar.');
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        return res.json(await repos.star(found.row, actingAs(caller).subject, false));
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

    r.get('/repos/:owner/:name/archive/*', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        await serveArchive(archive, req, res, found.row, req.params[0], {
            log, fail: (status, message) => problem(req, res, status, 'archive.not_found', message),
        });
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

    // ── Commit statuses ───────────────────────────────────
    r.get('/repos/:owner/:name/commits/:sha/statuses', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        try {
            const sha = checks.cleanSha(req.params.sha);
            const statuses = await checks.latest(found.row.id, sha);
            return res.json({ repo: `${found.row.owner_username}/${found.row.name}`, sha, state: checks.combined(statuses), statuses });
        } catch (err) { return fail(req, res, err); }
    }));

    r.post('/repos/:owner/:name/commits/:sha/statuses', h(async (req, res) => {
        const caller = await callerFor(req);
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        if (!caller) return problem(req, res, 401, 'auth.required', 'A service token with git.checks.write reports a status.');
        if (!caller.scopes.has('git.checks.write')) return problem(req, res, 403, 'token.scope', 'This token may not report checks (git.checks.write).');
        const who = actingAs(caller);
        if (caller.actor_type !== 'service' && !repos.isOwner(found.row, who)) return problem(req, res, 403, 'repo.forbidden', 'Only the owner or a checks service may report.');
        try {
            const sha = checks.cleanSha(req.params.sha);
            const status = await checks.record(found.row.id, sha, req.body, caller.subject);
            await repos.audit(who, 'git.status', found.row, { sha, context: status.context, state: status.state, via: caller.actor_type === 'service' ? caller.subject : 'api' }, req.ip);
            return res.status(201).json(status);
        } catch (err) { return fail(req, res, err); }
    }));

    r.get('/repos/:owner/:name/required-checks', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        return res.json({ repo: `${found.row.owner_username}/${found.row.name}`, required_checks: checks.requiredFor(found.row) });
    }));

    r.post('/repos/:owner/:name/required-checks', h(async (req, res) => {
        const caller = await callerFor(req);
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        if (!caller || !repos.isOwner(found.row, actingAs(caller))) return problem(req, res, 403, 'repo.forbidden', 'Only the owner can require checks.');
        try {
            const required = await checks.setRequired(found.row, (req.body || {}).contexts ?? (req.body || {}).required_checks);
            await repos.audit(actingAs(caller), 'git.required_checks', found.row, { required_checks: required }, req.ip);
            return res.json({ repo: `${found.row.owner_username}/${found.row.name}`, required_checks: required });
        } catch (err) { return fail(req, res, err); }
    }));

    // ── Forge CI (the workstation runner) ──────────────────
    // The runner holds one token; the service holds its scrypt hash. Nothing here is reachable with a session.
    const runnerOnly = (req, res) => {
        if (!ciAuth.ok(req)) {
            problem(req, res, 401, 'ci.runner_token', 'The forge runner token is missing or wrong.');
            return false;
        }
        return true;
    };

    r.post('/ci/repos', h(async (req, res) => {
        if (!runnerOnly(req, res)) return undefined;
        try {
            const list = Array.isArray(req.body) ? req.body : (req.body && Array.isArray(req.body.repos) ? req.body.repos : []);
            return res.json({ repositories: await ci.registerRepos(list) });
        } catch (err) { return fail(req, res, err); }
    }));

    r.post('/ci/runs/claim', h(async (req, res) => {
        if (!runnerOnly(req, res)) return undefined;
        const job = await ci.claim((req.body && req.body.runner) || 'forge-runner');
        if (!job) return res.status(204).end();
        return res.json(job);
    }));

    r.get('/ci/runs/:id/heartbeat', h(async (req, res) => {
        if (!runnerOnly(req, res)) return undefined;
        return res.json(await ci.heartbeat(req.params.id));
    }));

    r.post('/ci/runs/:id/log', h(async (req, res) => {
        if (!runnerOnly(req, res)) return undefined;
        const out = await ci.appendLog(req.params.id, String((req.body || {}).chunk || ''));
        if (!out.ok) return problem(req, res, 409, 'ci.run_not_running', `This run is ${out.state}.`);
        return res.json(out);
    }));

    r.post('/ci/runs/:id/status', h(async (req, res) => {
        if (!runnerOnly(req, res)) return undefined;
        try {
            const out = await ci.finish(req.params.id, req.body || {});
            if (!out.ok) return problem(req, res, 409, 'ci.run_not_running', `This run is ${out.state}.`);
            return res.json(out);
        } catch (err) { return fail(req, res, err); }
    }));

    r.get('/repos/:owner/:name/ci', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        const conf = await ci.configFor(found.row);
        return res.json({
            repo: `${found.row.owner_username}/${found.row.name}`,
            enabled: Boolean(conf && conf.enabled),
            context: config.ci.context,
            runs: await ci.runsFor(found.row, { limit: req.query.limit }),
        });
    }));

    r.get('/repos/:owner/:name/ci/runs/:id', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        const run = await ci.runFor(found.row, req.params.id);
        if (!run) return problem(req, res, 404, 'ci.run_not_found', 'No such run.');
        return res.json(run);
    }));

    r.post('/repos/:owner/:name/ci/runs', h(async (req, res) => {
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        const caller = await callerFor(req);
        const runner = ciAuth.ok(req);
        if (!runner && (!caller || !repos.isOwner(found.row, actingAs(caller)))) {
            return problem(req, res, 403, 'repo.forbidden', 'Only the owner or the forge runner may start a run.');
        }
        try {
            const out = await ci.manual(found.row, (req.body || {}), runner ? 'runner' : 'owner');
            return res.status(201).json(out);
        } catch (err) { return fail(req, res, err); }
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
        const caller = await callerFor(req);
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        if (!caller || !repos.isOwner(found.row, actingAs(caller))) return problem(req, res, 403, 'repo.forbidden', 'Only the owner can publish a release.');
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
        const caller = await callerFor(req);
        const found = await visible(req, req.params.owner, req.params.name);
        if (!found) return problem(req, res, 404, 'repo.not_found', 'No such repository.');
        if (!caller) return problem(req, res, 401, 'auth.required', 'Sign in or present a token with git.repo.write.');
        if (!caller.scopes.has('git.repo.write')) return problem(req, res, 403, 'token.scope', 'This token may only read (git.repo.read).');
        const who = actingAs(caller);
        const own = repos.isOwner(found.row, who);
        const serviceWrite = caller.actor_type === 'service' && found.row.official && caller.scopes.has('git.repo.write');
        if (!own && !serviceWrite) return problem(req, res, 403, 'repo.forbidden', 'Only the owner (or the service on an official repository) may write.');
        const body = req.body || {};
        try {
            const author = body.author || (who.username ? { name: who.username, email: `${who.username}@users.noreply.openvibe.codes` } : { name: 'OpenVibe Git', email: 'git@openvibe.codes' });
            const out = await git.commitFiles(found.row.owner_username, found.row.name, {
                branch: body.branch, message: body.message, files: body.files, base: body.base, author, committer: author,
            }, { defaultBranch: found.row.default_branch, maxBytes: config.data.maxPushBytes });
            await repos.recordEvent(found.row, 'push', who, { sha: out.sha, branch: out.branch, via: 'api' });
            await repos.audit(who, 'git.commit', found.row, { sha: out.sha, branch: out.branch, via: caller.actor_type === 'service' ? caller.subject : 'api' }, req.ip);
            await mirrors.afterPush(found.row);
            return res.status(201).json({ repo: `${found.row.owner_username}/${found.row.name}`, ...out });
        } catch (err) { return fail(req, res, err); }
    }));

    // ── Clone tokens ───────────────────────────────────────
    r.post('/tokens', h(async (req, res) => {
        const caller = await callerFor(req);
        if (!caller) return problem(req, res, 401, 'auth.required', 'Sign in to make a clone token.');
        // A service makes one for the person it names; the person's own token is theirs.
        if (caller.actor_type === 'service' && !caller.scopes.has('git.repo.write')) return problem(req, res, 403, 'token.scope', 'This token may only read (git.repo.read).');
        const who = actingAs(caller);
        if (!who.subject) return problem(req, res, 401, 'auth.subject_required', 'Name the person this token is for in X-OV-Subject.');
        const body = req.body || {};
        try {
            const minted = await mintToken(store, {
                subject: who.subject, actorType: 'user', scopes: body.scopes,
                hours: body.hours || config.tokens.ttlHours, label: String(body.label || '').slice(0, 100) || null,
            });
            await repos.audit(who, 'token.create', null, { scopes: minted.scopes, token_id: minted.id, via: caller.actor_type === 'service' ? caller.subject : 'session' }, req.ip);
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
        const profile = await repos.profile(String(req.params.username).toLowerCase(), { viewer: await viewerFor(req) });
        if (!profile) return problem(req, res, 404, 'profile.not_found', 'No such person.');
        return res.json(profile);
    }));

    // ── GitHub's push webhook ──────────────────────────────
    r.post('/webhooks/github', h(async (req, res) => {
        if (!Buffer.isBuffer(req.body)) return problem(req, res, 415, 'webhook.raw_required', 'The webhook body is read raw.');
        const out = await mirrors.handleWebhook(req.body, req.headers);
        res.status(out.status).json(out.body);
        // A push starts a forge run only after the mirror has the pushed commit; a pull request never does.
        if (out.event === 'push' && out.row && out.payload && out.sync) {
            out.sync
                .then(() => ci.onGithubPush(out.row, out.payload))
                .catch((err) => log.warn(`[OpenVibe.Git] CI push ${out.row.owner_username}/${out.row.name}: ${String(err.message || err).slice(0, 200)}`));
        }
        return undefined;
    }));

    r.use((req, res) => problem(req, res, 404, 'route.not_found', 'No such API route.'));
    return r;
}

module.exports = { createApi };
