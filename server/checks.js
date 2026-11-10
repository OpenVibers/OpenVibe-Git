'use strict';

/**
 * Commit statuses: what CI says about a commit. A service with git.checks.write reports
 * {context, state, description, target_url} per commit; reads take the latest row per context.
 *
 * A change is mergeable when every required context is green. Required contexts are a per-repository list,
 * empty by default, so nothing changes until an owner sets one.
 */
const STATES = Object.freeze(['pending', 'success', 'failure', 'error']);
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// A context names a CI verdict ("test", "security/secrets"): visible characters, no control bytes.
const CONTEXT_RE = /^[^\u0000-\u001f\u007f]{1,255}$/;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

function cleanSha(sha) {
    const value = String(sha || '').toLowerCase();
    if (!SHA_RE.test(value)) throw fail(422, 'status.sha_invalid', 'A status names the full commit id.');
    return value;
}

function cleanStatus(body) {
    const context = String((body && body.context) || '').trim();
    if (!CONTEXT_RE.test(context)) throw fail(422, 'status.context_invalid', 'A context is 1–255 visible characters.');
    const state = String((body && body.state) || '');
    if (!STATES.includes(state)) throw fail(422, 'status.state_invalid', 'A state is pending, success, failure or error.');
    const description = String((body && body.description) || '');
    if (description.length > 1024) throw fail(422, 'status.description_invalid', 'A description is at most 1024 characters.');
    const targetUrl = String((body && (body.target_url || body.targetUrl)) || '');
    if (targetUrl.length > 2048) throw fail(422, 'status.target_url_invalid', 'A target URL is at most 2048 characters.');
    if (targetUrl && !/^https?:\/\/[^/\s]+\//.test(`${targetUrl}/`)) throw fail(422, 'status.target_url_invalid', 'A target URL is http(s).');
    return { context, state, description, target_url: targetUrl };
}

function cleanRequired(value) {
    const list = Array.isArray(value) ? value : null;
    if (!list) throw fail(422, 'checks.required_invalid', 'Required checks are a list of contexts.');
    const contexts = [...new Set(list.map((c) => String(c || '').trim()).filter(Boolean))];
    if (contexts.length > 50) throw fail(422, 'checks.required_invalid', 'At most 50 required contexts.');
    for (const context of contexts) {
        if (!CONTEXT_RE.test(context)) throw fail(422, 'checks.required_invalid', 'A context is 1–255 visible characters.');
    }
    return contexts;
}

const rowToStatus = (row) => ({
    context: row.context, state: row.state, description: row.description || '',
    target_url: row.target_url || '', created_at: row.created_at,
});

function createChecks({ store, log = console }) {
    /** Record one verdict. Returns the stored status. */
    async function record(repoId, sha, body, creator = null) {
        const clean = cleanStatus(body);
        const id = store.newId('cst');
        await store.execute(
            'INSERT INTO git_commit_statuses (id, repo_id, sha, context, state, description, target_url, creator_subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [id, repoId, cleanSha(sha), clean.context, clean.state, clean.description, clean.target_url, creator],
        );
        const row = await store.one('SELECT * FROM git_commit_statuses WHERE id = ?', [id]);
        return rowToStatus(row);
    }

    /** The latest verdict per context for a commit, oldest context first. */
    async function latest(repoId, sha) {
        const rows = await store.many(
            `SELECT DISTINCT ON (context) * FROM git_commit_statuses
             WHERE repo_id = ? AND sha = ? ORDER BY context, created_at DESC, id DESC`,
            [repoId, cleanSha(sha)],
        );
        return rows.map(rowToStatus).sort((a, b) => (a.context < b.context ? -1 : 1));
    }

    /** Insert only when the latest verdict for the context differs; the intake calls this. */
    async function recordIfChanged(repoId, sha, body, creator = null) {
        const clean = cleanStatus(body);
        const current = await store.maybe(
            'SELECT * FROM git_commit_statuses WHERE repo_id = ? AND sha = ? AND context = ? ORDER BY created_at DESC, id DESC LIMIT 1',
            [repoId, cleanSha(sha), clean.context],
        );
        if (current && current.state === clean.state && (current.description || '') === clean.description && (current.target_url || '') === clean.target_url) {
            return { status: rowToStatus(current), changed: false };
        }
        return { status: await record(repoId, sha, clean, creator), changed: true };
    }

    /** The combined verdict: a failure beats an error beats a pending beats success; null when there are none. */
    function combined(statuses) {
        if (!statuses.length) return null;
        if (statuses.some((s) => s.state === 'failure')) return 'failure';
        if (statuses.some((s) => s.state === 'error')) return 'error';
        if (statuses.some((s) => s.state === 'pending')) return 'pending';
        return 'success';
    }

    /** The one line a change page shows next to the checks. */
    function label(statuses) {
        if (!statuses.length) return 'No checks';
        const failed = statuses.filter((s) => s.state === 'failure' || s.state === 'error').length;
        const pending = statuses.filter((s) => s.state === 'pending').length;
        const total = statuses.length;
        const noun = total === 1 ? 'check' : 'checks';
        if (failed) return `${failed} of ${total} ${noun} failed`;
        if (pending) return `${pending} of ${total} ${noun} pending`;
        return `${total} ${noun} passed`;
    }

    function requiredFor(row) {
        try {
            const list = typeof row.required_checks === 'string' ? JSON.parse(row.required_checks || '[]') : (row.required_checks || []);
            return Array.isArray(list) ? list.filter((c) => typeof c === 'string') : [];
        } catch (err) {
            log.warn('[OpenVibe.Git] required checks not read:', err.message);
            return [];
        }
    }

    async function setRequired(row, value) {
        const contexts = cleanRequired(value);
        await store.execute('UPDATE git_repos SET required_checks = ?, updated_at = now() WHERE id = ?', [JSON.stringify(contexts), row.id]);
        return contexts;
    }

    /**
     * Whether a commit may merge: every required context green. Empty requirements merge. A fork's head is
     * read from its own repository (repoId); the required list always comes from the target.
     */
    async function mergeable(row, sha, { repoId } = {}) {
        const required = requiredFor(row);
        const checks = await latest(repoId || row.id, sha);
        const byContext = new Map(checks.map((s) => [s.context, s]));
        const missing = required.filter((c) => !byContext.has(c) || byContext.get(c).state !== 'success');
        return {
            mergeable: missing.length === 0,
            state: combined(checks),
            checks,
            checks_label: label(checks),
            required: required.map((context) => ({ context, state: byContext.has(context) ? byContext.get(context).state : null, ok: byContext.has(context) && byContext.get(context).state === 'success' })),
        };
    }

    return { STATES, record, recordIfChanged, latest, combined, label, requiredFor, setRequired, mergeable, cleanStatus, cleanSha };
}

module.exports = { createChecks, STATES };
