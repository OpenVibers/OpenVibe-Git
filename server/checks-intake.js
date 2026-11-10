'use strict';

/**
 * Checks intake from GitHub, read-only: our pages show the truth today. For a mirrored repository it copies
 * the check-runs of the head commits of the open GitHub pull requests and of the default branch into commit
 * statuses, so a change page shows GitHub's CI until our own runners report.
 *
 * Few API calls: the default branch's head is read from our own mirror (free); the open PRs cost one call;
 * check-runs are asked only for heads that moved since the last run. A repository is visited at most once
 * every two minutes. The GitHub token is the mirror's own (config.github.token); it is sent, never logged.
 * Off in drill mode, like the mirror poll.
 */
const MIN_MS = 2 * 60_000;   // at most once every two minutes per repository
const TICK_MS = 60_000;      // the tick that looks for due repositories
const CREATOR = 'github-intake';

/** A GitHub check-run → a status, or null when it names nothing. */
function mapRun(run) {
    const context = String((run && run.name) || '').trim().slice(0, 255);
    if (!context) return null;
    let state = 'pending';
    if (run.status === 'completed') {
        switch (run.conclusion) {
            case 'success': case 'neutral': case 'skipped': state = 'success'; break;
            case 'failure': state = 'failure'; break;
            default: state = 'error'; break;   // cancelled, timed_out, action_required, stale, …
        }
    }
    const description = String((run.output && run.output.title) || run.conclusion || run.status || '').slice(0, 1024);
    const target = String(run.html_url || run.details_url || '').slice(0, 2048);
    return { context, state, description, target_url: /^https?:\/\//.test(target) ? target : '' };
}

function createChecksIntake({ store, checks, config, git, github, log = console }) {
    /** Copy one mirrored repository's check-runs. force skips the two-minute throttle (tests, sync now). */
    async function syncRepo(row, { force = false } = {}) {
        if (!row || !row.mirror_url || !row.github_full_name) return { ok: false, skipped: 'not-mirrored' };
        const full = row.github_full_name;
        const sync = await store.maybe('SELECT * FROM git_checks_sync WHERE repo_id = ?', [row.id]);
        const lastAt = sync && sync.last_run_at ? Date.parse(sync.last_run_at) : 0;
        if (!force && lastAt && store.now() - lastAt < MIN_MS) return { ok: true, skipped: 'recent' };
        const stored = (sync && typeof sync.heads === 'object' && sync.heads) || (sync && typeof sync.heads === 'string' ? JSON.parse(sync.heads || '{}') : {});
        const summary = { repo: `${row.owner_username}/${row.name}`, heads: 0, fetched: 0, copied: 0, ok: true };

        // The default branch's head from our own mirror: no API call.
        const heads = {};
        try {
            const main = await git.resolveCommit(row.owner_username, row.name, row.default_branch || 'main');
            if (main) heads.main = main;
        } catch (err) {
            log.warn(`[OpenVibe.Git] checks intake ${summary.repo}: ${String(err.message || err).slice(0, 200)}`);
        }
        let pulls = [];
        try {
            pulls = await github.openPulls(full);
        } catch (err) {
            summary.ok = false;
            summary.error = String(err.message || err).slice(0, 200);
        }
        for (const pr of pulls) heads[`pr/${pr.number}`] = pr.head_sha;
        summary.heads = Object.keys(heads).length;

        for (const [key, sha] of Object.entries(heads)) {
            if (stored[key] === sha) continue;   // only when the head moved
            let runs = [];
            try {
                runs = await github.checkRuns(full, sha);
                summary.fetched += 1;
            } catch (err) {
                summary.ok = false;
                summary.error = String(err.message || err).slice(0, 200);
                continue;
            }
            for (const run of runs) {
                const status = mapRun(run);
                if (!status) continue;
                try {
                    const { changed } = await checks.recordIfChanged(row.id, sha, status, CREATOR);
                    if (changed) summary.copied += 1;
                } catch (err) {
                    log.warn(`[OpenVibe.Git] checks intake ${summary.repo}: ${String(err.message || err).slice(0, 200)}`);
                }
            }
            stored[key] = sha;
        }
        // Heads that are gone (a closed PR) leave the map; a head whose fetch failed keeps no entry, so
        // the next run retries it. The throttle still applies after an error.
        const next = {};
        for (const key of Object.keys(heads)) if (stored[key]) next[key] = stored[key];
        await store.execute(
            `INSERT INTO git_checks_sync (repo_id, last_run_at, heads, last_result, updated_at)
             VALUES (?, now(), ?, ?, now())
             ON CONFLICT (repo_id) DO UPDATE SET last_run_at = now(), heads = EXCLUDED.heads,
                 last_result = EXCLUDED.last_result, updated_at = now()`,
            [row.id, JSON.stringify(next), JSON.stringify(summary)],
        );
        return summary;
    }

    /** Every mirrored repository that is due, two at a time. */
    async function tick() {
        const rows = await store.many(
            `SELECT r.* FROM git_repos r LEFT JOIN git_checks_sync s ON s.repo_id = r.id
             WHERE r.mirror_url IS NOT NULL AND r.github_full_name IS NOT NULL
             ORDER BY s.last_run_at ASC NULLS FIRST LIMIT 200`,
        );
        const out = [];
        for (let i = 0; i < rows.length; i += 2) {
            const batch = await Promise.all(rows.slice(i, i + 2).map((r) => syncRepo(r).catch((err) => {
                log.warn(`[OpenVibe.Git] checks intake ${r.owner_username}/${r.name}: ${String(err.message || err).slice(0, 200)}`);
                return { ok: false, error: String(err.message || err).slice(0, 200) };
            })));
            out.push(...batch);
        }
        return out;
    }

    let timer = null;
    return {
        syncRepo, tick, mapRun, MIN_MS, TICK_MS,
        start() {
            if (timer || config.drill) return false;
            timer = setInterval(() => { tick().catch((err) => log.warn('[OpenVibe.Git] checks intake:', err.message)); }, TICK_MS);
            timer.unref();
            return true;
        },
        stop() { if (timer) clearInterval(timer); timer = null; },
    };
}

module.exports = { createChecksIntake, mapRun, MIN_MS, TICK_MS };
