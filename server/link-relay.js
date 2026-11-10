'use strict';

/**
 * Link's outbound relay (Git plan G3). Link connects to Git; Git never connects to Link. Two kinds of link:
 *
 *   ├ clone: the repository page mints a clr_… request and a one-time token, and the person runs
 *   │        `openvibe-link clone <link>`. Link reads the request, asks there, clones with the person's own git
 *   │        and posts approved / cloning / progress / done / refused / failed back. The page polls the same row.
 *   └ machine: the person's Git page mints an mch_… id and a token; `openvibe-link git connect <link>` publishes the
 *            repositories under the root the person chose in Link, read-only. Git queues a tree, file or log question
 *            and answers it on the watch the machine opened.
 *
 * The Link token is 32 random bytes, stored only as its SHA-256 hash; the clone URL's read token is kept in this
 * process only, never in the database and never in a page. A clone request lives two minutes.
 */
const crypto = require('node:crypto');
const { hashToken, mintToken } = require('./auth/git-auth');

const CLONE_TTL_MS = 2 * 60_000;
const OFFLINE_AFTER_MS = 30_000;
const WATCH_MS = 25_000;
const BROWSE_MS = 8_000;
const TERMINAL = new Set(['done', 'refused', 'failed', 'expired']);
// Before the clone runs: queued (on its way to one of the person's own computers) and waiting (that computer has
// it and is asking them). Both end after the same two minutes; a clone already running is left to finish.
const UNSTARTED = new Set(['queued', 'waiting', 'pending', 'approved']);

const newOpaque = () => crypto.randomBytes(32).toString('base64url');
const newID = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex').toUpperCase().slice(0, 26)}`;

