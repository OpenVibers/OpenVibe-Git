'use strict';

// The npm publish and install protocol for our four public, unscoped libraries.
// Package bytes live in PostgreSQL with immutable versions. A writer must hold
// the forge runner credential, which is already checked with a constant-time
// comparison; a package response never returns that credential.
const crypto = require('node:crypto');
const express = require('express');

const NAMES = new Set(['openvibe-contracts', 'openvibe-sdk', 'openvibe-shared', 'openvibe-publishing']);
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const TAG = /^[a-z][a-z0-9._-]{0,39}$/;
const MAX_TARBALL = 12 * 1024 * 1024;
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function createNpmRegistry({ store, config, ciAuth, log = console }) {
    const r = express.Router();
    const owner = 'openvibers';
    const base = () => `${config.baseUrl}/api/packages/${owner}/npm`;
    const bad = (res, status, error) => res.status(status).json({ error });
    const named = (req, res) => {
        if (req.params.owner !== owner || !NAMES.has(req.params.name)) {
            bad(res, 404, 'package not found');
            return false;
        }
        return true;
    };
    const manifestFor = (row) => typeof row.manifest === 'string' ? JSON.parse(row.manifest) : row.manifest;
    const tarballUrl = (name, version) => `${base()}/${name}/-/${name}-${version}.tgz`;

    r.get('/:owner/npm/:name', route(async (req, res) => {
        if (!named(req, res)) return;
        const rows = await store.many('SELECT version, manifest, integrity, created_at FROM git_npm_versions WHERE owner = ? AND name = ? ORDER BY created_at', [owner, req.params.name]);
        if (!rows.length) return bad(res, 404, 'package not found');
        const tags = await store.many('SELECT tag, version FROM git_npm_tags WHERE owner = ? AND name = ?', [owner, req.params.name]);
        const versions = {};
        const time = {};
        for (const row of rows) {
            versions[row.version] = { ...manifestFor(row), name: req.params.name, version: row.version,
                dist: { tarball: tarballUrl(req.params.name, row.version), integrity: row.integrity } };
            time[row.version] = new Date(row.created_at).toISOString();
        }
        const distTags = Object.fromEntries(tags.map((x) => [x.tag, x.version]));
        if (!distTags.latest) distTags.latest = rows.at(-1).version;
        res.set('Cache-Control', 'public, max-age=60').json({ name: req.params.name, 'dist-tags': distTags, versions, time });
    }));

    r.get('/:owner/npm/:name/-/:file', route(async (req, res) => {
        if (!named(req, res)) return;
        const prefix = `${req.params.name}-`;
        const file = req.params.file;
        if (!file.startsWith(prefix) || !file.endsWith('.tgz')) return bad(res, 404, 'tarball not found');
        const version = file.slice(prefix.length, -4);
        if (!VERSION.test(version)) return bad(res, 404, 'tarball not found');
        const row = await store.maybe('SELECT tarball, integrity FROM git_npm_versions WHERE owner = ? AND name = ? AND version = ?', [owner, req.params.name, version]);
        if (!row) return bad(res, 404, 'tarball not found');
        res.set('Cache-Control', 'public, max-age=31536000, immutable').set('Content-Type', 'application/octet-stream')
            .set('ETag', `"${row.integrity}"`).send(Buffer.from(row.tarball));
    }));

    // npm publish sends a JSON packument with one version and one base64 attachment.
    r.put('/:owner/npm/:name', express.json({ limit: '20mb' }), route(async (req, res) => {
        if (!named(req, res)) return;
        if (!ciAuth.ok(req)) return bad(res, 401, 'publisher credential required');
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.name !== req.params.name) return bad(res, 422, 'invalid package');
        const entries = Object.entries(body.versions || {});
        const attachments = Object.entries(body._attachments || {});
        if (entries.length !== 1 || attachments.length !== 1) return bad(res, 422, 'publish one version and one tarball');
        const [version, manifest] = entries[0];
        if (!VERSION.test(version) || !manifest || manifest.name !== req.params.name || manifest.version !== version) return bad(res, 422, 'invalid version');
        const [filename, attachment] = attachments[0];
        if (filename !== `${req.params.name}-${version}.tgz` || !attachment || typeof attachment.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.data)) return bad(res, 422, 'invalid tarball');
        const tarball = Buffer.from(attachment.data, 'base64');
        if (!tarball.length || tarball.length > MAX_TARBALL || tarball[0] !== 0x1f || tarball[1] !== 0x8b ||
            tarball.toString('base64') !== attachment.data) return bad(res, 422, 'invalid tarball');
        const integrity = `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`;
        const saved = { ...manifest };
        delete saved._attachments;
        saved.dist = { tarball: tarballUrl(req.params.name, version), integrity };
        try {
            await store.execute('INSERT INTO git_npm_versions (owner, name, version, manifest, tarball, integrity) VALUES (?, ?, ?, ?, ?, ?)',
                [owner, req.params.name, version, JSON.stringify(saved), tarball, integrity]);
        } catch (err) {
            if (/duplicate key|unique/i.test(err.message)) return bad(res, 409, 'version already published');
            throw err;
        }
        const desired = body['dist-tags'] || {};
        const tags = Object.entries(desired).filter(([tag, v]) => TAG.test(tag) && v === version);
        if (!tags.length) tags.push(['latest', version]);
        for (const [tag] of tags) {
            await store.execute('INSERT INTO git_npm_tags (owner, name, tag, version) VALUES (?, ?, ?, ?) ON CONFLICT (owner, name, tag) DO UPDATE SET version = EXCLUDED.version',
                [owner, req.params.name, tag, version]);
        }
        log.info('[OpenVibe.Git] npm package published:', req.params.name, version);
        res.status(201).json({ ok: true, name: req.params.name, version, integrity });
    }));

    return r;
}

module.exports = { createNpmRegistry, NAMES, MAX_TARBALL };
