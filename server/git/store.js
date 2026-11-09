'use strict';

/**
 * Repositories on disk. A repository is a bare git repository at DATA_DIR/repos/<owner>/<name>.git; this
 * module is the only place that knows that path, and it reads it with plumbing only:
 *
 *   rev-parse --verify      a ref to a commit
 *   ls-tree                 a directory
 *   cat-file --batch        a blob (one process per hot repository, ./cat-file.js)
 *   log --format            history, contributors, commits per week
 *   show / diff-tree        one commit and its diff
 *
 * Every argument array begins with the command and a `--` or `--end-of-options` before anything a request
 * chose. Refs and paths are validated first (./refs.js), then git checks the ref again.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { runGit, runText, configEnv } = require('./run');
const { validRef, validPath, checkRefWithGit } = require('./refs');
const { createCatFilePool } = require('./cat-file');
const { REPOS_DIR, HOOKS_DIR, TMP_DIR } = require('../paths');

const REC = '\x1e';
const catFiles = createCatFilePool();

const repoDir = (owner, name) => path.join(REPOS_DIR, owner, `${name}.git`);

async function ensureDataDirs() {
    await fs.mkdir(REPOS_DIR, { recursive: true });
    await fs.mkdir(HOOKS_DIR, { recursive: true });
    await fs.mkdir(TMP_DIR, { recursive: true });
}

async function repoExists(owner, name) {
    try { return (await fs.stat(repoDir(owner, name))).isDirectory(); } catch { return false; }
}

async function dirBytes(dir) {
    let total = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) total += await dirBytes(p);
        else if (e.isFile()) total += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
    }
    return total;
}

const repoBytes = (owner, name) => dirBytes(repoDir(owner, name));

/** A bare repository with our settings: no hooks but an empty directory, fsck on push, our size cap. */
async function initRepo(owner, name, { defaultBranch = 'main', maxPushBytes } = {}) {
    await ensureDataDirs();
    const dir = repoDir(owner, name);
    await fs.mkdir(path.dirname(dir), { recursive: true });
    if (!(await repoExists(owner, name))) {
        await runGit(['init', '--bare', '--initial-branch', defaultBranch, dir], { timeoutMs: 30_000 });
        await setRepoConfig(dir, { maxPushBytes });
    }
    return dir;
}

async function setRepoConfig(dir, { maxPushBytes } = {}) {
    const pairs = {
        'receive.fsckObjects': 'true',
        'transfer.fsckObjects': 'true',
        'core.hooksPath': HOOKS_DIR,
        'receive.denyDeleteCurrent': 'ignore',
        'gc.auto': '0',
    };
    if (maxPushBytes) pairs['receive.maxInputSize'] = String(maxPushBytes);
    // -c on every call rather than writing config: the values cannot be edited by a repository.
    await runGit(['config', 'receive.fsckObjects', 'true'], { cwd: dir });
    await runGit(['config', 'transfer.fsckObjects', 'true'], { cwd: dir });
    await runGit(['config', 'core.hooksPath', HOOKS_DIR], { cwd: dir });
    await runGit(['config', 'gc.auto', '0'], { cwd: dir });
    if (maxPushBytes) await runGit(['config', 'receive.maxInputSize', String(maxPushBytes)], { cwd: dir });
}

async function setRemote(dir, url) {
    await runGit(['remote', 'remove', 'origin'], { cwd: dir, allowFailure: true });
    await runGit(['remote', 'add', 'origin', url], { cwd: dir });
}

/** The commit a ref names, or null. */
async function resolveCommit(owner, name, ref) {
    if (!validRef(ref)) return null;
    const dir = repoDir(owner, name);
    if (!(await repoExists(owner, name))) return null;
    try {
        const out = await runText(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { cwd: dir });
        return out.trim() || null;
    } catch { return null; }
}

async function defaultRef(owner, name, branch = 'main') {
    return resolveCommit(owner, name, branch) ? branch : null;
}

function parseLsTree(text) {
    const out = [];
    for (const rec of text.split('\x00')) {
        if (!rec) continue;
        const m = /^(\d{6}) (\w+) ([0-9a-f]+)\s+(\d+|-)\t(.*)$/s.exec(rec);
        if (!m) continue;
        out.push({ mode: m[1], type: m[2], sha: m[3], size: m[4] === '-' ? null : Number(m[4]), name: m[5] });
    }
    return out;
}

