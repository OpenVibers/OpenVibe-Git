'use strict';

/**
 * A repository's insights: page views and unique visitors, clones, stars and commits per week, per day over a
 * window. A view and a clone are kept as a hashed visitor (sha256 of address or subject + the day): we can count
 * a person once a day and never learn who they were. Public for a public repository.
 */
const crypto = require('node:crypto');

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const hash = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);

function createInsights({ store, log = console }) {
    async function recordView(repo, { address = '', userAgent = '', subject = null }) {
        const day = dayOf(store.now());
        const visitor = hash(address || subject || 'anonymous', userAgent.slice(0, 120), day);
        try {
            await store.execute(
                `INSERT INTO git_views (repo_id, day, visitor_hash, views) VALUES (?, ?, ?, 1)
                 ON CONFLICT (repo_id, day, visitor_hash) DO UPDATE SET views = git_views.views + 1`,
                [repo.id, day, visitor],
            );
        } catch (err) { log.warn('[OpenVibe.Git] view not recorded:', err.message); }
    }

    async function recordClone(repo, { address = '', subject = null }) {
        const day = dayOf(store.now());
        const who = hash(subject || address || 'anonymous', day);
        try {
            await store.execute(
                `INSERT INTO git_clones (repo_id, day, subject_hash, count) VALUES (?, ?, ?, 1)
                 ON CONFLICT (repo_id, day, subject_hash) DO UPDATE SET count = git_clones.count + 1`,
                [repo.id, day, who],
            );
        } catch (err) { log.warn('[OpenVibe.Git] clone not recorded:', err.message); }
    }

    /** The contract shape: totals, a daily series, and commits per week from the default branch. */
    async function forRepo(repo, { days = 30, commitsPerWeek = async () => [] } = {}) {
        const span = Math.max(1, Math.min(90, Number(days) || 30));
        const since = dayOf(store.now() - (span - 1) * 86400_000);
        const [viewsRows, cloneRows, starRows, totalStars] = await Promise.all([
            store.many('SELECT day, sum(views)::int AS views, count(*)::int AS uniques FROM git_views WHERE repo_id = ? AND day >= ? GROUP BY day', [repo.id, since]),
            store.many('SELECT day, sum(count)::int AS clones FROM git_clones WHERE repo_id = ? AND day >= ? GROUP BY day', [repo.id, since]),
            store.many('SELECT to_char(created_at, \'YYYY-MM-DD\') AS day, count(*)::int AS stars FROM git_stars WHERE repo_id = ? AND created_at >= ? GROUP BY 1', [repo.id, new Date(store.now() - (span - 1) * 86400_000).toISOString()]),
            store.value('SELECT count(*)::int FROM git_stars WHERE repo_id = ?', [repo.id]),
        ]);
        const viewBy = new Map(viewsRows.map((r) => [String(r.day).slice(0, 10), r]));
        const cloneBy = new Map(cloneRows.map((r) => [String(r.day).slice(0, 10), r.clones]));
        const starBy = new Map(starRows.map((r) => [String(r.day).slice(0, 10), r.stars]));
        const daily = [];
        let views = 0; let unique = 0; let clones = 0; let inWindow = 0;
        for (let i = span - 1; i >= 0; i -= 1) {
            const day = dayOf(store.now() - i * 86400_000);
            const v = viewBy.get(day) || { views: 0, uniques: 0 };
            const c = cloneBy.get(day) || 0;
            const s = starBy.get(day) || 0;
            views += v.views; unique += v.uniques; clones += c; inWindow += s;
            daily.push({ day, views: v.views, unique_visitors: v.uniques, clones: c, stars: s });
        }
        return {
            repo: repo.full_name || `${repo.owner_username}/${repo.name}`,
            window_days: span,
            views,
            unique_visitors: unique,
            clones,
            stars: { total: Number(totalStars) || 0, in_window: inWindow },
            commits_per_week: await commitsPerWeek(),
            daily,
        };
    }

    return { recordView, recordClone, forRepo };
}

module.exports = { createInsights, dayOf, hash };
