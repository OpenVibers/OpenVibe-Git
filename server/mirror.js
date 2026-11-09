'use strict';

/**
 * GitHub mirrors, three directions:
 *
 *   in   an official repository mirrors from GitHub on GitHub's push webhook, with a ten-minute poll as backup;
 *        anyone may mirror a public GitHub URL when they create a repository.
 *   out  a repository may push every push back to its GitHub twin (the owner's token for their own, the
 *        OpenVibers token for an official one). The token is sealed in the row and passed in the environment.
 *
 * A fetch goes through the egress guard: the URL is https, exactly github.com, and resolves to a public address.
 * One sync per repository at a time; a second request joins the first.
 */
const { assertPublicUrl } = require('openvibe-shared/egress');

function createMirrors({ store, repos, config, git, github, log = console }) {
    const running = new Map();   // repo id → promise

    async function guardUrl(url) {
        let u;
        try { u = new URL(url); } catch { throw new Error('not a URL'); }
        if (u.protocol !== 'https:') throw new Error('a mirror URL is https');
        if (!['github.com', 'www.github.com'].includes(u.hostname)) throw new Error('a mirror is on github.com');
        await assertPublicUrl(u);
        return u;
    }

    async function syncRow(row, { initial = false } = {}) {
        if (!row || !row.mirror_url) return { ok: false, reason: 'not a mirror' };
        if (running.has(row.id)) return { ok: true, joined: true };
        const task = (async () => {
            try {
                await guardUrl(row.mirror_url);
                await store.execute("UPDATE git_repos SET mirror_state = 'syncing', mirror_error = NULL WHERE id = ?", [row.id]);
                if (initial || !(await git.repoExists(row.owner_username, row.name))) {
                    await git.cloneMirror(row.owner_username, row.name, row.mirror_url, { timeoutMs: config.mirrors.timeoutMs });
                } else {
                    await git.fetchMirror(row.owner_username, row.name, { timeoutMs: config.mirrors.timeoutMs });
                }
                await store.execute("UPDATE git_repos SET mirror_state = 'ready', mirror_error = NULL, mirror_last_synced_at = now(), updated_at = now() WHERE id = ?", [row.id]);
                await repos.refreshLanguages(row);
                await repos.recordEvent(row, 'mirror', { subject: null, username: null }, { state: 'ready' });
                return { ok: true };
            } catch (err) {
                const message = String(err.message || err).slice(0, 500);
                await store.execute("UPDATE git_repos SET mirror_state = 'error', mirror_error = ? WHERE id = ?", [message, row.id]).catch(() => {});
                log.warn(`[OpenVibe.Git] mirror ${row.owner_username}/${row.name}: ${message}`);
                return { ok: false, reason: message };
            } finally {
                running.delete(row.id);
            }
        })();
        running.set(row.id, task);
        return await task;
    }

    async function syncById(id) {
        const row = await repos.byId(id);
        return syncRow(row);
    }

    /** The ten-minute backup: every mirror is fetched again, two at a time. */
    async function poll() {
        const rows = await store.many("SELECT id FROM git_repos WHERE mirror_url IS NOT NULL ORDER BY mirror_last_synced_at ASC NULLS FIRST LIMIT 200");
        for (let i = 0; i < rows.length; i += 2) {
            await Promise.all(rows.slice(i, i + 2).map((r) => syncById(r.id)));
        }
    }

    async function handleWebhook(rawBody, headers) {
        if (!github.signatureOk(rawBody, headers['x-hub-signature-256'])) {
            return { status: 401, body: { error: 'signature' } };
        }
        let payload = null;
        try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 400, body: { error: 'json' } }; }
        if (headers['x-github-event'] === 'ping') return { status: 200, body: { ok: true, pong: true } };
        const full = payload && payload.repository && payload.repository.full_name;
        if (!full) return { status: 200, body: { ok: true, ignored: true } };
        const row = await store.maybe('SELECT * FROM git_repos WHERE lower(github_full_name) = lower(?)', [full]);
        if (!row) return { status: 200, body: { ok: true, ignored: 'no mirror' } };
        // Acknowledge now, fetch after: GitHub's delivery does not wait on a large clone.
        syncRow(row).catch(() => {});
        return { status: 202, body: { ok: true, queued: true, repo: full } };
    }

    /** After a push: mark it and, if a push mirror is on, push back to GitHub. */
    async function afterPush(row) {
        await store.execute('UPDATE git_repos SET pushed_at = now(), updated_at = now() WHERE id = ?', [row.id]);
        await repos.refreshLanguages(row);
        if (!row.push_mirror_url) return;
        const token = repos.pushTokenFor(row) || (row.official ? config.github.pushToken : '');
        if (!token) {
            await store.execute("UPDATE git_repos SET push_mirror_state = 'error' WHERE id = ?", [row.id]);
            return;
        }
        try {
            await git.pushMirror(row.owner_username, row.name, row.push_mirror_url, { token, timeoutMs: config.mirrors.timeoutMs });
            await store.execute("UPDATE git_repos SET push_mirror_state = 'on' WHERE id = ?", [row.id]);
        } catch (err) {
            await store.execute("UPDATE git_repos SET push_mirror_state = 'error' WHERE id = ?", [row.id]);
            log.warn(`[OpenVibe.Git] push mirror ${row.owner_username}/${row.name}: ${String(err.message).slice(0, 200)}`);
        }
    }

    let timer = null;
    return {
        syncRow, syncById, poll, handleWebhook, afterPush,
        start() {
            if (timer || config.drill) return;
            timer = setInterval(() => { poll().catch((err) => log.warn('[OpenVibe.Git] mirror poll:', err.message)); }, config.mirrors.pollMs);
            timer.unref();
        },
        stop() { if (timer) clearInterval(timer); timer = null; },
        isRunning: (id) => running.has(id),
    };
}

module.exports = { createMirrors };
