'use strict';
/**
 * Publish on OpenVibe.Space (plan §AD.10 step 2; the owner, 11-15: "use openvibe.space to host whatever it wants, any
 * code, any repository"): a repository names one of its owner's Space sites, a branch and a folder, and every push to
 * that branch deploys that folder there, as the owner.
 *
 * Space never fetches a repository and holds no credential for one (its deploys.js boundary): Git sends the files.
 * After a push lands on the branch, Git makes `git archive <commit>:<folder>` (the folder's files at the archive's
 * root, nothing else) and posts it to Space's git deploy door (POST /api/v1/sites/:id/source/deploys?ref=&commit_sha=)
 * with its own Network service token (audience openvibe.space, space.deploy.create) and the repository's owner in
 * X-OV-Subject. Space checks that the site is the person's and that its source is this repository and branch; the
 * deploy lands as the site's preview, which the person makes live (or a later setting does it on every push).
 *
 *   createSpacePublish({ config, store, git, fetchImpl, log, tokens? }) →
 *     get(row) → the setting with its last deploy, or null
 *     put(row, actor, { site_id, branch, folder }) → the setting (the owner only)
 *     remove(row)
 *     afterPush(row, { ref, sha }) → queues a deploy when the push is to the published branch (never blocks a push)
 *     runNow(row) → deploys the branch's current commit now
 *
 * One deploy per repository at a time; a push while one runs is taken when it ends (the newest commit wins).
 */
const { serviceAuth } = require('openvibe-contracts');
const { runGit } = require('./git/run');

const SITE_RE = /^sit_[0-9A-HJKMNP-TV-Z]{26}$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)[A-Za-z0-9._/+=,#-]{1,200}$/;
const FOLDER_RE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,99})(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,7}$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

function cleanSetting(input = {}) {
    const site = String(input.site_id || '').trim();
    if (!SITE_RE.test(site)) throw fail(422, 'publish.site_invalid', 'Name the Space site by its id (sit_…).');
    const branch = String(input.branch || '').trim();
    if (!BRANCH_RE.test(branch) || branch === 'HEAD' || branch.startsWith('refs/') || branch.split('/').some((p) => p.startsWith('.') || p.endsWith('.lock'))) {
        throw fail(422, 'publish.branch_invalid', 'Name one branch (letters, digits and . _ / + = , # -).');
    }
    const folder = String(input.folder == null ? '' : input.folder).trim().replace(/^\.?\/+|\/+$/g, '');
    if (folder && (!FOLDER_RE.test(folder) || folder.split('/').includes('..'))) {
        throw fail(422, 'publish.folder_invalid', 'The folder is a path in the repository, like dist or site/public (or empty for all of it).');
    }
    return { site_id: site, branch, folder };
}

