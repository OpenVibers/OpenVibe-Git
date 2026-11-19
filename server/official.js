'use strict';

/**
 * The official mirrors seed: every public repository in the GitHub organisation named by GIT_OFFICIAL_ORG becomes
 * a mirror under the official OpenVibe owner (GIT_OFFICIAL_OWNER, by default the first of GIT_OFFICIAL_OWNERS).
 * This is the one thing the Forgejo cut-over keeps: the mirror list is rebuilt from the network's own contracts.
 *
 * The job is due-based, not timer-based: the last finished run is a row in the database (git_official_state,
 * migration 0002), so a deploy — and this service is deployed much more often than every six hours — does not
 * reset the interval. A tick runs shortly after boot and then hourly, and only does the work when the interval
 * has passed.
 *
 * No REST quota is needed:
 *   - the list comes from GitHub's REST API when it answers, and from openvibe-contracts manifests/services and
 *     manifests/repositories when it does not (403/429/5xx/network); the run's summary says which;
 *   - each candidate is checked as public and existing through git's protocol (ls-refs over github.com, which
 *     spends no REST quota) and names the default branch; private and missing repositories are skipped and counted;
 *   - a mirror is created through repos.create, which clones with the mirror timeout even when the metadata call
 *     is refused, marking the card pending for a later run.
 *
 * Names follow this service's rule: lower-case, no leading dot, never ending in .git — "OpenVibe.Live" becomes
 * "openvibe.live". Nothing is ever deleted. Clones run a few at a time. One line per run says where the list came
 * from, how many were created, already existed, skipped (with the reason) and failed.
 *
 * It runs in the background: /api/ready never waits on it, and a failed run is logged and retried at the next
 * due time. An empty GIT_OFFICIAL_ORG keeps it off, and so does drill mode. stop() ends a run at the next
 * candidate; a run that was stopped is not recorded as finished, so the next boot tries again.
 */
const { validName } = require('./git/refs');
const { contractRepositories } = require('./contracts');

const STATE_ID = 'official-mirrors';
const FIRST_RUN_MS = 30_000;             // shortly after boot, not in the boot path
// How often the due check is asked: a fifth of the sync interval (at most 15 minutes), so a run due a second after a
// tick waits minutes, not a whole interval (11-09: the hourly tick fired 1 s before each due time and skipped every
// other hour, while the host's GitHub quota had come back).
const TICK_MS = 15 * 60_000;

