'use strict';

/**
 * Forge CI: the queue of runs the workstation runner executes, and the member rule that decides whether a push
 * may start one.
 *
 * A run exists only for a push to a branch of an official (OpenVibers) repository, made by a person GitHub says
 * may push there — the push event's own pusher, checked against the repository's collaborators (10 minutes of
 * cache) and always against the owning account. A fork, a pull request from a fork, a tag, a bot and a non-member
 * are skipped; those keep GitHub Actions. One run per repository is live: a newer push supersedes the queued or
 * running one, and the runner sees that on its heartbeat and stops.
 *
 * The verdict is copied into git_commit_statuses as `forge/test` (the same intake the GitHub check-runs use), and
 * posted to GitHub as a commit status on the same commit, so a pull request shows the forge's result too. The log
 * lives on the run so the forge can show it.
 */
const STATES = Object.freeze(['queued', 'running', 'success', 'failure', 'error', 'timed_out', 'superseded']);
const FINAL = new Set(['success', 'failure', 'error', 'timed_out']);
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,255}$/;
const MAX_LOG = 4 * 1024 * 1024;
const CONTEXT = 'forge/test';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const text = (value, max) => String(value == null ? '' : value).slice(0, max);

function cleanSha(sha) {
    const value = String(sha || '').toLowerCase();
    if (!SHA_RE.test(value)) throw fail(422, 'ci.sha_invalid', 'A run names the full commit id.');
    return value;
}

function cleanBranch(branch) {
    const value = String(branch || '');
    if (!BRANCH_RE.test(value) || value.includes('..') || value.startsWith('-') || value.endsWith('/') || value.endsWith('.lock')) {
        throw fail(422, 'ci.branch_invalid', 'A branch is 1–255 letters, digits, dots, dashes, underscores or slashes.');
    }
    return value;
}

function cleanCommand(value, fallback, code) {
    const command = String(value == null || value === '' ? fallback : value).trim();
    if (!command || command.length > 2000 || /[\u0000\r]/.test(command)) throw fail(422, code, 'A command is 1–2000 characters on one logical line.');
    return command;
}

function intBetween(value, fallback, min, max, code) {
    const n = value == null || value === '' ? fallback : parseInt(value, 10);
    if (!Number.isFinite(n) || n < min || n > max) throw fail(422, code, `The value is ${min}–${max}.`);
    return n;
}

function rowToRun(row, { baseUrl = '', owner = null, name = null, log = false } = {}) {
    if (!row) return null;
    const full = owner && name ? `${owner}/${name}` : null;
    return {
        id: row.id,
        repo: full,
        sha: row.sha,
        branch: row.branch,
        pusher: row.pusher || null,
        source: row.source,
        state: row.state,
        description: row.description || '',
        exit_code: row.exit_code == null ? null : Number(row.exit_code),
        log_bytes: Number(row.log_bytes) || 0,
        runner: row.runner || null,
        started_at: row.started_at || null,
        finished_at: row.finished_at || null,
        duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
        created_at: row.created_at,
        url: full ? `${String(baseUrl).replace(/\/+$/, '')}/${full}/ci/${row.id}` : null,
        ...(log ? { log: row.log || '' } : {}),
    };
}

