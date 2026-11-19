'use strict';

/**
 * Installed dependencies kept between runs (2026-11-19, the owner: "our own modular, optimized, efficient … better
 * system … making use of the RAM").
 *
 * Most pushes change code, not the lockfile, yet every run reinstalled the same dependencies from scratch (Live:
 * 824 MB in 19,000 files). After an install phase succeeds, the runner keeps what it made, keyed by everything that
 * decides it: the repository, its lockfile(s), the root package.json's install scripts, the install command, the image
 * and engine, the runner's Node and platform. A later run with the same key copies it back and skips the install
 * phase entirely; its tests still run in their own sandbox with no network.
 *
 * What is kept: every node_modules folder outside another one, plus any file outside them that the install created or
 * changed (a `prepare` build's output). The copy is taken right after the install, before any test runs, so a test can
 * never change what a later run gets. The store lives on disk, so the kernel's page cache keeps the busy entries in
 * memory and gives the memory back under pressure; the least recently used entries go first once it passes its size.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare'];
// The runner's own folders in a run's work directory, never part of what the repository installs.
const RUNNER_DIRS = new Set(['.git', '.ci', '.home', '.cache', '.pnpm']);
const KEY_VERSION = 2;

/**
 * Every lockfile in the checkout, with its path: the root's, and each app's in a repository that installs per app
 * (OpenVibe.Tools runs `npm run install:all`: its root lockfile alone said nothing about the apps' dependencies, so a
 * changed app lockfile would have reused a stale install). node_modules and the runner's own folders are skipped.
 */
function lockfilesIn(dir, { maxDepth = 6 } = {}) {
    const found = [];
    const walk = (rel, depth) => {
        let entries;
        try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const child = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || e.name === '.git' || (!rel && RUNNER_DIRS.has(e.name))) continue;
                if (depth < maxDepth) walk(child, depth + 1);
            } else if (LOCKFILES.includes(e.name)) found.push(child);
        }
    };
    walk('', 0);
    return found.sort();
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The cache key for a checkout, or null when it has no lockfile (an install without one is not reproducible). */
function cacheKey({ dir, repo, install, image = '', engine = '', node = process.version }) {
    const locks = lockfilesIn(dir);
    if (!locks.length) return null;
    const pkg = readJson(path.join(dir, 'package.json')) || {};
    const scripts = Object.fromEntries(INSTALL_SCRIPTS.filter((s) => pkg.scripts && pkg.scripts[s]).map((s) => [s, pkg.scripts[s]]));
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify({
        v: KEY_VERSION, repo: String(repo || '').toLowerCase(), install: String(install || ''), image: String(image || ''),
        engine: String(engine || ''), node, platform: process.platform, arch: process.arch, scripts,
        packageManager: pkg.packageManager || null, workspaces: pkg.workspaces || null,
    }));
    for (const f of locks) {
        hash.update(`\0${f}\0`);
        hash.update(fs.readFileSync(path.join(dir, f)));
    }
    return hash.digest('hex').slice(0, 40);
}

/**
 * Every file outside node_modules (and outside the runner's folders), with its size and time, and every top-level
 * node_modules folder. Cheap: a repository's own files, not its dependencies.
 */
function survey(dir) {
    const files = new Map();
    const modules = [];
    const walk = (rel) => {
        let entries;
        try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const child = rel ? `${rel}/${e.name}` : e.name;
            if (!rel && RUNNER_DIRS.has(e.name)) continue;
            if (e.name === 'node_modules' && e.isDirectory()) { modules.push(child); continue; }
            if (e.isDirectory()) { walk(child); continue; }
            try {
                const st = fs.lstatSync(path.join(dir, child));
                files.set(child, `${st.size}:${Math.round(st.mtimeMs)}`);
            } catch { /* gone */ }
        }
    };
    walk('');
    return { files, modules };
}

/** What an install made: its node_modules folders and the files it created or changed outside them. */
function installed(before, after) {
    const changed = [];
    for (const [rel, sig] of after.files) if (before.files.get(rel) !== sig) changed.push(rel);
    return { modules: after.modules.slice().sort(), changed: changed.sort() };
}

