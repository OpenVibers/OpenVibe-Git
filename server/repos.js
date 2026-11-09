'use strict';

/**
 * Repositories as people meet them: the row, its counts, who may see and change it, the activity around it, and
 * the handful of queries the home and explore pages need. Git objects stay in server/git/store.js; this module
 * is the database side plus the decisions that are ours (visibility, ownership, official repositories).
 */
const { validName, validRepo } = require('./git/refs');
const { starterFiles } = require('./starters');
const { seal, open } = require('./crypto');

const PUBLIC_WHERE = "r.visibility = 'public'";
const SELECT_REPO = `SELECT r.*,
    (SELECT count(*) FROM git_stars s WHERE s.repo_id = r.id)::int AS stars,
    (SELECT count(*) FROM git_watches w WHERE w.repo_id = r.id)::int AS watchers,
    (SELECT count(*) FROM git_repos f WHERE f.fork_of = r.id)::int AS forks
  FROM git_repos r`;

function createRepos({ store, config, git, github, insights, log = console }) {
    const now = store.now;

    function rowToRepo(row, { card = null } = {}) {
        if (!row) return null;
        const base = config.baseUrl.replace(/\/+$/, '');
        const languages = typeof row.languages === 'string' ? JSON.parse(row.languages || '{}') : (row.languages || {});
        return {
            id: row.id,
            owner: { username: row.owner_username, subject: row.owner_subject, display_name: null, avatar_url: null },
            name: row.name,
            full_name: `${row.owner_username}/${row.name}`,
            description: row.description || '',
            visibility: row.visibility,
            default_branch: row.default_branch,
            topics: typeof row.topics === 'string' ? JSON.parse(row.topics || '[]') : (row.topics || []),
            stars: Number(row.stars) || 0,
            watchers: Number(row.watchers) || 0,
            forks: Number(row.forks) || 0,
            language: row.language || null,
            languages,
            html_url: `${base}/${row.owner_username}/${row.name}`,
            clone_url: `${base}/${row.owner_username}/${row.name}.git`,
            mirror: row.mirror_url ? { url: row.mirror_url, state: row.mirror_state, last_synced_at: row.mirror_last_synced_at || null, error: row.mirror_error || null } : null,
            github: card || null,
            created_at: row.created_at,
            updated_at: row.updated_at,
            pushed_at: row.pushed_at || null,
        };
    }

    async function byId(id) {
        return await store.maybe(`${SELECT_REPO} WHERE r.id = ?`, [id]);
    }

    async function getRow(owner, name) {
        if (!validName(owner) || !validName(name)) return null;
        return await store.maybe(`${SELECT_REPO} WHERE r.owner_username = ? AND r.name = ?`, [owner, name]);
    }

    const canView = (row, viewer) => Boolean(row) && (row.visibility === 'public' || (viewer && viewer.subject && viewer.subject === row.owner_subject));
    const isOwner = (row, viewer) => Boolean(row && viewer && viewer.subject && viewer.subject === row.owner_subject);

    /** The API's repository, with the GitHub card when it has a twin (cached upstream). */
    async function get(owner, name, { viewer = null, withCard = false } = {}) {
        const row = await getRow(owner, name);
        if (!row || !canView(row, viewer)) return null;
        let card = null;
        if (withCard && row.github_full_name) card = await github.card(row.github_full_name, { branch: row.default_branch }).catch(() => null);
        return rowToRepo(row, { card });
    }

    async function refreshLanguages(row) {
        try {
            const languages = await git.languages(row.owner_username, row.name, row.default_branch);
            const language = Object.keys(languages)[0] || null;
            await store.execute('UPDATE git_repos SET languages = ?, language = ?, updated_at = now() WHERE id = ?', [JSON.stringify(languages), language, row.id]);
            return languages;
        } catch (err) { log.warn('[OpenVibe.Git] languages not read:', err.message); return {}; }
    }

    async function recordEvent(row, type, actor, detail = {}) {
        try {
            await store.execute(
                'INSERT INTO git_events (id, repo_id, type, actor_subject, actor_username, detail) VALUES (?, ?, ?, ?, ?, ?)',
                [store.newId('evt'), row.id, type, actor && actor.subject, actor && actor.username, JSON.stringify(detail)],
            );
        } catch (err) { log.warn('[OpenVibe.Git] event not recorded:', err.message); }
    }

    async function audit(actor, action, row, detail = {}, address = null) {
        try {
            await store.execute(
                'INSERT INTO git_audit (actor_subject, action, repo_id, detail, address) VALUES (?, ?, ?, ?, ?)',
                [actor && actor.subject, action, row ? row.id : null, JSON.stringify(detail), address],
            );
        } catch (err) { log.warn('[OpenVibe.Git] audit not recorded:', err.message); }
    }

    async function create({ actor, name, description = '', visibility = 'public', topics = [], starter = 'empty', mirrorUrl = null }, { address = null } = {}) {
        const owner = String(actor.username || '').toLowerCase();
        const repoName = String(name || '').toLowerCase();
        if (!validName(owner)) throw Object.assign(new Error('A signed-in OpenVibe username is required.'), { status: 403 });
        if (!validName(repoName)) throw Object.assign(new Error('A repository name is lowercase letters, digits, dots, dashes and underscores, and never ends in .git.'), { status: 422 });
        if (description.length > 500) throw Object.assign(new Error('The description is at most 500 characters.'), { status: 422 });
        if (!['public', 'private'].includes(visibility)) throw Object.assign(new Error('Visibility is public or private.'), { status: 422 });
        if (await getRow(owner, repoName)) throw Object.assign(new Error('That repository already exists.'), { status: 409 });

        let mirror = null;
        if (mirrorUrl) {
            mirror = github.parseGithubUrl(mirrorUrl);
            if (!mirror) throw Object.assign(new Error('A mirror URL is a public https://github.com/<owner>/<name> URL.'), { status: 422 });
        }
        const official = config.officialOwners.includes(owner);
        const id = store.newId('repo');
        try {
            await store.execute(
                `INSERT INTO git_repos (id, owner_username, owner_subject, name, description, visibility, topics, official,
                    github_full_name, mirror_url, mirror_state, mirror_last_synced_at, created_by_subject)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, owner, actor.subject || null, repoName, description, visibility, JSON.stringify([...new Set(topics)].slice(0, 20)), official,
                    mirror ? mirror.full_name : null, mirror ? mirror.clone_url : null, mirror ? 'syncing' : 'ready', null, actor.subject || null],
            );
        } catch (err) {
            if (/duplicate key|unique/i.test(err.message)) throw Object.assign(new Error('That repository already exists.'), { status: 409 });
            throw err;
        }
        const row = await byId(id);
        try {
            if (mirror) {
                let meta = { description: '', default_branch: 'main', private: false };
                try { meta = await github.meta(mirror.full_name); } catch { /* the clone still works without the card */ }
                if (meta.private) throw Object.assign(new Error('That GitHub repository is private.'), { status: 422 });
                await git.cloneMirror(owner, repoName, mirror.clone_url, { timeoutMs: config.mirrors.timeoutMs });
                await store.execute(
                    `UPDATE git_repos SET description = ?, default_branch = ?, mirror_state = 'ready', mirror_last_synced_at = now(), pushed_at = now(), updated_at = now() WHERE id = ?`,
                    [description || meta.description || '', meta.default_branch || 'main', id],
                );
            } else {
                const files = starterFiles(starter, { full: `${owner}/${repoName}` });
                await git.initRepo(owner, repoName, { maxPushBytes: config.data.maxPushBytes });
                await git.writeInitialCommit(owner, repoName, { files, message: `Start ${owner}/${repoName}` });
                await store.execute('UPDATE git_repos SET pushed_at = now(), updated_at = now() WHERE id = ?', [id]);
            }
        } catch (err) {
            await store.execute('DELETE FROM git_repos WHERE id = ?', [id]).catch(() => {});
            await git.removeRepo(owner, repoName).catch(() => {});
            throw Object.assign(new Error(mirror ? `The mirror could not be made: ${err.message}` : err.message), { status: 422 });
        }
        await refreshLanguages(await byId(id));
        await recordEvent(row, 'create', actor, { name: repoName, mirror: Boolean(mirror) });
        await audit(actor, mirror ? 'repo.mirror.create' : 'repo.create', row, { name: repoName }, address);
        return rowToRepo(await byId(id));
    }

    async function fork({ source, actor, name }, { address = null } = {}) {
        const targetName = String(name || source.name).toLowerCase();
        if (!validName(targetName)) throw Object.assign(new Error('A repository name is lowercase letters, digits, dots, dashes and underscores, and never ends in .git.'), { status: 422 });
        const owner = String(actor.username || '').toLowerCase();
        if (!validName(owner)) throw Object.assign(new Error('A signed-in OpenVibe username is required.'), { status: 403 });
        if (await getRow(owner, targetName)) throw Object.assign(new Error('That repository already exists.'), { status: 409 });
        const id = store.newId('repo');
        await store.execute(
            `INSERT INTO git_repos (id, owner_username, owner_subject, name, description, visibility, topics, official, fork_of, created_by_subject)
             VALUES (?, ?, ?, ?, ?, 'public', ?, false, ?, ?)`,
            [id, owner, actor.subject || null, targetName, source.description || '', JSON.stringify(source.topics || []), source.id, actor.subject || null],
        );
        try {
            await git.cloneLocal(source.owner_username, source.name, owner, targetName, { timeoutMs: config.mirrors.timeoutMs });
            await store.execute('UPDATE git_repos SET pushed_at = now() WHERE id = ?', [id]);
        } catch (err) {
            await store.execute('DELETE FROM git_repos WHERE id = ?', [id]).catch(() => {});
            throw Object.assign(new Error(`The fork could not be made: ${err.message}`), { status: 422 });
        }
        const row = await byId(id);
        await refreshLanguages(row);
        await recordEvent(row, 'fork', actor, { from: source.full_name || `${source.owner_username}/${source.name}` });
        await audit(actor, 'repo.fork', row, { from: source.id }, address);
        return rowToRepo(await byId(id));
    }

    async function list({ viewer = null, q = '', language = '', official = false, mirror = false, mine = false, starred = false, sort = 'trending', limit = 30, cursor = 0 } = {}) {
        const where = [];
        const args = [];
        if (!(mine && viewer && viewer.subject)) {
            where.push(`(r.visibility = 'public' OR r.owner_subject = ?)`);
            args.push(viewer && viewer.subject ? viewer.subject : '');
        }
        if (q) { where.push('(r.name ILIKE ? OR r.description ILIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
        if (language) { where.push('r.language = ?'); args.push(language); }
        if (official) where.push('r.official = true');
        if (mirror) where.push('r.mirror_url IS NOT NULL');
        if (mine) { where.push('r.owner_subject = ?'); args.push(viewer && viewer.subject ? viewer.subject : ' '); }
        if (starred) { where.push('EXISTS (SELECT 1 FROM git_stars st WHERE st.repo_id = r.id AND st.subject = ?)'); args.push(viewer && viewer.subject ? viewer.subject : ' '); }
        const order = {
            trending: '(SELECT count(*) FROM git_stars s WHERE s.repo_id = r.id AND s.created_at >= now() - interval \'7 days\') * 5 + (SELECT coalesce(sum(v.views), 0) FROM git_views v WHERE v.repo_id = r.id AND v.day >= current_date - 7) DESC, r.pushed_at DESC NULLS LAST',
            pushed: 'r.pushed_at DESC NULLS LAST, r.created_at DESC',
            stars: '(SELECT count(*) FROM git_stars s WHERE s.repo_id = r.id) DESC, r.pushed_at DESC NULLS LAST',
            new: 'r.created_at DESC',
        }[sort] || null;
        if (!order) throw Object.assign(new Error('sort is trending, pushed, stars or new'), { status: 422 });
        const size = Math.max(1, Math.min(50, Number(limit) || 30));
        const skip = Math.max(0, Number(cursor) || 0);
        const rows = await store.many(
            `${SELECT_REPO} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ? OFFSET ?`,
            [...args, size + 1, skip],
        );
        const more = rows.length > size;
        return { repositories: rows.slice(0, size).map((r) => rowToRepo(r)), next_cursor: more ? String(skip + size) : null };
    }

    async function star(row, subject, on = true) {
        if (!subject) throw Object.assign(new Error('Sign in to star a repository.'), { status: 401 });
        if (on) {
            const inserted = await store.execute('INSERT INTO git_stars (repo_id, subject) VALUES (?, ?) ON CONFLICT DO NOTHING', [row.id, subject]);
            if (inserted) await recordEvent(row, 'star', { subject, username: null }, {});
        } else {
            await store.execute('DELETE FROM git_stars WHERE repo_id = ? AND subject = ?', [row.id, subject]);
        }
        const fresh = await byId(row.id);
        return { starred: Boolean(await store.maybe('SELECT 1 AS one FROM git_stars WHERE repo_id = ? AND subject = ?', [row.id, subject])), stars: Number(fresh.stars) || 0 };
    }

    async function isStarred(row, subject) {
        if (!subject) return false;
        return Boolean(await store.maybe('SELECT 1 AS one FROM git_stars WHERE repo_id = ? AND subject = ?', [row.id, subject]));
    }

    async function isWatching(row, subject) {
        if (!subject) return false;
        return Boolean(await store.maybe('SELECT 1 AS one FROM git_watches WHERE repo_id = ? AND subject = ?', [row.id, subject]));
    }

    async function watch(row, subject) {
        if (!subject) throw Object.assign(new Error('Sign in to watch a repository.'), { status: 401 });
        const on = !(await isWatching(row, subject));
        if (on) await store.execute('INSERT INTO git_watches (repo_id, subject) VALUES (?, ?) ON CONFLICT DO NOTHING', [row.id, subject]);
        else await store.execute('DELETE FROM git_watches WHERE repo_id = ? AND subject = ?', [row.id, subject]);
        return { watching: on, watchers: Number((await byId(row.id)).watchers) || 0 };
    }

    async function languagesFacet() {
        const rows = await store.many("SELECT DISTINCT language FROM git_repos WHERE visibility = 'public' AND language IS NOT NULL ORDER BY language");
        return rows.map((r) => r.language);
    }

    async function releases(row) {
        const [tags, stored] = await Promise.all([
            git.tags(row.owner_username, row.name),
            store.many('SELECT * FROM git_releases WHERE repo_id = ? ORDER BY published_at DESC', [row.id]),
        ]);
        const byTag = new Map(stored.map((r) => [r.tag, r]));
        return tags.map((t) => {
            const rel = byTag.get(t.name);
            return { tag: t.name, name: rel ? rel.name : t.name, body: rel ? rel.body : '', published_at: rel ? rel.published_at : t.date, sha: t.sha, has_notes: Boolean(rel) };
        });
    }

    async function publishRelease(row, { tag, name, body, actor }) {
        if (!git.tags) throw new Error('unreachable');
        const tags = await git.tags(row.owner_username, row.name);
        if (!tags.some((t) => t.name === tag)) throw Object.assign(new Error('That tag does not exist.'), { status: 422 });
        const id = store.newId('rel');
        await store.execute(
            `INSERT INTO git_releases (id, repo_id, tag, name, body, author_subject) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (repo_id, tag) DO UPDATE SET name = excluded.name, body = excluded.body`,
            [id, row.id, tag, name || tag, body || '', actor.subject || null],
        );
        await recordEvent(row, 'release', actor, { tag, name: name || tag });
        return await releases(row);
    }

    async function contributors(row) {
        const list = await git.contributors(row.owner_username, row.name, row.default_branch);
        return list.map((c) => ({ ...c, username: null, avatar_url: null }));
    }

    async function insightsFor(row, { days = 30 } = {}) {
        return await insights.forRepo(row, {
            days,
            commitsPerWeek: () => git.commitsPerWeek(row.owner_username, row.name, row.default_branch, { weeks: 26 }),
        });
    }

    async function setPushMirror(row, { push_url, push_token }, actor, { address = null } = {}) {
        if (!isOwner(row, actor)) throw Object.assign(new Error('Only the owner can change a push mirror.'), { status: 403 });
        if (!push_url) {
            await store.execute("UPDATE git_repos SET push_mirror_url = NULL, push_mirror_token = NULL, push_mirror_state = 'off' WHERE id = ?", [row.id]);
        } else {
            const parsed = github.parseGithubUrl(push_url);
            if (!parsed) throw Object.assign(new Error('A push mirror URL is a public https://github.com/<owner>/<name> URL.'), { status: 422 });
            await store.execute(
                'UPDATE git_repos SET push_mirror_url = ?, push_mirror_token = ?, push_mirror_state = ? WHERE id = ?',
                [parsed.clone_url, push_token ? seal(push_token, config.tokens.secretKey) : null, 'on', row.id],
            );
        }
        await audit(actor, 'repo.push_mirror', row, { on: Boolean(push_url) }, address);
        return rowToRepo(await byId(row.id));
    }

    function pushTokenFor(row) {
        return open(row.push_mirror_token, config.tokens.secretKey);
    }

    async function activity(limit = 12) {
        const rows = await store.many(
            `SELECT e.*, r.owner_username, r.name FROM git_events e LEFT JOIN git_repos r ON r.id = e.repo_id
             WHERE (r.visibility = 'public' OR r.id IS NULL) ORDER BY e.at DESC LIMIT ?`,
            [Math.max(1, Math.min(50, Number(limit) || 12))],
        );
        return rows.map((e) => ({ id: e.id, type: e.type, at: e.at, owner: e.owner_username, name: e.name, actor: e.actor_username, detail: typeof e.detail === 'string' ? JSON.parse(e.detail || '{}') : e.detail }));
    }

    async function stats() {
        const [repositories, pushes, people, clones] = await Promise.all([
            store.value("SELECT count(*)::int FROM git_repos WHERE visibility = 'public'"),
            store.value("SELECT count(*)::int FROM git_events WHERE type = 'push' AND at >= now() - interval '7 days'"),
            store.value('SELECT count(DISTINCT owner_subject)::int FROM git_repos WHERE owner_subject IS NOT NULL'),
            store.value("SELECT coalesce(sum(count), 0)::int FROM git_clones WHERE day >= current_date - 7"),
        ]);
        return { repositories: Number(repositories) || 0, pushes_this_week: Number(pushes) || 0, people: Number(people) || 0, clones_this_week: Number(clones) || 0 };
    }

    async function trending(limit = 6) {
        const rows = await store.many(
            `SELECT * FROM (
                SELECT r.*,
                    (SELECT count(*) FROM git_stars s WHERE s.repo_id = r.id AND s.created_at >= now() - interval '7 days')::int AS stars_week,
                    (SELECT coalesce(sum(v.views), 0) FROM git_views v WHERE v.repo_id = r.id AND v.day >= current_date - 7)::int AS views_week,
                    (SELECT count(*) FROM git_stars s WHERE s.repo_id = r.id)::int AS stars,
                    (SELECT count(*) FROM git_watches w WHERE w.repo_id = r.id)::int AS watchers,
                    (SELECT count(*) FROM git_repos f WHERE f.fork_of = r.id)::int AS forks
                 FROM git_repos r WHERE r.visibility = 'public'
             ) ranked ORDER BY stars_week * 5 + views_week DESC, pushed_at DESC NULLS LAST LIMIT ?`,
            [limit],
        );
        return rows.map((r) => rowToRepo(r));
    }

    async function official() {
        const rows = await store.many(`${SELECT_REPO} WHERE r.official = true AND r.visibility = 'public' ORDER BY r.name`);
        return rows.map((r) => ({ ...rowToRepo(r), github_full_name: r.github_full_name }));
    }

    async function profile(username, { viewer = null } = {}) {
        if (!validName(username)) return null;
        const rows = await store.many(`${SELECT_REPO} WHERE r.owner_username = ? AND (r.visibility = 'public' OR r.owner_subject = ?) ORDER BY r.pushed_at DESC NULLS LAST, r.name`, [username, viewer && viewer.subject ? viewer.subject : '']);
        if (!rows.length) {
            const user = await store.maybe('SELECT DISTINCT owner_username, owner_subject FROM git_repos WHERE owner_username = ?', [username]);
            if (!user) return null;
        }
        return { username, owner_subject: rows[0] ? rows[0].owner_subject : null, repositories: rows.map((r) => rowToRepo(r)) };
    }

    return {
        rowToRepo, byId, getRow, get, canView, isOwner, refreshLanguages, recordEvent, audit, create, fork, list, star, isStarred,
        isWatching, watch, languagesFacet, releases, publishRelease, contributors, insightsFor, setPushMirror, pushTokenFor, activity, stats, trending, official, profile,
    };
}

module.exports = { createRepos, SELECT_REPO, PUBLIC_WHERE };