function createOfficialMirrors({ store, repos, config, github, log = console, clock = null, contractList = null }) {
    const settings = config.official;
    const now = clock && clock.now ? () => clock.now() : () => store.now();
    const iso = () => new Date(now()).toISOString();
    let running = false;
    let stopped = false;
    let timer = null;
    let first = null;

    const enabled = () => Boolean(settings.org) && !config.drill;
    const listContracts = contractList || contractRepositories;

    /**
     * One repository of the organisation becomes an official mirror, unless it is a fork, archived, private, has a name
     * this service cannot hold, or is already here. Used by the run over the whole list, and by GitHub's signed push
     * webhook for a repository the forge does not have yet (2026-11-19): the host's unauthenticated GitHub quota refuses
     * the listing most of the time and the contracts lag behind new services (Finance and Markets were missing), so a
     * public OpenVibers repository now appears the first time GitHub tells the forge about a push to it.
     * Returns { created } | { existing, row } | { skipped: 'fork'|'archived'|'private'|'missing'|'invalid' } | { failed }.
     */
    async function adopt(repo, { stoppedNow = () => false } = {}) {
        if (!repo) return { skipped: 'invalid' };
        if (repo.fork) return { skipped: 'fork' };
        if (repo.archived) return { skipped: 'archived' };
        const full = String(repo.full_name || '');
        if (repo.private) {
            log.warn(`[OpenVibe.Git] official mirrors: ${full || repo.name} is private (skipped)`);
            return { skipped: 'private' };
        }
        const name = String(repo.name || full.split('/')[1] || '').toLowerCase();
        if (!validName(name)) {
            log.warn(`[OpenVibe.Git] official mirrors: ${full || name} is not a valid repository name here (${name})`);
            return { skipped: 'invalid' };
        }
        const existing = await repos.getRow(settings.owner, name);
        if (existing) return { existing: true, row: existing };

        // Public and existing through git's own protocol: no REST quota, and the default branch comes with it.
        const info = await github.probe(full).catch(() => null);
        if (info && info.state === 'private') {
            log.warn(`[OpenVibe.Git] official mirrors: ${full} is private (skipped)`);
            return { skipped: 'private' };
        }
        if (info && info.state === 'missing') {
            log.warn(`[OpenVibe.Git] official mirrors: ${full} does not exist (skipped)`);
            return { skipped: 'missing' };
        }
        if (info && info.state === 'invalid') {
            log.warn(`[OpenVibe.Git] official mirrors: ${full} is not a valid GitHub repository name (skipped)`);
            return { skipped: 'invalid' };
        }
        if (stoppedNow()) return {};

        // repos.create checks the GitHub URL, reads the metadata (pending when refused) and clones with the mirror
        // timeout. The probe's answer saves the second ls-refs and names the default branch.
        try {
            await repos.create({
                actor: { username: settings.owner, subject: null },
                name,
                mirrorUrl: repo.clone_url || `https://github.com/${full}.git`,
                mirrorInfo: info,
            });
            return { created: true };
        } catch (err) {
            if (err && err.status === 409) return { existing: true, row: await repos.getRow(settings.owner, name) };
            log.warn(`[OpenVibe.Git] official mirror ${full || name}: ${String(err.message || err).slice(0, 300)}`);
            return { failed: true };
        }
    }

    /**
     * GitHub's signed push (or create) webhook for a repository the forge has no mirror of: adopt it when it belongs
     * to the official organisation. The signature was checked by the caller; nothing a person typed names the URL.
     */
    async function adoptFromWebhook(repository) {
        if (!enabled() || !repository) return { skipped: 'off' };
        const full = String(repository.full_name || '');
        const owner = full.split('/')[0] || (repository.owner && repository.owner.login) || '';
        if (!owner || owner.toLowerCase() !== String(settings.org).toLowerCase()) return { skipped: 'not-the-organisation' };
        const out = await adopt(repository);
        if (out.created) log.log(`[OpenVibe.Git] official mirrors: ${full} adopted from GitHub's push webhook`);
        return out;
    }

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

    /** Fill a mirror's card from the REST metadata once the API answers again; a quota refusal stops the attempts. */
    async function fillPending(row, state) {
        if (!row || !row.github_full_name || row.mirror_meta_state !== 'pending' || state.refused) return false;
        try {
            const meta = await github.meta(row.github_full_name);
            const topics = meta.topics && meta.topics.length ? meta.topics : (typeof row.topics === 'string' ? JSON.parse(row.topics || '[]') : (row.topics || []));
            await store.execute(
                `UPDATE git_repos SET description = ?, topics = ?, default_branch = ?, mirror_meta_state = 'ready', updated_at = now() WHERE id = ?`,
                [meta.description || row.description || '', JSON.stringify(topics), meta.default_branch || row.default_branch, row.id],
            );
            return true;
        } catch (err) {
            if (err && (err.status === 403 || err.status === 429)) state.refused = true;
            return false;
        }
    }

    /** One pass over the list: create what is missing, count what is already there, delete nothing. */
    async function run() {
        const summary = {
            org: settings.org, owner: settings.owner, source: null, listed: 0, created: 0, existing: 0, failed: 0,
            skipped: { private: 0, missing: 0, invalid: 0, fork: 0, archived: 0 }, metadata_pending: 0, ok: false,
        };
        if (!settings.org) {
            summary.off = true;
            log.log('[OpenVibe.Git] official mirrors: off (GIT_OFFICIAL_ORG is empty)');
            return summary;
        }
        if (stopped) {
            summary.stopped = true;
            return summary;
        }

        // Where the list comes from: GitHub's REST API, or the network's own contracts when that is refused.
        let listed = [];
        let listError = null;
        const state = { refused: false };
        try {
            listed = await github.orgRepos(settings.org);
            summary.source = 'github';
        } catch (err) {
            listError = err;
            summary.source = 'contracts';
            if (err && (err.status === 403 || err.status === 429)) state.refused = true;
            try {
                listed = listContracts();
            } catch (listErr) {
                listed = [];
                summary.contract_error = String(listErr.message || listErr).slice(0, 200);
            }
            summary.listing_error = String(err.message || err).slice(0, 300);
            log.warn(`[OpenVibe.Git] official mirrors: GitHub listing ${settings.org} refused (${summary.listing_error}); `
                + `using ${listed.length} repositories from the contracts`);
        }
        summary.listed = Array.isArray(listed) ? listed.length : 0;
        if (!summary.listed) {
            summary.failed = 1;
            summary.error = listError ? String(listError.message || listError).slice(0, 300) : 'no repositories listed';
            log.log(`[OpenVibe.Git] official mirrors: source ${summary.source}, created 0, existing 0, failed 1`);
            return summary;
        }

        async function one(repo) {
            if (stopped || !repo) return;
            const out = await adopt(repo, { stoppedNow: () => stopped });
            if (out.skipped) summary.skipped[out.skipped] += 1;
            else if (out.existing) {
                summary.existing += 1;
                if (out.row && out.row.mirror_meta_state === 'pending') await fillPending(out.row, state);
            } else if (out.created) summary.created += 1;
            else if (out.failed) summary.failed += 1;
        }

        // A few clones at once, not the whole list: GitHub sees a handful of connections and the host stays usable.
        const limit = Math.max(1, Math.min(8, Number(settings.concurrency) || 3));
        let cursor = 0;
        const workers = Array.from({ length: Math.min(limit, summary.listed) }, async () => {
            while (!stopped) {
                const index = cursor;
                cursor += 1;
                if (index >= summary.listed) return;
                await one(listed[index]);
            }
        });
        await Promise.all(workers);

        if (stopped) {
            summary.stopped = true;
        } else {
            summary.metadata_pending = Number(await store.value(
                "SELECT count(*)::int FROM git_repos WHERE mirror_url IS NOT NULL AND mirror_meta_state = 'pending'",
            )) || 0;
        }
        summary.ok = summary.failed === 0;
        const skipped = summary.skipped;
        const skippedTotal = skipped.private + skipped.missing + skipped.invalid + skipped.fork + skipped.archived;
        log.log(`[OpenVibe.Git] official mirrors: source ${summary.source}, created ${summary.created}, existing ${summary.existing}, `
            + `skipped ${skippedTotal} (private ${skipped.private}, missing ${skipped.missing}, invalid ${skipped.invalid}, `
            + `fork ${skipped.fork}, archived ${skipped.archived}), failed ${summary.failed}`
            + (summary.metadata_pending ? `, metadata pending ${summary.metadata_pending}` : ''));
        return summary;
    }

    /** Run when due. The in-process guard keeps the hourly tick from stacking runs; the state row spans restarts. */
    async function tick() {
        if (!enabled()) return { ran: false, reason: config.drill ? 'drill' : 'off' };
        if (stopped) return { ran: false, reason: 'stopped' };
        if (running) return { ran: false, reason: 'running' };
        running = true;
        try {
            const last = await lastRun();
            const dueAt = (last.at || 0) + settings.syncMs;
            if (last.at && now() < dueAt) return { ran: false, reason: 'not due', due_at: new Date(dueAt).toISOString() };
            const summary = await run();
            if (!summary.stopped) await recordRun(summary);
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
        timer = setInterval(check, Math.max(60_000, Math.min(TICK_MS, Math.round(settings.syncMs / 5))));
        timer.unref();
        return true;
    }

    function stop() {
        stopped = true;
        if (first) clearTimeout(first);
        if (timer) clearInterval(timer);
        first = null;
        timer = null;
    }

    return { run, tick, start, stop, enabled, lastRun, adopt, adoptFromWebhook, STATE_ID };
}

module.exports = { createOfficialMirrors, STATE_ID, FIRST_RUN_MS, TICK_MS };
