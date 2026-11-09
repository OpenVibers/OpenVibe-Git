'use strict';

/**
 * The official mirrors seed: every public repository in the GitHub organisation named by GIT_OFFICIAL_ORG becomes
 * a mirror under the official OpenVibe owner (GIT_OFFICIAL_OWNER, by default the first of GIT_OFFICIAL_OWNERS).
 * This is the one thing the Forgejo cut-over keeps: the mirror list is rebuilt from GitHub itself.
 *
 * The job is due-based, not timer-based: the last finished run is a row in the database (git_official_state,
 * migration 0002), so a deploy — and this service is deployed much more often than every six hours — does not
 * reset the interval. A tick runs shortly after boot and then hourly, and only does the work when the interval
 * has passed.
 *
 * A run lists all pages of the organisation's public repositories, skips forks and archived repositories, and
 * creates each missing one through repos.create (which clones with the mirror timeout). Names follow this
 * service's rule: lower-case, no leading dot, never ending in .git — "OpenVibe.Live" becomes "openvibe.live".
 * Nothing is ever deleted. One line per run says how many were created, already existed and failed.
 *
 * It runs in the background: /api/ready never waits on it, and a failed run is logged and retried at the next
 * due time. An empty GIT_OFFICIAL_ORG keeps it off, and so does drill mode.
 */
const { validName } = require('./git/refs');

const STATE_ID = 'official-mirrors';
const FIRST_RUN_MS = 30_000;             // shortly after boot, not in the boot path
const TICK_MS = 60 * 60_000;             // how often the due check is asked

function createOfficialMirrors({ store, repos, config, github, log = console, clock = null }) {
    const settings = config.official;
    const now = clock && clock.now ? () => clock.now() : () => store.now();
    const iso = () => new Date(now()).toISOString();
    let running = false;
    let timer = null;
    let first = null;

    const enabled = () => Boolean(settings.org) && !config.drill;

    /** When the last run finished and what it found. */
    async function lastRun() {
        const row = await store.maybe('SELECT last_run_at, last_result FROM git_official_state WHERE id = ?', [STATE_ID]);
        if (!row || !row.last_run_at) return { at: null, result: null };
        const at = new Date(row.last_run_at).getTime();
        const result = typeof row.last_result === 'string' ? JSON.parse(row.last_result || '{}') : (row.last_result || null);
        return { at: Number.isFinite(at) ? at : null, result };
    }

    async function recordRun(summary) {
        await store.execute(
            `INSERT INTO git_official_state (id, last_run_at, last_result, updated_at) VALUES (?, ?, ?, now())
             ON CONFLICT (id) DO UPDATE SET last_run_at = EXCLUDED.last_run_at,
                 last_result = EXCLUDED.last_result, updated_at = now()`,
            [STATE_ID, iso(), JSON.stringify(summary)],
        );
    }

    /** One pass over the organisation: create what is missing, count what is already there, delete nothing. */
    async function run() {
        const summary = { org: settings.org, owner: settings.owner, listed: 0, created: 0, existing: 0, failed: 0, ok: false };
        if (!settings.org) {
            summary.off = true;
            log.log('[OpenVibe.Git] official mirrors: off (GIT_OFFICIAL_ORG is empty)');
            return summary;
        }
        let listed;
        try {
            listed = await github.orgRepos(settings.org);
        } catch (err) {
            summary.failed = 1;
            summary.error = String(err.message || err).slice(0, 300);
            log.warn(`[OpenVibe.Git] official mirrors: listing ${settings.org}: ${summary.error}`);
            log.log(`[OpenVibe.Git] official mirrors: created ${summary.created}, existing ${summary.existing}, failed ${summary.failed}`);
            return summary;
        }
        summary.listed = listed.length;
        for (const repo of listed) {
            if (!repo || repo.fork || repo.archived || repo.private) continue;
            const name = String(repo.name || '').toLowerCase();
            if (!validName(name)) {
                summary.failed += 1;
                log.warn(`[OpenVibe.Git] official mirrors: ${repo.full_name || repo.name} is not a valid repository name here (${name})`);
                continue;
            }
            if (await repos.getRow(settings.owner, name)) {
                summary.existing += 1;
                continue;
            }
            // repos.create checks the GitHub URL, reads the metadata and clones with config.mirrors.timeoutMs.
            try {
                await repos.create({
                    actor: { username: settings.owner, subject: null },
                    name,
                    mirrorUrl: repo.clone_url || `https://github.com/${settings.org}/${repo.name}.git`,
                });
                summary.created += 1;
            } catch (err) {
                if (err && err.status === 409) { summary.existing += 1; continue; }
                summary.failed += 1;
                log.warn(`[OpenVibe.Git] official mirror ${settings.org}/${repo.name}: ${String(err.message || err).slice(0, 300)}`);
            }
        }
        summary.ok = summary.failed === 0;
        log.log(`[OpenVibe.Git] official mirrors: created ${summary.created}, existing ${summary.existing}, failed ${summary.failed}`);
        return summary;
    }

    /** Run when due. The in-process guard keeps the hourly tick from stacking runs; the state row spans restarts. */
    async function tick() {
        if (!enabled()) return { ran: false, reason: config.drill ? 'drill' : 'off' };
        if (running) return { ran: false, reason: 'running' };
        running = true;
        try {
            const last = await lastRun();
            const dueAt = (last.at || 0) + settings.syncMs;
            if (last.at && now() < dueAt) return { ran: false, reason: 'not due', due_at: new Date(dueAt).toISOString() };
            const summary = await run();
            await recordRun(summary);
            return { ran: true, ...summary };
        } finally {
            running = false;
        }
    }

    function start() {
        if (!enabled() || timer || first) return false;
        const check = () => tick().catch((err) => log.warn('[OpenVibe.Git] official mirrors:', err.message));
        first = setTimeout(() => { first = null; check(); }, FIRST_RUN_MS);
        first.unref();
        timer = setInterval(check, Math.max(60_000, Math.min(TICK_MS, settings.syncMs)));
        timer.unref();
        return true;
    }

    function stop() {
        if (first) clearTimeout(first);
        if (timer) clearInterval(timer);
        first = null;
        timer = null;
    }

    return { run, tick, start, stop, enabled, lastRun, STATE_ID };
}

module.exports = { createOfficialMirrors, STATE_ID, FIRST_RUN_MS, TICK_MS };