function createLinkRelay(ctx) {
    const { store, repos, config, log = console } = ctx;
    const now = store.now;
    // Secrets stay in memory for the request's short life: the clone URL's read token and the Link token's raw value
    // is never stored. A restart loses pending requests, which is right: Link is polling them.
    const cloneURLs = new Map();   // clr_id -> { url, token_id }
    const queue = new Map();       // mch_id -> [{ id, kind, repo, ref, path }]
    const wake = new Map();        // mch_id -> Set<resolve>
    const inflight = new Map();    // request id -> { resolve, timer, machineId }

    const progressOf = (row) => {
        if (!row.progress) return null;
        if (typeof row.progress === 'string') { try { return JSON.parse(row.progress); } catch { return null; } }
        return row.progress;
    };
    const cloneDoc = (row) => ({
        id: row.id,
        repo: row.repo_full,
        state: row.state,
        created_at: row.created_at,
        expires_at: row.expires_at,
        ...(progressOf(row) ? { progress: progressOf(row) } : {}),
        ...(row.path ? { path: row.path } : {}),
        ...(row.reason ? { reason: row.reason } : {}),
        ...(row.machine_id ? { machine_id: row.machine_id } : {}),
    });

    const isExpired = (row) => Date.parse(row.expires_at) <= now();

    /** End a request past its two minutes: the row says expired and the clone's read token is revoked. */
    async function expire(row) {
        await store.execute("UPDATE git_clone_requests SET state = 'expired', updated_at = now() WHERE id = ? AND state IN ('queued', 'waiting', 'pending', 'approved')", [row.id]);
        const secret = cloneURLs.get(row.id);
        cloneURLs.delete(row.id);
        if (secret) await store.execute('UPDATE git_tokens SET revoked_at = now() WHERE id = ? AND revoked_at IS NULL', [secret.token_id]).catch(() => {});
        row.state = 'expired';
        return row;
    }

    async function loadForLink(id, token) {
        const row = await store.maybe('SELECT * FROM git_clone_requests WHERE id = ?', [id]);
        if (!row) return null;
        if (!safeEqual(hashToken(token), row.token_hash)) return null;
        if (UNSTARTED.has(row.state) && isExpired(row)) await expire(row);
        return row;
    }

    async function createClone({ viewer, row }) {
        if (!viewer || !viewer.subject) {
            throw Object.assign(new Error('Sign in to clone to your computer.'), { status: 401, code: 'auth.required' });
        }
        if (!repos.canView(row, viewer)) {
            throw Object.assign(new Error('No such repository.'), { status: 404, code: 'repo.not_found' });
        }
        const id = store.newId('clr');
        const token = newOpaque();
        const expires = new Date(now() + CLONE_TTL_MS).toISOString();
        // A short read token is minted for this one clone; it names the person and is revoked when the request ends.
        const minted = await mintToken(store, { subject: viewer.subject, scopes: ['git.repo.read'], hours: 1, label: `clone ${row.owner_username}/${row.name}` });
        const host = config.baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        const url = `${config.baseUrl.replace(/\/+$/, '')}/${row.owner_username}/${row.name}.git`;
        const cloneURL = `https://x-access-token:${minted.token}@${host}/${row.owner_username}/${row.name}.git`;
        await store.execute(
            `INSERT INTO git_clone_requests (id, subject, repo_id, repo_full, state, token_hash, created_at, expires_at, updated_at)
             VALUES (?, ?, ?, ?, 'pending', ?, now(), ?, now())`,
            [id, viewer.subject, row.id, `${row.owner_username}/${row.name}`, hashToken(token), expires],
        );
        cloneURLs.set(id, { url: cloneURL, token_id: minted.id });
        const link = `${config.baseUrl.replace(/\/+$/, '')}/api/v1/link/clone-requests/${id}?token=${encodeURIComponent(token)}`;
        return { request: cloneDoc({ id, repo_full: `${row.owner_username}/${row.name}`, state: 'pending', created_at: new Date(now()).toISOString(), expires_at: expires, progress: null, path: null, reason: null }), link };
    }

    /**
     * Clone to one of the person's own Link computers. The request rides the watch that computer already holds (the
     * same poll the /machines pages browse through), so the person needs no terminal command; the computer asks its
     * owner, and until they answer nothing is written there. The clone URL's short read token travels only to that
     * machine: never to the page, never into the database.
     */
    async function createCloneToMachine({ viewer, row, machineId }) {
        if (!viewer || !viewer.subject) {
            throw Object.assign(new Error('Sign in to clone to your computer.'), { status: 401, code: 'auth.required' });
        }
        if (!repos.canView(row, viewer)) {
            throw Object.assign(new Error('No such repository.'), { status: 404, code: 'repo.not_found' });
        }
        const machineRow = await store.maybe('SELECT * FROM git_machines WHERE id = ? AND subject = ?', [String(machineId || ''), viewer.subject]);
        if (!machineRow) {
            throw Object.assign(new Error('No such computer of yours.'), { status: 404, code: 'machine.not_found' });
        }
        if (!machineDoc(machineRow).online) {
            throw Object.assign(new Error(`${machineRow.name} is not online: start Link there, then ask again.`), { status: 409, code: 'machine.offline' });
        }
        const id = store.newId('clr');
        const token = newOpaque();
        const expires = new Date(now() + CLONE_TTL_MS).toISOString();
        const minted = await mintToken(store, { subject: viewer.subject, scopes: ['git.repo.read'], hours: 1, label: `clone ${row.owner_username}/${row.name}` });
        const host = config.baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        const cloneURL = `https://x-access-token:${minted.token}@${host}/${row.owner_username}/${row.name}.git`;
        await store.execute(
            `INSERT INTO git_clone_requests (id, subject, repo_id, repo_full, state, token_hash, machine_id, created_at, expires_at, updated_at)
             VALUES (?, ?, ?, ?, 'queued', ?, ?, now(), ?, now())`,
            [id, viewer.subject, row.id, `${row.owner_username}/${row.name}`, hashToken(token), machineRow.id, expires],
        );
        cloneURLs.set(id, { url: cloneURL, token_id: minted.id });
        const request = {
            id: newID('req'), kind: 'clone', clone_id: id, repo: `${row.owner_username}/${row.name}`,
            url: cloneURL, requested_by: viewer.username || viewer.subject, expires_at: expires,
        };
        const q = queue.get(machineRow.id) || [];
        q.push(request);
        queue.set(machineRow.id, q);
        notify(machineRow.id, request);
        return cloneDoc({
            id, repo_full: `${row.owner_username}/${row.name}`, state: 'queued', machine_id: machineRow.id,
            created_at: new Date(now()).toISOString(), expires_at: expires, progress: null, path: null, reason: null,
        });
    }

    /**
     * The machine's own report on a clone it was asked to run, over its one-time token: waiting (it is asking its
     * owner), approved, cloning with git's percentage, done with the folder, refused or failed. Only the machine the
     * request was addressed to can move it, and only in order.
     */
    async function machineCloneUpdate({ machineId, token, id, body }) {
        const machineRow = await machineFor(machineId, token);
        if (!machineRow) return null;
        await touchMachine(machineId);
        const row = await store.maybe('SELECT * FROM git_clone_requests WHERE id = ?', [id]);
        if (!row || row.machine_id !== machineId) return null;
        if (TERMINAL.has(row.state)) return cloneDoc(row);
        if (UNSTARTED.has(row.state) && isExpired(row)) {
            await expire(row);
            return cloneDoc({ ...row, state: 'expired' });
        }
        const state = String(body.state || '');
        const from = {
            queued: ['waiting', 'approved', 'refused', 'failed'],
            waiting: ['approved', 'cloning', 'refused', 'failed'],
            approved: ['cloning', 'done', 'failed', 'refused'],
            cloning: ['cloning', 'done', 'failed', 'refused'],
        }[row.state] || [];
        if (!from.includes(state)) return cloneDoc(row);
        const progress = (state === 'cloning' || state === 'done') && body.progress && Number.isFinite(Number(body.progress.percent))
            ? { percent: Math.max(0, Math.min(100, Math.round(Number(body.progress.percent)))), line: String(body.progress.line || '').slice(0, 200) }
            : null;
        const path = state === 'done' ? String(body.path || '').slice(0, 4096) : null;
        const reason = (state === 'refused' || state === 'failed') ? String(body.reason || '').slice(0, 300) : null;
        await store.execute(
            `UPDATE git_clone_requests SET state = ?, progress = COALESCE(?, progress), path = COALESCE(?, path), reason = COALESCE(?, reason), updated_at = now() WHERE id = ?`,
            [state, progress ? JSON.stringify(progress) : null, path, reason, id],
        );
        if (TERMINAL.has(state)) {
            const secret = cloneURLs.get(id);
            cloneURLs.delete(id);
            if (secret) await store.execute('UPDATE git_tokens SET revoked_at = now() WHERE id = ? AND revoked_at IS NULL', [secret.token_id]).catch(() => {});
        }
        return cloneDoc({ ...row, state, progress: progress || row.progress, path: path || row.path, reason: reason || row.reason });
    }

    async function getForPage({ id, subject }) {
        const row = await store.maybe('SELECT * FROM git_clone_requests WHERE id = ?', [id]);
        if (!row || row.subject !== subject) return null;
        if (UNSTARTED.has(row.state) && isExpired(row)) await expire(row);
        return cloneDoc(row);
    }

    async function linkGet({ id, token }) {
        const row = await loadForLink(id, token);
        if (!row) return null;
        const doc = cloneDoc(row);
        if (UNSTARTED.has(row.state)) {
            const secret = cloneURLs.get(id);
            if (secret) doc.clone_url = secret.url;
        }
        return doc;
    }

    async function linkUpdate({ id, token, body }) {
        const row = await loadForLink(id, token);
        if (!row) return null;
        if (TERMINAL.has(row.state)) return cloneDoc(row);
        if (row.state === 'pending' && isExpired(row)) return cloneDoc({ ...row, state: 'expired' });
        const state = String(body.state || '');
        const allowed = (row.state === 'pending' && (state === 'approved' || state === 'refused'))
            || ((row.state === 'approved' || row.state === 'cloning') && (state === 'cloning' || state === 'done' || state === 'failed' || state === 'refused'));
        if (!allowed) return cloneDoc(row);
        const progress = state === 'cloning' && body.progress && Number.isFinite(Number(body.progress.percent))
            ? { percent: Math.max(0, Math.min(100, Math.round(Number(body.progress.percent)))), line: String(body.progress.line || '').slice(0, 200) }
            : null;
        const path = state === 'done' ? String(body.path || '').slice(0, 4096) : null;
        const reason = (state === 'refused' || state === 'failed') ? String(body.reason || '').slice(0, 300) : null;
        await store.execute(
            `UPDATE git_clone_requests SET state = ?, progress = COALESCE(?, progress), path = COALESCE(?, path), reason = COALESCE(?, reason), updated_at = now() WHERE id = ?`,
            [state, progress ? JSON.stringify(progress) : null, path, reason, id],
        );
        if (TERMINAL.has(state)) {
            const secret = cloneURLs.get(id);
            cloneURLs.delete(id);
            if (secret) await store.execute('UPDATE git_tokens SET revoked_at = now() WHERE id = ? AND revoked_at IS NULL', [secret.token_id]).catch(() => {});
        }
        return cloneDoc({ ...row, state, progress: progress || row.progress, path: path || row.path, reason: reason || row.reason });
    }

    // ── A published machine ─────────────────────────────────
    const machineDoc = (row) => {
        const online = row.last_seen_at && now() - Date.parse(row.last_seen_at) < OFFLINE_AFTER_MS;
        const repos = Array.isArray(row.repos) ? row.repos : JSON.parse(row.repos || '[]');
        return {
            id: row.id, name: row.name, os: row.os || undefined,
            online: Boolean(online),
            last_seen_at: row.last_seen_at || row.created_at,
            offline_since: online ? null : (row.last_seen_at || row.created_at),
            repos,
        };
    };

    async function createMachine({ viewer, name }) {
        if (!viewer || !viewer.subject) {
            throw Object.assign(new Error('Sign in to connect a computer.'), { status: 401, code: 'auth.required' });
        }
        const id = store.newId('mch');
        const token = newOpaque();
        await store.execute(
            `INSERT INTO git_machines (id, subject, owner_username, name, token_hash, repos, created_at) VALUES (?, ?, ?, ?, ?, '[]'::jsonb, now())`,
            [id, viewer.subject, viewer.username || 'you', String(name || 'this computer').slice(0, 80), hashToken(token)],
        );
        const link = `${config.baseUrl.replace(/\/+$/, '')}/api/v1/link/machines/${id}?token=${encodeURIComponent(token)}`;
        return { machine: { id, name: String(name || 'this computer').slice(0, 80), online: false, last_seen_at: null, offline_since: null, repos: [] }, link };
    }

    async function machineFor(id, token) {
        const row = await store.maybe('SELECT * FROM git_machines WHERE id = ?', [id]);
        if (!row || !safeEqual(hashToken(token), row.token_hash)) return null;
        return row;
    }

    async function machineHello({ id, token, body }) {
        const row = await machineFor(id, token);
        if (!row) return null;
        const wasOffline = !row.last_seen_at || now() - Date.parse(row.last_seen_at) >= OFFLINE_AFTER_MS;
        const name = String(body.name || row.name || 'this computer').slice(0, 80);
        const os = String(body.os || '').slice(0, 40) || null;
        const list = Array.isArray(body.repos) ? body.repos.slice(0, 500).filter(validMachineRepo) : [];
        await store.execute(
            `UPDATE git_machines SET name = ?, os = ?, repos = ?, last_seen_at = now(), offline_since = CASE WHEN ? THEN COALESCE(last_seen_at, created_at) ELSE NULL END WHERE id = ?`,
            [name, os, JSON.stringify(list), wasOffline, id],
        );
        return { ok: true };
    }

    async function touchMachine(id) {
        await store.execute('UPDATE git_machines SET last_seen_at = now(), offline_since = NULL WHERE id = ?', [id]).catch(() => {});
    }

    async function machineWatch({ id, token }) {
        const row = await machineFor(id, token);
        if (!row) return null;
        await touchMachine(id);
        const q = queue.get(id);
        // A clone request that waited out its two minutes is never handed over: it is over, and the page says so.
        while (q && q.length) {
            const next = q.shift();
            if (next.kind === 'clone') {
                const clone = await store.maybe('SELECT * FROM git_clone_requests WHERE id = ?', [next.clone_id]);
                if (!clone || TERMINAL.has(clone.state)) continue;
                if (isExpired(clone)) { await expire(clone); continue; }
            }
            return { online: true, request: next };
        }
        return await new Promise((resolve) => {
            const set = wake.get(id) || new Set();
            wake.set(id, set);
            let done = false;
            const finish = (value) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                set.delete(finish);
                resolve(value);
            };
            const timer = setTimeout(() => finish({ online: true }), WATCH_MS);
            set.add(finish);
        });
    }

    async function machineResult({ id, token, body }) {
        if (!(await machineFor(id, token))) return null;
        await touchMachine(id);
        const pending = inflight.get(String(body.request_id || ''));
        if (!pending || pending.machineId !== id) return { ok: true };
        clearTimeout(pending.timer);
        inflight.delete(String(body.request_id));
        pending.resolve({ ok: Boolean(body.ok), result: body.result, error: body.error });
        return { ok: true };
    }

    function notify(machineId, request) {
        const set = wake.get(machineId);
        if (!set || !set.size) return;
        const q = queue.get(machineId) || [];
        queue.set(machineId, q.filter((r) => r.id !== request.id));
        for (const finish of [...set]) finish({ online: true, request });
    }

    async function browse({ machineId, kind, repo, ref, path }) {
        const row = await store.maybe('SELECT * FROM git_machines WHERE id = ?', [machineId]);
        if (!row) return { state: 'missing' };
        const online = row.last_seen_at && now() - Date.parse(row.last_seen_at) < OFFLINE_AFTER_MS;
        if (!online) return { state: 'offline', offline_since: row.last_seen_at || row.created_at, machine: machineDoc(row) };
        const list = Array.isArray(row.repos) ? row.repos : JSON.parse(row.repos || '[]');
        if (!list.some((r) => r.name === repo)) return { state: 'missing' };
        const request = { id: newID('req'), kind, repo, ref: ref || '', path: path || '' };
        const q = queue.get(machineId) || [];
        q.push(request);
        queue.set(machineId, q);
        notify(machineId, request);
        return await new Promise((resolve) => {
            const timer = setTimeout(() => {
                inflight.delete(request.id);
                const left = (queue.get(machineId) || []).filter((r) => r.id !== request.id);
                queue.set(machineId, left);
                resolve({ state: 'timeout', machine: machineDoc(row) });
            }, BROWSE_MS);
            inflight.set(request.id, { machineId, timer, resolve: (value) => resolve({ state: 'ok', ...value, machine: machineDoc(row) }) });
        });
    }

    async function listMachines({ subject }) {
        const rows = await store.many('SELECT * FROM git_machines WHERE subject = ? ORDER BY created_at DESC', [subject]);
        return rows.map(machineDoc);
    }

    async function getMachine({ id, subject }) {
        const row = await store.maybe('SELECT * FROM git_machines WHERE id = ? AND subject = ?', [id, subject]);
        return row ? machineDoc(row) : null;
    }

    return {
        createClone, getForPage, linkGet, linkUpdate, createCloneToMachine, machineCloneUpdate,
        createMachine, machineHello, machineWatch, machineResult, listMachines, getMachine, browse,
        // For tests.
        CLONE_TTL_MS, OFFLINE_AFTER_MS,
    };
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function validMachineRepo(r) {
    if (!r || typeof r !== 'object') return false;
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(String(r.name || ''))) return false;
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(String(r.head || ''))) return false;
    return true;
}

module.exports = { createLinkRelay, CLONE_TTL_MS, OFFLINE_AFTER_MS };