async function lastCommitFor(dir, filePath) {
    try {
        const out = await runText(['log', '-1', '--format=%H%x00%s%x00%cI%x00%an', '--', filePath], { cwd: dir, maxBuffer: 64 * 1024 });
        const [sha, message, date, author] = out.trim().split('\x00');
        if (!sha) return null;
        return { sha, message: message || '', date, author_name: author || '' };
    } catch { return null; }
}

/** One directory at a ref: entries with mode, size and the last commit that touched each. */
async function readTree(owner, name, ref, dirPath = '', { withLastCommit = true, limit = 300 } = {}) {
    if (!validRef(ref) || !validPath(dirPath)) return null;
    const sha = await resolveCommit(owner, name, ref);
    if (!sha) return null;
    const dir = repoDir(owner, name);
    const args = ['ls-tree', '-z', '-l', sha];
    if (dirPath) args.push('--', dirPath);
    const out = await runText(args, { cwd: dir, maxBuffer: 8 * 1024 * 1024 });
    const entries = parseLsTree(out);
    const shown = entries.slice(0, limit);
    if (withLastCommit) {
        for (const e of shown) {
            const child = dirPath ? `${dirPath}/${e.name}` : e.name;
            e.path = child;
            e.last_commit = await lastCommitFor(dir, child);
        }
    } else {
        for (const e of shown) e.path = dirPath ? `${dirPath}/${e.name}` : e.name;
    }
    return { ref, path: dirPath, commit: sha, entries: shown, truncated: entries.length > shown.length };
}

/** A file's bytes through the repository's cat-file process; null when it is not a blob at that ref. */
async function readBlob(owner, name, ref, filePath, { maxBytes = 2 * 1024 * 1024 } = {}) {
    if (!validRef(ref) || !validPath(filePath) || !filePath) return null;
    if (!(await resolveCommit(owner, name, ref))) return null;
    const dir = repoDir(owner, name);
    const obj = await catFiles.read(dir, `${ref}:${filePath}`);
    if (!obj || obj.type !== 'blob') return null;
    const truncated = obj.size > maxBytes;
    const data = truncated ? obj.data.subarray(0, maxBytes) : obj.data;
    const binary = data.includes(0);
    return {
        type: obj.type, size: obj.size, truncated, binary,
        text: binary ? null : data.toString('utf8'),
    };
}

async function rawBlob(owner, name, ref, filePath, { maxBytes = 16 * 1024 * 1024 } = {}) {
    const blob = await readBlob(owner, name, ref, filePath, { maxBytes });
    if (!blob) return null;
    return blob;
}

/** The raw bytes of a blob (the raw file link). */
async function blobBytes(owner, name, ref, filePath, { maxBytes = 16 * 1024 * 1024 } = {}) {
    if (!validRef(ref) || !validPath(filePath) || !filePath) return null;
    if (!(await resolveCommit(owner, name, ref))) return null;
    const obj = await catFiles.read(repoDir(owner, name), `${ref}:${filePath}`);
    if (!obj || obj.type !== 'blob') return null;
    return { size: obj.size, data: obj.data.subarray(0, maxBytes), truncated: obj.size > maxBytes };
}

/**
 * A branch and files in one request, no clone: git plumbing on a temporary index.
 * files [{ path, content, encoding?: 'utf8'|'base64' }]; base is a commit-ish or a branch (default: the
 * repository's default branch). Returns { sha, branch, tree }.
 */
