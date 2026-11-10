'use strict';

/**
 * Tarballs: GET /<owner>/<name>/archive/<ref>.tar.gz (and the API form) answers a gzip tarball of that
 * ref, made by git archive from the bare repository and streamed to the reader.
 *
 * The bytes are git's own archive of the resolved commit, so a tag always answers the same bytes; the top
 * folder is <name>-<commit>/, so a package manager can pin it. The ETag is the commit; a full commit id or
 * a tag caches immutably, a branch for a minute. Reads follow the raw file's auth: public repositories
 * need no token, private ones answer 404 to anyone who may not see them.
 */
const { spawnGit } = require('./git/run');
const { validRef } = require('./git/refs');

const SUFFIX = '.tar.gz';
const FULL_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The ref a /archive/<file> path names, or null. <file> is <ref>.tar.gz; a branch may hold slashes. */
function refOfArchive(file) {
    const name = String(file || '');
    if (!name.endsWith(SUFFIX) || name.length === SUFFIX.length) return null;
    const ref = name.slice(0, -SUFFIX.length);
    return validRef(ref) ? ref : null;
}

function createArchive({ config, git }) {
    /** A ref to its commit, and whether the answer never changes (a full id or a tag). */
    async function resolve(owner, name, ref) {
        const sha = await git.resolveCommit(owner, name, ref);
        if (!sha) return null;
        const lower = ref.toLowerCase();
        const isFullId = FULL_SHA_RE.test(lower) && lower === sha.slice(0, lower.length) && lower.length >= 40;
        let isTag = false;
        if (!isFullId) {
            const tagged = await git.resolveCommit(owner, name, `refs/tags/${ref}`);
            isTag = Boolean(tagged) && tagged === sha;
        }
        return { sha, immutable: isFullId || isTag };
    }

    /** Stream git archive to the response. Headers (ETag, caching) are the caller's. */
    function stream(res, owner, name, sha, { prefix, maxBytes, timeoutMs, log } = {}) {
        const dir = git.repoDir(owner, name);
        const cap = Math.max(1024, Number(maxBytes) || config.data.maxArchiveBytes);
        const child = spawnGit(['archive', '--format=tar.gz', `--prefix=${prefix}`, sha], { cwd: dir, timeoutMs: timeoutMs || 120_000 });
        let sent = 0;
        let failed = false;
        const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
        res.on('close', kill);
        child.on('error', (err) => {
            failed = true;
            res.removeListener('close', kill);
            if (!res.headersSent) {
                res.status(500).type('text/plain').send('The archive could not be made.');
            } else {
                try { res.destroy(); } catch { /* gone */ }
            }
            (log || console).warn(`[OpenVibe.Git] archive ${owner}/${name}: ${String(err.message || err).slice(0, 200)}`);
        });
        child.stdout.on('data', (chunk) => {
            sent += chunk.length;
            if (sent > cap) {
                failed = true;
                kill();
                if (!res.headersSent) {
                    res.status(413).type('text/plain').send('The archive is larger than this service serves.');
                } else {
                    try { res.destroy(); } catch { /* gone */ }
                }
                return;
            }
            if (!res.write(chunk)) child.stdout.pause();
        });
        res.on('drain', () => child.stdout.resume());
        child.on('close', (code) => {
            res.removeListener('close', kill);
            if (failed) return;
            if (code !== 0) {
                if (!res.headersSent) res.status(500).type('text/plain').send('The archive could not be made.');
                else { try { res.destroy(); } catch { /* gone */ } }
                return;
            }
            res.end();
        });
        return child;
    }

    return { resolve, stream };
}

/**
 * Answer one archive request on either surface. fail(status, message) renders the surface's own error;
 * visibility was already checked by the caller, like the raw file.
 */
async function serveArchive(archive, req, res, row, file, { log, fail }) {
    const ref = refOfArchive(file);
    if (!ref) { fail(404, 'No such archive.'); return; }
    const resolved = await archive.resolve(row.owner_username, row.name, ref);
    if (!resolved) { fail(404, 'No such ref.'); return; }
    const etag = `"${resolved.sha}-tar.gz"`;
    if (req.get('if-none-match') === etag) { res.status(304).end(); return; }
    const safe = ref.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);
    res.set('Content-Type', 'application/gzip');
    res.set('Content-Disposition', `attachment; filename="${row.name}-${safe}.tar.gz"`);
    res.set('ETag', etag);
    res.set('Cache-Control', resolved.immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
    archive.stream(res, row.owner_username, row.name, resolved.sha, { prefix: `${row.name}-${resolved.sha}/`, log });
}

module.exports = { createArchive, refOfArchive, serveArchive, SUFFIX };