function run(command, args, { cwd } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${err.trim().slice(0, 300)}`))));
    });
}

async function copyPaths(fromDir, rels, toDir) {
    fs.mkdirSync(toDir, { recursive: true });
    for (let i = 0; i < rels.length; i += 200) {
        await run('cp', ['-a', '--reflink=auto', '--parents', '-t', toDir, '--', ...rels.slice(i, i + 200)], { cwd: fromDir });
    }
}

function duBytes(dir) {
    let total = 0;
    const walk = (p) => {
        let entries;
        try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const child = path.join(p, e.name);
            if (e.isDirectory()) walk(child);
            else { try { total += fs.lstatSync(child).size; } catch { /* gone */ } }
        }
    };
    walk(dir);
    return total;
}

function createDepsCache({ root, maxMb = 20480, log = () => {} }) {
    if (!root) return null;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const entry = (key) => path.join(root, key);
    const maxBytes = Math.max(256, Number(maxMb) || 20480) * 1024 * 1024;

    /** Copy a kept install into the run's checkout. Returns what it restored, or null on a miss. */
    async function restore(key, dir) {
        if (!key) return null;
        const at = entry(key);
        const manifest = readJson(path.join(at, 'manifest.json'));
        if (!manifest || !fs.existsSync(path.join(at, 'files'))) return null;
        const started = Date.now();
        await run('cp', ['-a', '--reflink=auto', '--', `${path.join(at, 'files')}/.`, dir]);
        const now = new Date();
        try { fs.utimesSync(path.join(at, 'manifest.json'), now, now); } catch { /* evicted meanwhile */ }
        return { ...manifest, ms: Date.now() - started };
    }

    /** Keep what an install made (taken before the tests run), then trim the store to its size. */
    async function save(key, dir, made) {
        if (!key || !made || (!made.modules.length && !made.changed.length)) return null;
        if (fs.existsSync(path.join(entry(key), 'manifest.json'))) return null;
        const started = Date.now();
        const tmp = path.join(root, `.tmp-${key}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
        try {
            await copyPaths(dir, [...made.modules, ...made.changed], path.join(tmp, 'files'));
            const bytes = duBytes(path.join(tmp, 'files'));
            const manifest = { key, bytes, modules: made.modules, changed: made.changed.length, saved_at: new Date().toISOString() };
            fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest));
            try {
                fs.renameSync(tmp, entry(key));
            } catch {
                // Another run with the same key kept it first.
                fs.rmSync(tmp, { recursive: true, force: true });
                return null;
            }
            trim();
            return { ...manifest, ms: Date.now() - started };
        } catch (err) {
            fs.rmSync(tmp, { recursive: true, force: true });
            log(`[git-ci-runner] the install was not kept: ${err.message}`);
            return null;
        }
    }

    /** Remove the least recently used entries until the store fits (and half-written ones a crash left behind). */
    function trim() {
        let names;
        try { names = fs.readdirSync(root); } catch { return; }
        const rows = [];
        for (const name of names) {
            const at = path.join(root, name);
            if (name.startsWith('.tmp-')) {
                try { if (Date.now() - fs.statSync(at).mtimeMs > 3600_000) fs.rmSync(at, { recursive: true, force: true }); } catch { /* gone */ }
                continue;
            }
            const manifest = readJson(path.join(at, 'manifest.json'));
            if (!manifest) { fs.rmSync(at, { recursive: true, force: true }); continue; }
            let used = 0;
            try { used = fs.statSync(path.join(at, 'manifest.json')).mtimeMs; } catch { /* gone */ }
            rows.push({ at, bytes: Number(manifest.bytes) || 0, used });
        }
        rows.sort((a, b) => b.used - a.used);
        let total = 0;
        for (const row of rows) {
            total += row.bytes;
            if (total > maxBytes) fs.rmSync(row.at, { recursive: true, force: true });
        }
    }

    return { root, restore, save, trim };
}

/**
 * The commands for a repository registered with `auto` (the default for a new one): a pnpm lockfile installs with
 * pnpm, an npm lockfile with `npm ci`, a package.json alone with `npm install`; the tests are `npm test`. A repository
 * without a package.json, or without a test script, has nothing to run here.
 */
function autoCommands(dir) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (!pkg) return { none: 'no package.json' };
    if (!pkg.scripts || !pkg.scripts.test) return { none: 'package.json has no test script' };
    let install = 'npm install --no-audit --no-fund';
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) install = 'pnpm install --frozen-lockfile';
    else if (fs.existsSync(path.join(dir, 'package-lock.json')) || fs.existsSync(path.join(dir, 'npm-shrinkwrap.json'))) install = 'npm ci --no-audit --no-fund';
    return { install, test: 'npm test' };
}

module.exports = { createDepsCache, cacheKey, survey, installed, autoCommands, lockfilesIn, LOCKFILES };