const commitLocks = new Map();
async function commitFiles(owner, name, { branch, message, files, base, author, committer }, { defaultBranch = 'main', maxBytes = 512 * 1024 * 1024 } = {}) {
    if (!validRef(branch)) throw Object.assign(new Error('branch is not a valid ref'), { status: 422 });
    if (!message || typeof message !== 'string' || message.length > 100000) throw Object.assign(new Error('a message is required'), { status: 422 });
    if (!Array.isArray(files) || !files.length || files.length > 200) throw Object.assign(new Error('one to 200 files are required'), { status: 422 });
    let total = 0;
    for (const f of files) {
        if (!f || !validPath(f.path) || !f.path) throw Object.assign(new Error('every file needs a safe path'), { status: 422 });
        const buf = Buffer.from(String(f.content == null ? '' : f.content), f.encoding === 'base64' ? 'base64' : 'utf8');
        total += buf.length;
        if (total > maxBytes) throw Object.assign(new Error('the files are larger than a push may be'), { status: 413 });
        f.buffer = buf;
    }
    const dir = repoDir(owner, name);
    if (!(await repoExists(owner, name))) throw Object.assign(new Error('no such repository'), { status: 404 });
    const lockKey = dir;
    const previous = commitLocks.get(lockKey) || Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    const mine = previous.then(() => gate);
    commitLocks.set(lockKey, mine);
    try {
        await previous;
        const baseRef = base || (await resolveCommit(owner, name, branch) ? branch : defaultBranch);
        const baseSha = await resolveCommit(owner, name, baseRef);
        if (!baseSha) throw Object.assign(new Error('the base branch has no commits yet'), { status: 422 });
        const indexFile = path.join(TMP_DIR, `commit-${crypto.randomBytes(8).toString('hex')}.index`);
        const who = {
            name: (author && author.name) || 'OpenVibe Git', email: (author && author.email) || 'git@openvibe.codes',
        };
        const env = {
            GIT_INDEX_FILE: indexFile,
            GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email,
            GIT_COMMITTER_NAME: (committer && committer.name) || who.name, GIT_COMMITTER_EMAIL: (committer && committer.email) || who.email,
        };
        try {
            await runGit(['read-tree', baseSha], { cwd: dir, env });
            for (const f of files) {
                const sha = (await runGit(['hash-object', '-w', '--stdin'], { cwd: dir, input: f.buffer })).stdout.toString('utf8').trim();
                await runGit(['update-index', '--add', '--cacheinfo', `100644,${sha},${f.path}`], { cwd: dir, env });
            }
            const tree = (await runGit(['write-tree'], { cwd: dir, env })).stdout.toString('utf8').trim();
            const commit = (await runGit(['commit-tree', tree, '-p', baseSha, '-m', message], { cwd: dir, env })).stdout.toString('utf8').trim();
            const old = await resolveCommit(owner, name, branch);
            const refArgs = ['update-ref', `refs/heads/${branch}`, commit];
            if (old) refArgs.push(old);
            await runGit(refArgs, { cwd: dir });
            return { sha: commit, branch, tree, base: baseSha };
        } finally {
            release();
            if (commitLocks.get(lockKey) === mine) commitLocks.delete(lockKey);
            await fs.rm(indexFile, { force: true }).catch(() => {});
        }
    } catch (err) {
        release();
        if (commitLocks.get(lockKey) === mine) commitLocks.delete(lockKey);
        throw err;
    }
}

