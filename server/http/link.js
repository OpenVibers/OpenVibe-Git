'use strict';

/**
 * Link's relay over HTTPS (Git plan G3). The Link only ever connects out; these routes are the two ends:
 *
 *   page (signed in)         /api/v1/clone-requests, /api/v1/machines
 *   Link (one-time token)    /api/v1/link/clone-requests/:id, /api/v1/link/machines/:id/{hello,watch,results}
 *
 * A page's request never carries the clone URL or the token: the page polls its own row, the Link gets the question.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { viewerOf } = require('./identity');

function createLinkRoutes(ctx) {
    const { config, repos, relay } = ctx;
    const r = express.Router();
    const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const fail = (req, res, err) => problem(req, res, err.status || 500, err.code || 'request.failed', err.status ? err.message : undefined);
    const viewer = (req) => viewerOf(req);
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).host === new URL(config.baseUrl).host; } catch { return false; }
    };
    const requirePerson = (req, res) => {
        const me = viewer(req);
        if (!me) { problem(req, res, 401, 'auth.required', 'Sign in first.'); return null; }
        if (!sameOrigin(req)) { problem(req, res, 403, 'origin.forbidden', 'Make this request on git.openvibe.codes itself.'); return null; }
        return me;
    };
    const linkToken = (req) => {
        const auth = String(req.get('authorization') || '');
        if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
        return String(req.query.token || '');
    };

    // ── Clone to my computer ────────────────────────────────
    r.post('/clone-requests', h(async (req, res) => {
        const me = requirePerson(req, res);
        if (!me) return undefined;
        const [owner, name] = String(req.body && req.body.repo || '').toLowerCase().split('/');
        if (!owner || !name) return problem(req, res, 400, 'repo.invalid', 'A repository is owner/name.');
        const row = await repos.getRow(owner, name);
        if (!row || !repos.canView(row, me)) return problem(req, res, 404, 'repo.not_found', 'No such repository, or it is private.');
        try {
            const out = await relay.createClone({ viewer: me, row });
            return res.status(201).json({ request: out.request, link: { url: out.link, command: `openvibe-link clone '${out.link}'` } });
        } catch (err) { return fail(req, res, err); }
    }));

    r.get('/clone-requests/:id', h(async (req, res) => {
        const me = viewer(req);
        if (!me) return problem(req, res, 401, 'auth.required', 'Sign in first.');
        const request = await relay.getForPage({ id: String(req.params.id), subject: me.subject });
        if (!request) return problem(req, res, 404, 'clone.not_found', 'No such clone request.');
        return res.set('Cache-Control', 'no-store').json({ request });
    }));

    // ── Clone to one of my computers ────────────────────────
    // The request rides the watch that computer already holds; only the computer it was addressed to can report on it.
    r.post('/repos/:owner/:name/clone-to-machine', h(async (req, res) => {
        const me = requirePerson(req, res);
        if (!me) return undefined;
        const row = await repos.getRow(String(req.params.owner || '').toLowerCase(), String(req.params.name || '').toLowerCase());
        if (!row || !repos.canView(row, me)) return problem(req, res, 404, 'repo.not_found', 'No such repository, or it is private.');
        try {
            const request = await relay.createCloneToMachine({ viewer: me, row, machineId: req.body && req.body.machine });
            return res.set('Cache-Control', 'no-store').status(201).json({ request });
        } catch (err) { return fail(req, res, err); }
    }));

    r.get('/repos/:owner/:name/clone-to-machine/:id', h(async (req, res) => {
        const me = viewer(req);
        if (!me) return problem(req, res, 401, 'auth.required', 'Sign in first.');
        const request = await relay.getForPage({ id: String(req.params.id), subject: me.subject });
        const repo = `${String(req.params.owner || '').toLowerCase()}/${String(req.params.name || '').toLowerCase()}`;
        if (!request || request.repo !== repo) return problem(req, res, 404, 'clone.not_found', 'No such clone request.');
        return res.set('Cache-Control', 'no-store').json({ request });
    }));

    // The computer's report on the clone it was asked to run, over its own one-time token.
    r.post('/link/machines/:id/clone-requests/:cloneId', h(async (req, res) => {
        const request = await relay.machineCloneUpdate({
            machineId: String(req.params.id), token: linkToken(req), id: String(req.params.cloneId), body: req.body || {},
        });
        if (!request) return problem(req, res, 404, 'clone.not_found', 'No such clone request for this computer.');
        return res.set('Cache-Control', 'no-store').json({ request });
    }));

    // The Link's end of the same request.
    r.get('/link/clone-requests/:id', h(async (req, res) => {
        const doc = await relay.linkGet({ id: String(req.params.id), token: linkToken(req) });
        if (!doc) return problem(req, res, 404, 'clone.not_found', 'No such clone request, or the link expired.');
        return res.set('Cache-Control', 'no-store').json(doc);
    }));

    r.post('/link/clone-requests/:id', h(async (req, res) => {
        const doc = await relay.linkUpdate({ id: String(req.params.id), token: linkToken(req), body: req.body || {} });
        if (!doc) return problem(req, res, 404, 'clone.not_found', 'No such clone request, or the link expired.');
        return res.json({ request: doc });
    }));

    // ── A published machine, read-only ──────────────────────
    r.post('/machines', h(async (req, res) => {
        const me = requirePerson(req, res);
        if (!me) return undefined;
        try {
            const out = await relay.createMachine({ viewer: me, name: req.body && req.body.name });
            return res.status(201).json({ machine: out.machine, link: { url: out.link, command: `openvibe-link git connect '${out.link}'` } });
        } catch (err) { return fail(req, res, err); }
    }));

    r.get('/machines', h(async (req, res) => {
        const me = viewer(req);
        if (!me) return problem(req, res, 401, 'auth.required', 'Sign in first.');
        return res.set('Cache-Control', 'no-store').json({ machines: await relay.listMachines({ subject: me.subject }) });
    }));

    r.post('/link/machines/:id/hello', h(async (req, res) => {
        const out = await relay.machineHello({ id: String(req.params.id), token: linkToken(req), body: req.body || {} });
        if (!out) return problem(req, res, 404, 'machine.not_found', 'No such machine, or the link expired.');
        return res.json(out);
    }));

    r.get('/link/machines/:id/watch', h(async (req, res) => {
        const out = await relay.machineWatch({ id: String(req.params.id), token: linkToken(req) });
        if (!out) return problem(req, res, 404, 'machine.not_found', 'No such machine, or the link expired.');
        return res.set('Cache-Control', 'no-store').json(out);
    }));

    r.post('/link/machines/:id/results', h(async (req, res) => {
        const out = await relay.machineResult({ id: String(req.params.id), token: linkToken(req), body: req.body || {} });
        if (!out) return problem(req, res, 404, 'machine.not_found', 'No such machine, or the link expired.');
        return res.json(out);
    }));

    return r;
}

module.exports = { createLinkRoutes };