function createSpacePublish({ config, store, git, fetchImpl = globalThis.fetch, log = console, tokens = null } = {}) {
    const cfg = config.space || {};
    const enabled = cfg.enabled !== false && Boolean(cfg.internalUrl);
    const client = tokens || (enabled && config.oauth && config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId || 'git', clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.space', scope: 'space.deploy.create', fetchImpl,
    }) : null);
    const running = new Map();   // repo id → { promise, again }

    const shape = (r) => (r ? {
        site_id: r.site_id, branch: r.branch, folder: r.folder || '',
        last: r.last_at ? { sha: r.last_sha, state: r.last_state, detail: r.last_detail || null, deploy_id: r.last_deploy_id || null, url: r.last_url || null, at: new Date(r.last_at).toISOString() } : null,
    } : null);

    async function row(repo) { return await store.maybe('SELECT * FROM git_space_publish WHERE repo_id = ?', [repo.id]); }
    async function get(repo) { return shape(await row(repo)); }

    async function put(repo, actor, input) {
        if (!repo.owner_subject) throw fail(409, 'publish.owner_required', 'Only a person\'s repository publishes on their Space.');
        if (!actor || actor.subject !== repo.owner_subject) throw fail(403, 'publish.owner_only', 'Only the repository\'s owner chooses where it is published.');
        const s = cleanSetting(input);
        await store.execute(
            `INSERT INTO git_space_publish (repo_id, site_id, branch, folder, set_by) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (repo_id) DO UPDATE SET site_id = EXCLUDED.site_id, branch = EXCLUDED.branch, folder = EXCLUDED.folder,
                 set_by = EXCLUDED.set_by, updated_at = now()`,
            [repo.id, s.site_id, s.branch, s.folder, actor.subject],
        );
        return await get(repo);
    }

    async function remove(repo) { await store.execute('DELETE FROM git_space_publish WHERE repo_id = ?', [repo.id]); }

    async function record(repo, sha, state, { detail = null, deployId = null, url = null } = {}) {
        await store.execute(
            `UPDATE git_space_publish SET last_sha = ?, last_state = ?, last_detail = ?, last_deploy_id = ?, last_url = ?, last_at = now()
             WHERE repo_id = ?`,
            [sha, state, detail ? String(detail).slice(0, 500) : null, deployId, url, repo.id],
        );
    }

    /** Deploy one commit of the published branch: the folder's archive, posted to Space as the owner. */
    async function deploy(repo, setting, sha) {
        if (!enabled || !client) { await record(repo, sha, 'off', { detail: 'Publishing on OpenVibe.Space is not set up on this server.' }); return; }
        let archive;
        try {
            const tree = setting.folder ? `${sha}:${setting.folder}` : sha;
            const out = await runGit(['archive', '--format=tar.gz', tree], {
                cwd: git.repoDir(repo.owner_username, repo.name), timeoutMs: 120_000, maxBuffer: cfg.maxBytes || 64 * 1024 * 1024,
            });
            archive = out.stdout;
        } catch (err) {
            const missing = /not a tree object|not a valid object name|does not exist/i.test(String((err && err.stderr) || (err && err.message) || ''));
            await record(repo, sha, 'failed', { detail: missing ? `There is no folder "${setting.folder}" at this commit.` : 'The files could not be packed.' });
            return;
        }
        let res;
        try {
            const q = `ref=${encodeURIComponent(setting.branch)}&commit_sha=${sha}`;
            res = await fetchImpl(`${cfg.internalUrl}/api/v1/sites/${encodeURIComponent(setting.site_id)}/source/deploys?${q}`, {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/gzip', 'X-OV-Subject': repo.owner_subject, ...(await client.authHeaders()) },
                body: archive, redirect: 'error', signal: AbortSignal.timeout(cfg.timeoutMs || 120_000),
            });
        } catch (err) {
            log.warn(`[OpenVibe.Git] publish ${repo.owner_username}/${repo.name}: ${String((err && err.message) || err).slice(0, 200)}`);
            await record(repo, sha, 'failed', { detail: 'OpenVibe.Space did not answer. It is tried again on the next push, or with Deploy now.' });
            return;
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            await record(repo, sha, 'failed', { detail: body.detail || body.title || `OpenVibe.Space answered ${res.status}` });
            return;
        }
        await record(repo, sha, 'deployed', { deployId: body.deploy && body.deploy.id, url: body.url || null });
    }

    /** One deploy per repository at a time; a push meanwhile is taken when it ends (its newest commit). */
    function queue(repo) {
        const cur = running.get(repo.id);
        if (cur) { cur.again = true; return cur.promise; }
        const job = { again: false, promise: null };
        job.promise = (async () => {
            try {
                do {
                    job.again = false;
                    const setting = await row(repo);
                    if (!setting) return;
                    const sha = await git.resolveCommit(repo.owner_username, repo.name, `refs/heads/${setting.branch}`);
                    if (!sha || !SHA_RE.test(sha)) { await record(repo, null, 'failed', { detail: `There is no branch "${setting.branch}".` }); return; }
                    if (sha !== setting.last_sha || setting.last_state !== 'deployed' || job.force) { job.force = false; await deploy(repo, setting, sha); }
                } while (job.again);
            } catch (err) {
                log.warn(`[OpenVibe.Git] publish ${repo.owner_username}/${repo.name}: ${String((err && err.message) || err).slice(0, 200)}`);
            } finally { running.delete(repo.id); }
        })();
        running.set(repo.id, job);
        return job.promise;
    }

    /** After a push: only a push to the published branch deploys. Never throws into the push. */
    function afterPush(repo, { ref } = {}) {
        if (!enabled) return Promise.resolve();
        return (async () => {
            const setting = await row(repo);
            if (!setting || (ref && ref !== `refs/heads/${setting.branch}` && ref !== setting.branch)) return;
            await queue(repo);
        })().catch((err) => log.warn(`[OpenVibe.Git] publish after push ${repo.owner_username}/${repo.name}: ${String((err && err.message) || err).slice(0, 200)}`));
    }

    /** Deploy now: the branch's current commit, even when it was deployed before. */
    async function runNow(repo) {
        const setting = await row(repo);
        if (!setting) throw fail(404, 'publish.not_set', 'This repository is not published on OpenVibe.Space.');
        const cur = running.get(repo.id);
        if (cur) { cur.again = true; cur.force = true; }
        else {
            await store.execute('UPDATE git_space_publish SET last_state = NULL WHERE repo_id = ?', [repo.id]);
        }
        await queue(repo);
        return await get(repo);
    }

    return { enabled, get, put, remove, afterPush, runNow, cleanSetting };
}

module.exports = { createSpacePublish, cleanSetting };