/** The history of a ref, optionally of one path. */
async function history(owner, name, ref, { path: filePath = '', limit = 50, skip = 0 } = {}) {
    if (!validRef(ref) || !validPath(filePath)) return null;
    const sha = await resolveCommit(owner, name, ref);
    if (!sha) return null;
    const dir = repoDir(owner, name);
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    const args = ['log', `--max-count=${n}`, `--skip=${Math.max(0, Number(skip) || 0)}`, `--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%cI%x00%P${REC}`, sha];
    if (filePath) args.push('--', filePath);
    const out = await runText(args, { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
    return out.split(REC).map((r) => r.replace(/^\n/, '')).filter(Boolean).map((rec) => {
        const [shaFull, short, subject, authorName, authorEmail, date, parents] = rec.split('\x00');
        return { sha: shaFull, short, subject, author: { name: authorName, email: authorEmail }, date, parents: parents ? parents.split(' ').filter(Boolean) : [] };
    });
}

async function commitDetail(owner, name, sha, { diff = true } = {}) {
    if (!/^[0-9a-f]{7,64}$/.test(String(sha))) return null;
    if (!(await repoExists(owner, name))) return null;
    const dir = repoDir(owner, name);
    let out;
    try {
        out = await runText(['show', '-s', '--format=%H%x00%B%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%P%x00%T', sha], { cwd: dir });
    } catch { return null; }
    const [full, message, an, ae, ad, cn, ce, cd, parents, tree] = out.split('\x00');
    if (!full) return null;
    const record = {
        sha: full, message: message || '', author: { name: an, email: ae, date: ad }, committer: { name: cn, email: ce, date: cd },
        parents: parents ? parents.split(' ').filter(Boolean) : [], tree_sha: tree, date: cd,
    };
    if (diff) {
        try {
            const numstat = await runText(['show', '--format=', '--numstat', '--no-renames', full], { cwd: dir, maxBuffer: 8 * 1024 * 1024 });
            const files = [];
            let additions = 0; let deletions = 0;
            for (const line of numstat.split('\n')) {
                const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
                if (!m) continue;
                const add = m[1] === '-' ? 0 : Number(m[1]);
                const del = m[2] === '-' ? 0 : Number(m[2]);
                additions += add; deletions += del;
                files.push({ path: m[3], status: 'modified', additions: add, deletions: del, patch: null });
            }
            const patch = await runText(['show', '--format=', '--patch', '--no-color', '--no-renames', full], { cwd: dir, maxBuffer: 8 * 1024 * 1024 });
            record.stats = { files: files.length, additions, deletions };
            record.files = files;
            record.diff = patch;
        } catch {
            record.stats = { files: 0, additions: 0, deletions: 0 };
            record.files = [];
            record.diff = '';
        }
    }
    return record;
}

function parseRefs(out) {
    return out.split(REC).map((r) => r.replace(/^\n/, '')).filter(Boolean).map((rec) => {
        const [name, sha, date, subject] = rec.split('\x00');
        return { name, sha, date, subject: subject || '' };
    });
}

async function branches(owner, name) {
    if (!(await repoExists(owner, name))) return [];
    const out = await runText(['for-each-ref', 'refs/heads', `--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)%00%(contents:subject)${REC}`], { cwd: repoDir(owner, name) });
    return parseRefs(out);
}

async function tags(owner, name) {
    if (!(await repoExists(owner, name))) return [];
    const out = await runText(['for-each-ref', 'refs/tags', `--format=%(refname:short)%00%(objectname)%00%(creatordate:iso-strict)%00%(contents:subject)${REC}`], { cwd: repoDir(owner, name) });
    return parseRefs(out);
}

async function contributors(owner, name, ref = 'main') {
    if (!validRef(ref) || !(await resolveCommit(owner, name, ref))) return [];
    const out = await runText(['shortlog', '-sne', ref], { cwd: repoDir(owner, name), maxBuffer: 4 * 1024 * 1024 });
    const list = [];
    for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\t(.+) <([^>]*)>$/.exec(line);
        if (m) list.push({ commits: Number(m[1]), name: m[2], email: m[3] });
    }
    return list;
}

/** Commits per ISO week, oldest first, for the last `weeks` weeks. */
async function commitsPerWeek(owner, name, ref = 'main', { weeks = 26 } = {}) {
    if (!validRef(ref) || !(await resolveCommit(owner, name, ref))) return [];
    const since = new Date(Date.now() - weeks * 7 * 86400_000).toISOString();
    const out = await runText(['log', `--since=${since}`, '--format=%cI', ref], { cwd: repoDir(owner, name), maxBuffer: 16 * 1024 * 1024 });
    const counts = new Map();
    const monday = (d) => {
        const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        const day = (x.getUTCDay() + 6) % 7;
        x.setUTCDate(x.getUTCDate() - day);
        return x.toISOString().slice(0, 10);
    };
    const now = new Date();
    for (let i = weeks - 1; i >= 0; i -= 1) {
        const d = new Date(now.getTime() - i * 7 * 86400_000);
        counts.set(monday(d), 0);
    }
    for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const w = monday(new Date(line));
        if (counts.has(w)) counts.set(w, counts.get(w) + 1);
    }
    return [...counts.entries()].map(([week, commits]) => ({ week, commits }));
}

const LANGUAGES = {
    js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', jsx: 'JavaScript',
    css: 'CSS', scss: 'SCSS', html: 'HTML', htm: 'HTML', json: 'JSON', md: 'Markdown', sql: 'SQL', sh: 'Shell',
    yml: 'YAML', yaml: 'YAML', py: 'Python', go: 'Go', rs: 'Rust', rb: 'Ruby', php: 'PHP', java: 'Java', c: 'C',
    h: 'C', cc: 'C++', cpp: 'C++', hpp: 'C++', cs: 'C#', swift: 'Swift', kt: 'Kotlin', svg: 'SVG', png: 'Image',
    jpg: 'Image', jpeg: 'Image', gif: 'Image', webp: 'Image', woff2: 'Font', woff: 'Font', lock: 'Lockfile',
};

/** Language shares by bytes across a ref's tree (the language bar). */
async function languages(owner, name, ref = 'main') {
    if (!validRef(ref) || !(await resolveCommit(owner, name, ref))) return {};
    const out = await runText(['ls-tree', '-r', '-l', ref], { cwd: repoDir(owner, name), maxBuffer: 32 * 1024 * 1024 });
    const total = new Map();
    for (const rec of out.split('\n')) {
        const m = /^\d{6} \w+ [0-9a-f]+\s+(\d+)\t(.*)$/.exec(rec);
        if (!m) continue;
        const file = m[2];
        const ext = path.extname(file).slice(1).toLowerCase();
        const lang = LANGUAGES[ext];
        if (!lang) continue;
        total.set(lang, (total.get(lang) || 0) + Number(m[1]));
    }
    const sum = [...total.values()].reduce((a, b) => a + b, 0);
    if (!sum) return {};
    return Object.fromEntries([...total.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round((v / sum) * 1000) / 10]));
}

