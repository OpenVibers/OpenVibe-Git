'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { runGit, runText, configEnv } = require('./run');
const git = require('./store');
const { validRef, validPath } = require('./refs');
const { TMP_DIR, HOOKS_DIR } = require('../paths');
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const dir = (r) => git.repoDir(r.owner_username, r.name);
async function resolve(r, ref, branch = false) {
    if (!validRef(ref)) throw fail(422, 'Invalid ref');
    const sha = await git.resolveCommit(r.owner_username, r.name, branch ? `refs/heads/${ref}` : ref);
    if (!sha) throw fail(404, 'Ref not found');
    return sha;
}
function parseCompare(value) {
    if (typeof value !== 'string') throw fail(422, 'Invalid comparison');
    const parts = value.split('...');
    if (parts.length !== 2 || !parts.every(validRef)) throw fail(422, 'Use base...head');
    return parts;
}
function diffLines(patch) {
    let old = 0, next = 0, inHunk = false;
    return patch.split('\n').map((text) => {
        const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
        if (h) { inHunk = true; old = Number(h[1]); next = Number(h[2]); return { text, kind: 'hunk' }; }
        if (!inHunk) return { text, kind: 'meta' };
        if (text.startsWith('+')) return { text, kind: 'add', new_line: next++ };
        if (text.startsWith('-')) return { text, kind: 'remove', old_line: old++ };
        if (text.startsWith(' ')) return { text, kind: 'context', old_line: old++, new_line: next++ };
        return { text, kind: 'meta' };
    });
}
async function compare(r, baseRef, headRef, source = r, mergeBase = false) {
    const base = await resolve(r, baseRef), head = await resolve(source, headRef);
    if (source.id !== r.id) await runGit(['fetch', '--no-tags', '--no-write-fetch-head', '--', dir(source), head], { cwd: dir(r) });
    const from = mergeBase ? (await runText(['merge-base', base, head], { cwd: dir(r) })).trim() : base;
    const opts = { cwd: dir(r), timeoutMs: 10000, maxBuffer: 4 * 1024 * 1024 };
    const stats = (await runText(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', from, head, '--'], opts)).split('\0').filter(Boolean);
    if (stats.length > 300) throw fail(413, 'Comparison exceeds 300 files');
    const files = []; let bytes = 0;
    for (const stat of stats) {
        const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(stat);
        if (!m) continue;
        const file = m[3];
        const patch = await runText(['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', from, head, '--', file], opts);
        bytes += Buffer.byteLength(patch);
        if (bytes > 4 * 1024 * 1024) throw fail(413, 'Comparison exceeds 4 MB');
        files.push({ path: file, added: Number(m[1]) || 0, removed: Number(m[2]) || 0, binary: m[1] === '-', lines: diffLines(patch) });
    }
    const log = await runText(['log', '--max-count=200', '--format=%H%x00%s', `${base}..${head}`, '--'], opts);
    return { base, head, from, files, added: files.reduce((s, f) => s + f.added, 0), removed: files.reduce((s, f) => s + f.removed, 0), commits: log.trim().split('\n').filter(Boolean).map((l) => { const [sha, subject] = l.split('\0'); return { sha, subject }; }) };
}
async function locked(r, fn) {
    await git.ensureDataDirs();
    const lock = path.join(TMP_DIR, `review-lock-${r.id}`);
    try { await fs.mkdir(lock); } catch (e) { if (e.code === 'EEXIST') throw fail(409, 'Repository is busy'); throw e; }
    try { return await fn(); } finally { await fs.rmdir(lock); }
}
async function merge(r, source, change, method, expected, actor, expectedBase) {
    if (!['merge', 'squash', 'rebase'].includes(method)) throw fail(422, 'Invalid merge method');
    const base = await resolve(r, change.base_ref, true), head = await resolve(source, change.head_ref, true);
    if (expectedBase && base !== expectedBase) throw fail(409, 'Target changed during review');
    if (head !== expected) throw fail(409, 'Head changed; review it again');
    if (source.id !== r.id) await runGit(['fetch', '--no-tags', '--no-write-fetch-head', '--', dir(source), head], { cwd: dir(r) });
    const work = await fs.mkdtemp(path.join(TMP_DIR, 'merge-'));
    const env = { ...configEnv({ 'core.hooksPath': HOOKS_DIR, 'commit.gpgSign': 'false' }), GIT_AUTHOR_NAME: actor.username || 'OpenVibe reviewer', GIT_AUTHOR_EMAIL: 'git@openvibe.codes', GIT_COMMITTER_NAME: 'OpenVibe Git', GIT_COMMITTER_EMAIL: 'git@openvibe.codes' };
    const opts = { cwd: work, env, timeoutMs: 60000 };
    try {
        await runGit(['worktree', 'add', '--detach', work, method === 'rebase' ? head : base], { cwd: dir(r), env });
        try {
            if (method === 'rebase') {
                const ancestor = (await runText(['merge-base', base, head], opts)).trim();
                await runGit(['rebase', '--onto', base, ancestor], opts);
            } else {
                await runGit(['merge', method === 'squash' ? '--squash' : '--no-ff', '--no-edit', head], opts);
                if (method === 'squash') await runGit(['commit', '-m', `Change #${change.number}: ${change.title}`], opts);
            }
        } catch (e) {
            const files = (await runText(['diff', '--name-only', '--diff-filter=U', '-z'], opts)).split('\0').filter(Boolean);
            if (files.length) throw fail(409, 'Merge conflict', { files });
            throw e;
        }
        const sha = (await runText(['rev-parse', 'HEAD'], opts)).trim();
        // The head may move while git builds the merge; do not merge an unreviewed revision.
        if (await resolve(source, change.head_ref, true) !== head) throw fail(409, 'Head changed during merge');
        try { await runGit(['update-ref', `refs/heads/${change.base_ref}`, sha, base], { cwd: dir(r) }); }
        catch { throw fail(409, 'Target changed during merge'); }
        return sha;
    } finally {
        await runGit(['worktree', 'remove', '--force', work], { cwd: dir(r), allowFailure: true });
        await fs.rm(work, { recursive: true, force: true });
    }
}
async function search(r, query) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200 || /[\x00-\x1f]/.test(query)) throw fail(422, 'Search must be 1–200 characters');
    const sha = await resolve(r, r.default_branch);
    const result = await runGit(['grep', '-I', '-n', '-F', '-e', query, sha, '--'], { cwd: dir(r), timeoutMs: 3000, maxBuffer: 1024 * 1024, allowFailure: true });
    if (result.code > 1) throw fail(422, 'Search failed');
    const lines = result.stdout.toString().split('\n').filter(Boolean);
    return { ref: sha, results: lines.slice(0, 200).map((l) => l.slice(sha.length + 1)), truncated: lines.length > 200 };
}
async function blame(r, ref, file) {
    if (!validPath(file) || !file) throw fail(422, 'Invalid file path');
    const sha = await resolve(r, ref);
    const raw = await runText(['--literal-pathspecs', 'blame', '--line-porcelain', sha, '--', file], { cwd: dir(r), timeoutMs: 10000, maxBuffer: 4 * 1024 * 1024 });
    const lines = []; let item = {};
    for (const line of raw.split('\n')) {
        const m = /^([a-f0-9]{40,64}) (\d+) (\d+)/.exec(line);
        if (m) item = { commit: m[1], line: Number(m[3]) };
        else if (line.startsWith('author ')) item.author = line.slice(7);
        else if (line.startsWith('\t')) lines.push({ ...item, text: line.slice(1) });
    }
    return { ref: sha, path: file, lines };
}
module.exports = { compare, parseCompare, diffLines, resolve, locked, merge, search, blame, fail };
