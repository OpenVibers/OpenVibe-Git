'use strict';

/**
 * The repositories the network's own contracts name (openvibe-contracts manifests/repositories/*.json and
 * manifests/services/*.json). When GitHub's REST listing is refused for quota (the host has 60 anonymous calls an
 * hour, shared by every service), the official mirror seed still knows what to mirror: each repository manifest's
 * `repository`, or OpenVibers/<name> when it is null, plus each service manifest's `repository`.
 *
 * Read-only at boot from the installed package; no network, no REST quota, no cache to go stale.
 */
const fs = require('node:fs');
const path = require('node:path');

const FULL_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** The installed openvibe-contracts manifests directory, or null when the package cannot be found. */
function manifestsRoot() {
    try {
        return path.join(path.dirname(require.resolve('openvibe-contracts/package.json')), 'manifests');
    } catch {
        return null;
    }
}

function jsonFiles(dir) {
    try {
        return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
        return [];
    }
}

function readJson(file) {
    try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        return value && typeof value === 'object' ? value : null;
    } catch {
        return null;
    }
}

/**
 * [{ full_name, name, clone_url }], deduplicated by lower-case full name, in manifest order. A repository manifest
 * without `repository` (AFResume today) is OpenVibers/<name>; a service manifest without one is named but not
 * mirrored.
 */
function contractRepositories({ root = manifestsRoot() } = {}) {
    const found = new Map();
    if (!root) return [];

    const add = (repository, fallbackName) => {
        const full = String(repository || '').trim() || (fallbackName ? `OpenVibers/${fallbackName}` : '');
        if (!FULL_RE.test(full)) return;
        const [owner, name] = full.split('/');
        if (!owner || !name || name === '.' || name === '..') return;
        const key = full.toLowerCase();
        if (found.has(key)) return;
        found.set(key, { full_name: full, name, clone_url: `https://github.com/${full}.git` });
    };

    for (const dir of ['repositories', 'services']) {
        const base = path.join(root, dir);
        for (const file of jsonFiles(base)) {
            const manifest = readJson(path.join(base, file));
            if (!manifest) continue;
            add(manifest.repository, dir === 'repositories' ? manifest.name : '');
        }
    }
    return [...found.values()];
}

module.exports = { contractRepositories, manifestsRoot, FULL_RE };