/** Write the first commit of a starter repository from files on disk. */
async function writeInitialCommit(owner, name, { files, message, defaultBranch = 'main' }) {
    const dir = repoDir(owner, name);
    const indexFile = path.join(TMP_DIR, `${owner}-${name}-${Date.now()}.index`);
    const env = {
        GIT_INDEX_FILE: indexFile,
        GIT_AUTHOR_NAME: 'OpenVibe Git', GIT_AUTHOR_EMAIL: 'git@openvibe.codes',
        GIT_COMMITTER_NAME: 'OpenVibe Git', GIT_COMMITTER_EMAIL: 'git@openvibe.codes',
    };
    try {
        await runGit(['read-tree', '--empty'], { cwd: dir, env });
        for (const file of files) {
            const sha = (await runGit(['hash-object', '-w', '--stdin'], { cwd: dir, input: Buffer.from(file.content, 'utf8') })).stdout.toString('utf8').trim();
            await runGit(['update-index', '--add', '--cacheinfo', `100644,${sha},${file.path}`], { cwd: dir, env });
        }
        const tree = (await runGit(['write-tree'], { cwd: dir, env })).stdout.toString('utf8').trim();
        const commit = (await runGit(['commit-tree', tree, '-m', message], { cwd: dir, env })).stdout.toString('utf8').trim();
        await runGit(['update-ref', `refs/heads/${defaultBranch}`, commit], { cwd: dir });
        return commit;
    } finally {
        await fs.rm(indexFile, { force: true }).catch(() => {});
    }
}

/** Clone a mirror for the first time (a bare mirror with refs/* as they are). */
async function cloneMirror(owner, name, url, { timeoutMs = 600_000 } = {}) {
    await ensureDataDirs();
    const dir = repoDir(owner, name);
    await fs.mkdir(path.dirname(dir), { recursive: true });
    const tmp = `${dir}.tmp-${Date.now()}`;
    try {
        await runGit(['clone', '--mirror', '--quiet', url, tmp], { timeoutMs, maxBuffer: 16 * 1024 * 1024 });
        await fs.rename(tmp, dir);
        await setRepoConfig(dir);
        return true;
    } catch (err) {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
        throw err;
    }
}

/** A fork on this disk, from one of our bare repositories (no network). */
async function cloneLocal(srcOwner, srcName, dstOwner, dstName, { timeoutMs = 120_000 } = {}) {
    await ensureDataDirs();
    const dst = repoDir(dstOwner, dstName);
    const tmp = `${dst}.tmp-${Date.now()}`;
    await fs.mkdir(path.dirname(dst), { recursive: true });
    try {
        await runGit(['clone', '--bare', '--quiet', repoDir(srcOwner, srcName), tmp], { timeoutMs, maxBuffer: 8 * 1024 * 1024 });
        await fs.rename(tmp, dst);
        await setRepoConfig(dst);
        return true;
    } catch (err) {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
        throw err;
    }
}

/** Fetch a mirror's branches and tags again. */
async function fetchMirror(owner, name, { timeoutMs = 600_000 } = {}) {
    const dir = repoDir(owner, name);
    await runGit(['fetch', '--prune', '--tags', '--quiet', 'origin'], { cwd: dir, timeoutMs, maxBuffer: 16 * 1024 * 1024 });
}

/** Push a repository mirror to another URL, the token in the environment (never argv, never the log). */
async function pushMirror(owner, name, url, { token, timeoutMs = 600_000 } = {}) {
    const dir = repoDir(owner, name);
    const env = configEnv({ 'http.extraHeader': `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` });
    await runGit(['push', '--mirror', '--quiet', url], { cwd: dir, timeoutMs, env, maxBuffer: 16 * 1024 * 1024 });
}

async function removeRepo(owner, name) {
    await fs.rm(repoDir(owner, name), { recursive: true, force: true });
}

module.exports = {
    repoDir, ensureDataDirs, repoExists, repoBytes, initRepo, setRepoConfig, setRemote, resolveCommit, defaultRef,
    readTree, readBlob, rawBlob, blobBytes, history, commitDetail, branches, tags, contributors, commitsPerWeek, languages, commitFiles,
    writeInitialCommit, cloneMirror, cloneLocal, fetchMirror, pushMirror, removeRepo, parseLsTree, catFiles,
};