function createCi({ config, store, checks, git, github, repos, log = console, clock = null }) {
    const settings = config.ci;
    const now = clock && clock.now ? () => clock.now() : () => store.now();
    const members = new Map();   // `${full}|${login}` → { at, value }
    let timer = null;

    const base = () => String(config.baseUrl || '').replace(/\/+$/, '');
    const runUrl = (row, id) => `${base()}/${row.owner_username}/${row.name}/ci/${id}`;
    const fullName = (row) => `${row.owner_username}/${row.name}`;

    /** A forge state as GitHub's status API names it. */
    const githubState = (state) => (state === 'success' ? 'success' : state === 'error' ? 'error' : state === 'pending' ? 'pending' : 'failure');

    /**
     * The same status on GitHub, so the pull request shows `forge/test` beside GitHub Actions. A token without
     * commit-status write, a commit GitHub does not know (a forge-only push) or a GitHub outage is logged and
     * never fails the run: the forge status is already written.
     */
    async function reportToGithub(row, sha, { state, description = '', target_url = '' }) {
        if (!settings.githubStatuses) return { ok: false, skipped: 'off' };
        if (!row || !row.github_full_name) return { ok: false, skipped: 'not-github' };
        try {
            await github.status(row.github_full_name, sha, {
                context: settings.context || CONTEXT, state: githubState(state), description, target_url,
            });
            return { ok: true };
        } catch (err) {
            log.warn(`[OpenVibe.Git] GitHub status ${row.github_full_name} ${String(sha).slice(0, 12)}: ${text(err.message, 200)}`);
            return { ok: false, error: err.status || 'unavailable' };
        }
    }

    async function settingsFor(repoId) {
        return await store.maybe('SELECT * FROM git_ci_repos WHERE repo_id = ?', [repoId]);
    }

    async function enabledFor(row) {
        if (!row || !row.official) return null;
        const conf = await settingsFor(row.id);
        return conf && conf.enabled ? conf : null;
    }

    /** A GitHub login may push to this repository: the owning account, a configured member, or a collaborator. */
    async function member({ full, login, owner = settings.org }) {
        const who = String(login || '').trim();
        if (!who) return { ok: false, why: 'no pusher' };
        const key = `${String(full).toLowerCase()}|${who.toLowerCase()}`;
        const hit = members.get(key);
        if (hit && now() - hit.at < settings.membershipCacheMs) return hit.value;
        let value;
        if (who.toLowerCase() === String(owner || '').toLowerCase()) {
            value = { ok: true, why: 'owner' };
        } else if (settings.members.includes(who.toLowerCase())) {
            value = { ok: true, why: 'member' };
        } else {
            try {
                const permission = await github.permission(full, who);
                value = { ok: ['admin', 'maintain', 'write'].includes(permission), why: permission || 'none' };
            } catch (err) {
                // Never run because GitHub could not answer: deny, and retry after a minute, not ten.
                const valueNow = { ok: false, why: `github:${err.status || 'unavailable'}` };
                members.set(key, { at: now() - settings.membershipCacheMs + 60_000, value: valueNow });
                log.warn(`[OpenVibe.Git] CI member check ${full} ${who}: ${text(err.message, 200)}`);
                return valueNow;
            }
        }
        members.set(key, { at: now(), value });
        return value;
    }

    /** Insert a run, superseding the repository's queued or running one first. */
    async function enqueue(row, { sha, branch, pusher = null, source = 'github', force = false } = {}) {
        const conf = await enabledFor(row);
        if (!conf) return { skipped: 'not-enabled' };
        const clean = cleanSha(sha);
        const ref = cleanBranch(branch);
        const live = await store.maybe("SELECT * FROM git_ci_runs WHERE repo_id = ? AND state IN ('queued', 'running')", [row.id]);
        if (!force && live && live.sha === clean && live.branch === ref) {
            return { skipped: 'duplicate', run: rowToRun(live, { baseUrl: base(), owner: row.owner_username, name: row.name }) };
        }
        const id = store.newId('cir');
        await store.execute(
            "UPDATE git_ci_runs SET state = 'superseded', description = ?, finished_at = now(), updated_at = now() WHERE repo_id = ? AND state IN ('queued', 'running')",
            [`Superseded by ${clean.slice(0, 12)}`, row.id],
        );
        try {
            await store.execute(
                `INSERT INTO git_ci_runs (id, repo_id, sha, branch, pusher, source, state, description)
                 VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
                [id, row.id, clean, ref, pusher ? text(pusher, 200) : null, text(source, 20), 'Queued on the forge runner'],
            );
        } catch (err) {
            if (/duplicate key|unique/i.test(String(err.message))) {
                const current = await store.maybe("SELECT * FROM git_ci_runs WHERE repo_id = ? AND state IN ('queued', 'running')", [row.id]);
                return { skipped: 'duplicate', run: rowToRun(current, { baseUrl: base(), owner: row.owner_username, name: row.name }) };
            }
            throw err;
        }
        const run = await store.maybe('SELECT * FROM git_ci_runs WHERE id = ?', [id]);
        await checks.recordIfChanged(row.id, clean, {
            context: settings.context || CONTEXT, state: 'pending', description: 'Queued on the forge runner', target_url: runUrl(row, id),
        }, 'svc:forge-runner').catch((err) => log.warn('[OpenVibe.Git] CI pending status:', err.message));
        await reportToGithub(row, clean, { state: 'pending', description: 'Queued on the forge runner', target_url: runUrl(row, id) });
        return { run: rowToRun(run, { baseUrl: base(), owner: row.owner_username, name: row.name }) };
    }

    /**
     * A GitHub push webhook. Runs only a branch push to the official repository that this mirror follows, by a
     * login GitHub says may push there. Everything else (fork, tag, deletion, PR, non-member, bot) is skipped.
     */
    async function onGithubPush(row, payload) {
        if (!settings.enabled) return { skipped: 'off' };
        if (!row || !row.official || !row.github_full_name) return { skipped: 'not-official' };
        const repo = (payload && payload.repository) || {};
        const full = String(repo.full_name || '');
        if (!full || full.toLowerCase() !== String(row.github_full_name).toLowerCase()) return { skipped: 'not-this-repository' };
        if (repo.fork) return { skipped: 'fork' };
        const owner = full.split('/')[0];
        if (owner.toLowerCase() !== settings.org.toLowerCase()) return { skipped: 'not-the-network' };
        if (payload.deleted) return { skipped: 'deleted' };
        const ref = String(payload.ref || '');
        if (!ref.startsWith('refs/heads/')) return { skipped: 'not-a-branch' };
        const after = String(payload.after || '');
        if (!SHA_RE.test(after.toLowerCase()) || /^0+$/.test(after)) return { skipped: 'no-commit' };
        const pusher = (payload.pusher && payload.pusher.name) || (payload.sender && payload.sender.login) || null;
        const who = await member({ full, login: pusher, owner });
        if (!who.ok) return { skipped: 'not-member', pusher, why: who.why };
        if (!(await enabledFor(row))) return { skipped: 'not-enabled' };
        const out = await enqueue(row, { sha: after, branch: ref.slice('refs/heads/'.length), pusher, source: 'github' });
        return { ...out, pusher, member: who.why };
    }

    /** A push that landed on the forge itself: only the network's own service tokens count as its members. */
    async function onForgePush(row, identity, { ref, sha, force = false } = {}) {
        if (!settings.enabled) return { skipped: 'off' };
        if (!row || !row.official) return { skipped: 'not-official' };
        if (!identity) return { skipped: 'no-identity' };
        if (identity.actor_type !== 'service' || !identity.scopes || !identity.scopes.has('git.repo.write')) {
            return { skipped: 'not-a-service' };
        }
        if (!String(ref || '').startsWith('refs/heads/')) return { skipped: 'not-a-branch' };
        if (!(await enabledFor(row))) return { skipped: 'not-enabled' };
        return await enqueue(row, { sha, branch: String(ref).slice('refs/heads/'.length), pusher: identity.subject || 'svc', source: 'forge', force });
    }

    /** The runner registers the repositories it is configured to test; only official ones are accepted. */
    async function registerRepos(list, actor = 'svc:forge-runner') {
        if (!Array.isArray(list) || !list.length || list.length > 100) throw fail(422, 'ci.repos_invalid', 'One to 100 repositories are registered.');
        const out = [];
        for (const item of list) {
            const full = String((item && (item.full_name || `${item.owner || ''}/${item.name || ''}`)) || '').trim();
            const [owner, name] = full.split('/');
            const row = owner && name ? await repos.getRow(owner.toLowerCase(), name.toLowerCase()) : null;
            if (!row || !row.official) throw fail(422, 'ci.repo_not_official', `Only an official repository can run on the forge: ${full || 'no name'}`);
            const body = {
                enabled: item.enabled !== false,
                install_command: cleanCommand(item.install_command, 'npm ci --no-audit --no-fund', 'ci.install_invalid'),
                test_command: cleanCommand(item.test_command, 'npm test', 'ci.test_invalid'),
                image: cleanCommand(item.image, 'docker.io/library/node:22-bookworm', 'ci.image_invalid'),
                timeout_seconds: intBetween(item.timeout_seconds, 1800, 30, 3600, 'ci.timeout_invalid'),
                cpus: intBetween(item.cpus, 4, 1, 8, 'ci.cpus_invalid'),
                memory_mb: intBetween(item.memory_mb, 6144, 512, 12288, 'ci.memory_invalid'),
            };
            if (body.image.length > 200) throw fail(422, 'ci.image_invalid', 'An image name is at most 200 characters.');
            await store.execute(
                `INSERT INTO git_ci_repos (repo_id, enabled, install_command, test_command, image, timeout_seconds, cpus, memory_mb, registered_by, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now())
                 ON CONFLICT (repo_id) DO UPDATE SET enabled = EXCLUDED.enabled, install_command = EXCLUDED.install_command,
                     test_command = EXCLUDED.test_command, image = EXCLUDED.image, timeout_seconds = EXCLUDED.timeout_seconds,
                     cpus = EXCLUDED.cpus, memory_mb = EXCLUDED.memory_mb, registered_by = EXCLUDED.registered_by, updated_at = now()`,
                [row.id, body.enabled, body.install_command, body.test_command, body.image, body.timeout_seconds, body.cpus, body.memory_mb, actor],
            );
            out.push({ full_name: fullName(row), ...body });
        }
        return out;
    }

    /** Start the current head (or a named commit) by hand: an owner, or the runner for its own checks. */
    async function manual(row, { sha = null, branch = null, pusher = null } = {}, actor = 'manual') {
        if (!(await enabledFor(row))) throw fail(409, 'ci.not_enabled', 'CI is not enabled for this repository.');
        const ref = cleanBranch(branch || row.default_branch || 'main');
        const wanted = sha ? cleanSha(sha) : await git.resolveCommit(row.owner_username, row.name, ref);
        if (!wanted) throw fail(422, 'ci.commit_missing', 'That branch or commit is not in this repository.');
        const found = await git.resolveCommit(row.owner_username, row.name, wanted);
        if (!found || String(found).toLowerCase() !== wanted) throw fail(422, 'ci.commit_missing', 'That commit is not in this repository.');
        const out = await enqueue(row, { sha: wanted, branch: ref, pusher: pusher || settings.org, source: 'manual', force: true });
        return { ...out, actor };
    }

    /** The next queued run, marked running. One runner claims one run at a time. */
    async function claim(runner = 'forge-runner') {
        const row = await store.maybe(
            `WITH next AS (
                 SELECT id FROM git_ci_runs WHERE state = 'queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
             )
             UPDATE git_ci_runs r SET state = 'running', started_at = now(), runner = ?, updated_at = now()
             FROM next WHERE r.id = next.id RETURNING r.*`,
            [text(runner, 100)],
        );
        if (!row) return null;
        const repo = await store.maybe('SELECT * FROM git_repos WHERE id = ?', [row.repo_id]);
        const conf = repo ? await settingsFor(repo.id) : null;
        if (!repo || !conf) {
            await finish(row.id, { state: 'error', description: 'The repository or its CI configuration disappeared' });
            return null;
        }
        return {
            run: rowToRun(row, { baseUrl: base(), owner: repo.owner_username, name: repo.name }),
            repo: {
                full_name: fullName(repo),
                clone_url: `${base()}/${repo.owner_username}/${repo.name}.git`,
                default_branch: repo.default_branch || 'main',
            },
            image: conf.image,
            command: { install: conf.install_command, test: conf.test_command },
            limits: { timeout_seconds: conf.timeout_seconds, cpus: conf.cpus, memory_mb: conf.memory_mb },
        };
    }

    async function runRow(id) {
        return await store.maybe('SELECT * FROM git_ci_runs WHERE id = ?', [text(id, 100)]);
    }

    async function repoOfRun(row) {
        return row ? await store.maybe('SELECT * FROM git_repos WHERE id = ?', [row.repo_id]) : null;
    }

    /** Whether a running run is still wanted (the runner asks every few seconds). */
    async function heartbeat(id) {
        const row = await runRow(id);
        if (!row) return { found: false, state: 'missing', superseded: true };
        return { found: true, state: row.state, superseded: row.state !== 'running' };
    }

    async function appendLog(id, chunk) {
        const row = await runRow(id);
        if (!row || row.state !== 'running') return { ok: false, state: row ? row.state : 'missing' };
        const piece = String(chunk == null ? '' : chunk);
        if (!piece) return { ok: true, log_bytes: Number(row.log_bytes) || 0 };
        let next = `${row.log || ''}${piece}`;
        if (next.length > MAX_LOG) next = `${next.slice(0, MAX_LOG)}\n[the rest of this log was too long to keep]\n`;
        const bytes = Buffer.byteLength(next, 'utf8');
        await store.execute('UPDATE git_ci_runs SET log = ?, log_bytes = ?, updated_at = now() WHERE id = ?', [next, bytes, id]);
        return { ok: true, log_bytes: bytes, truncated: next.length >= MAX_LOG };
    }

    /** The runner's verdict. A superseded run keeps the newer run's status; it is never overwritten. */
    async function finish(id, { state, description = '', exit_code = null, duration_ms = null } = {}) {
        const row = await runRow(id);
        if (!row) return { ok: false, state: 'missing' };
        if (row.state !== 'running') return { ok: false, state: row.state };
        if (!FINAL.has(state)) throw fail(422, 'ci.state_invalid', 'A final state is success, failure, error or timed_out.');
        const repo = await repoOfRun(row);
        const started = row.started_at ? Date.parse(row.started_at) : now();
        const elapsed = duration_ms == null ? Math.max(0, now() - started) : Math.max(0, Number(duration_ms) || 0);
        const word = state === 'timed_out' ? 'timed out' : state;
        const line = text(description, 1024) || `Forge runner ${word} in ${Math.round(elapsed / 1000)}s`;
        await store.execute(
            `UPDATE git_ci_runs SET state = ?, description = ?, exit_code = ?, duration_ms = ?, finished_at = now(), updated_at = now()
             WHERE id = ? AND state = 'running'`,
            [state, line, exit_code == null ? null : Number(exit_code), elapsed, id],
        );
        const checkState = state === 'success' ? 'success' : state === 'error' ? 'error' : 'failure';
        if (repo) {
            await checks.recordIfChanged(repo.id, row.sha, {
                context: settings.context || CONTEXT, state: checkState, description: line, target_url: runUrl(repo, id),
            }, 'svc:forge-runner').catch((err) => log.warn('[OpenVibe.Git] CI status:', err.message));
            await reportToGithub(repo, row.sha, { state: checkState, description: line, target_url: runUrl(repo, id) });
        }
        return { ok: true, run: rowToRun({ ...row, state, description: line, exit_code, duration_ms: elapsed, finished_at: new Date(now()).toISOString() }, { baseUrl: base(), owner: repo && repo.owner_username, name: repo && repo.name }) };
    }

    /** Fail a run whose runner disappeared: one left running past its own limit plus a minute cannot still be alive. */
    async function reap() {
        const rows = await store.many(
            `SELECT r.*, c.timeout_seconds FROM git_ci_runs r JOIN git_ci_repos c ON c.repo_id = r.repo_id
             WHERE r.state = 'running'`,
        );
        const out = [];
        for (const row of rows) {
            const started = row.started_at ? Date.parse(row.started_at) : 0;
            if (!started || now() - started < (Number(row.timeout_seconds) || 1800) * 1000 + 60_000) continue;
            const minutes = Math.round((Number(row.timeout_seconds) || 1800) / 60);
            out.push(await finish(row.id, { state: 'timed_out', description: `The runner stopped answering; timed out after ${minutes} minutes` }));
        }
        return out;
    }

    async function runsFor(row, { limit = 30 } = {}) {
        const rows = await store.many('SELECT * FROM git_ci_runs WHERE repo_id = ? ORDER BY created_at DESC LIMIT ?', [row.id, Math.max(1, Math.min(100, Number(limit) || 30))]);
        return rows.map((r) => rowToRun(r, { baseUrl: base(), owner: row.owner_username, name: row.name }));
    }

    async function runFor(row, id) {
        const run = await store.maybe('SELECT * FROM git_ci_runs WHERE id = ? AND repo_id = ?', [text(id, 100), row.id]);
        return rowToRun(run, { baseUrl: base(), owner: row.owner_username, name: row.name, log: true });
    }

    async function configFor(row) {
        return await settingsFor(row.id);
    }

    function start() {
        if (timer || !settings.enabled) return false;
        timer = setInterval(() => { reap().catch((err) => log.warn('[OpenVibe.Git] CI reap:', err.message)); }, settings.reapMs);
        timer.unref();
        return true;
    }

    function stop() { if (timer) clearInterval(timer); timer = null; }

    return {
        onGithubPush, onForgePush, registerRepos, manual, enqueue, claim, heartbeat, appendLog, finish, reap,
        runsFor, runFor, configFor, settingsFor, enabledFor, member, rowToRun, start, stop,
        STATES, CONTEXT, SHA_RE, BRANCH_RE,
    };
}

module.exports = { createCi, rowToRun, cleanSha, cleanBranch, STATES, CONTEXT };
