'use strict';

/**
 * The verdict on GitHub too: the pull request shows `forge/test` beside GitHub Actions, with the run on the
 * forge as its target. The credential is the workstation's `gh` CLI — the forge host has no GitHub token and
 * does not get one; nothing is copied into the runner's config or its sandbox.
 *
 * The post is best effort. A repository missing from the config, a commit GitHub does not know (a forge-only
 * push), a missing `gh` login or a GitHub outage is logged and the verdict on the forge stays final.
 */
const { execFile } = require('node:child_process');

const FULL_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/i;

/** A forge final state as GitHub's commit-status API names it. */
function githubState(state) {
    return state === 'success' ? 'success' : state === 'error' ? 'error' : 'failure';
}

/**
 * Post one final verdict. Resolves { ok, skipped? } and never rejects, so a failure here cannot lose the run.
 * The `exec` argument is the seam the test uses instead of a real gh.
 */
function reportGithubStatus({ cfg, job, state, description = '', targetUrl = '', log = console, exec = execFile }) {
    if (!cfg || cfg.githubStatus === false) return Promise.resolve({ ok: false, skipped: 'off' });
    const full = String((job && job.repo && job.repo.full_name) || '');
    if (!FULL_RE.test(full) || !cfg.repos || !cfg.repos[full.toLowerCase()]) return Promise.resolve({ ok: false, skipped: 'repository' });
    const sha = String((job && job.run && job.run.sha) || '');
    if (!SHA_RE.test(sha)) return Promise.resolve({ ok: false, skipped: 'sha' });
    if (!['success', 'failure', 'error', 'timed_out'].includes(state)) return Promise.resolve({ ok: false, skipped: 'state' });

    const args = [
        'api', '--method', 'POST', `repos/${full}/statuses/${sha}`,
        '-f', `state=${githubState(state)}`,
        '-f', `context=${String(cfg.githubContext || 'forge/test').slice(0, 255)}`,
        '-f', `description=${String(description || '').slice(0, 140)}`,
    ];
    if (/^https?:\/\//.test(String(targetUrl || ''))) args.push('-f', `target_url=${targetUrl}`);

    return new Promise((resolve) => {
        exec('gh', args, { timeout: 20_000, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout, stderr) => {
            if (err) {
                const why = String(stderr || err.message || '').trim().replace(/\s+/g, ' ').slice(0, 200);
                log(`[git-ci-runner] GitHub status not sent: ${why}`);
                resolve({ ok: false, error: err.code || 'gh' });
            } else resolve({ ok: true });
        });
    });
}

module.exports = { reportGithubStatus, githubState };
