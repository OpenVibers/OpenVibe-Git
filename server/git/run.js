'use strict';

/**
 * Git, run the only way this service runs it: an argument array, no shell, a fixed environment.
 *
 *   await runGit(['rev-parse', '--verify', ref], { cwd: repoDir });
 *   await runGit(['http-backend'], { env: backendEnv });
 *
 * Nothing a request carries is ever pasted into a command string. The environment starts from a small allow
 * list, never the whole process env: no GIT_DIR, no GIT_* from the caller, no credential helper, no prompt.
 * Output is capped (a huge blob cannot exhaust memory); a timeout kills the child.
 */
const { spawn } = require('node:child_process');

const FIXED_ENV = Object.freeze({
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_PAGER: 'cat',
    GIT_EDITOR: 'true',
    LC_ALL: 'C',
    LANG: 'C',
});

/** Variables a caller may pass to a child (the CGI environment and the transport we chose). */
const ALLOWED = new Set([
    'PATH', 'HOME', 'TMPDIR',
    'GIT_PROJECT_ROOT', 'GIT_HTTP_EXPORT_ALL', 'GIT_PROTOCOL', 'GIT_CONFIG_COUNT',
    'PATH_INFO', 'REQUEST_METHOD', 'QUERY_STRING', 'CONTENT_TYPE', 'CONTENT_LENGTH', 'REMOTE_USER', 'REMOTE_ADDR',
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
    'GIT_INDEX_FILE', 'GIT_NAMESPACE',
]);

function childEnv(extra = {}) {
    const env = { ...FIXED_ENV };
    for (const [k, v] of Object.entries(extra)) {
        if (v == null) continue;
        if (ALLOWED.has(k) || k.startsWith('GIT_CONFIG_KEY_') || k.startsWith('GIT_CONFIG_VALUE_')) env[k] = String(v);
    }
    // PATH is needed to find git; the rest is ours.
    for (const k of ['PATH', 'HOME', 'TMPDIR']) if (process.env[k] && !env[k]) env[k] = process.env[k];
    return env;
}

/** `git -c key=value` settings passed through the environment, so they never appear in argv. */
function configEnv(pairs) {
    const out = {};
    const entries = Object.entries(pairs).filter(([, v]) => v != null);
    out.GIT_CONFIG_COUNT = String(entries.length);
    entries.forEach(([k, v], i) => { out[`GIT_CONFIG_KEY_${i}`] = k; out[`GIT_CONFIG_VALUE_${i}`] = String(v); });
    return out;
}

class GitError extends Error {
    constructor(args, code, stderr) {
        super(`git ${args[0]} failed (${code}): ${String(stderr || '').trim().slice(0, 500)}`);
        this.name = 'GitError';
        this.code = code;
        this.stderr = String(stderr || '');
        this.args = args;
    }
}

/**
 * runGit(args, { cwd, input, env, maxBuffer, timeoutMs }) → { stdout: Buffer, stderr: string, code }
 * Rejects with GitError on a non-zero exit (unless allowFailure).
 */
function runGit(args, { cwd, input, env, maxBuffer = 32 * 1024 * 1024, timeoutMs = 20_000, allowFailure = false } = {}) {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
        return Promise.reject(new TypeError('runGit: args must be an array of strings'));
    }
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn('git', args, { cwd, env: childEnv(env), shell: false, windowsHide: true });
        } catch (err) { reject(err); return; }
        const out = [];
        let outLen = 0;
        let stderr = '';
        let settled = false;
        const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
            finish(reject, new GitError(args, 'timeout', `timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        timer.unref();
        child.stdout.on('data', (chunk) => {
            outLen += chunk.length;
            if (outLen > maxBuffer) {
                try { child.kill('SIGKILL'); } catch { /* already gone */ }
                finish(reject, new GitError(args, 'max_buffer', `output larger than ${maxBuffer} bytes`));
                return;
            }
            out.push(chunk);
        });
        child.stderr.on('data', (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8'); });
        child.on('error', (err) => finish(reject, err));
        child.on('close', (code) => {
            const stdout = Buffer.concat(out);
            if (code !== 0 && !allowFailure) return finish(reject, new GitError(args, code, stderr));
            finish(resolve, { stdout, stderr, code });
        });
        if (input != null) child.stdin.end(input);
        else child.stdin.end();
    });
}

/** A text run (most plumbing is UTF-8). */
async function runText(args, opts) {
    const r = await runGit(args, opts);
    return r.stdout.toString('utf8');
}

/**
 * A streaming run (git archive): the caller pipes child.stdout and ends it. Same rules as runGit — an
 * argument array, no shell, the fixed environment — plus a timeout that kills the child. The caller owns
 * the child: kill it when the reader goes away.
 */
function spawnGit(args, { cwd, env, timeoutMs = 120_000 } = {}) {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
        throw new TypeError('spawnGit: args must be an array of strings');
    }
    const child = spawn('git', args, { cwd, env: childEnv(env), shell: false, windowsHide: true });
    const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    timer.unref();
    child.on('close', () => clearTimeout(timer));
    child.on('error', () => clearTimeout(timer));
    return child;
}

module.exports = { runGit, runText, spawnGit, configEnv, childEnv, GitError, FIXED_ENV };
