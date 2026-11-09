'use strict';

/**
 * Git over HTTPS, the wire half: git's own `git http-backend` behind our identity.
 *
 *   GET  /<owner>/<name>.git/info/refs?service=git-upload-pack     the ref advertisement a clone asks for
 *   POST /<owner>/<name>.git/git-upload-pack                       the pack a clone receives
 *   GET  /<owner>/<name>.git/info/refs?service=git-receive-pack    the advertisement a push asks for
 *   POST /<owner>/<name>.git/git-receive-pack                      the pack a push sends
 *
 * The backend runs with GIT_PROJECT_ROOT at the repositories directory and a PATH_INFO built from names this
 * service already validated. Its environment is fixed (server/git/run.js): no GIT_DIR, no hooks but ours, fsck
 * on push, the receiver's size cap. A request body is capped before it is read; a push is recorded and, if the
 * repository has a push mirror, sent on after the client has its answer.
 */
const { runGit, configEnv } = require('./run');
const { validOwner, validName } = require('./refs');
const { REPOS_DIR, HOOKS_DIR } = require('../paths');

const ROUTE = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/;
const ALLOWED_SUFFIX = /^(info\/refs|git-upload-pack|git-receive-pack)$/;

function parseGitPath(pathname) {
    const m = ROUTE.exec(pathname);
    if (!m) return null;
    const [, owner, rawName, rest = ''] = m;
    const name = rawName;
    if (!validOwner(owner) || !validName(name)) return null;
    if (!ALLOWED_SUFFIX.test(rest)) return null;
    return { owner, name, suffix: rest };
}

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) { reject(Object.assign(new Error('push larger than the cap'), { status: 413 })); req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function cgiHeaders(text) {
    const at = text.indexOf('\r\n\r\n');
    const sep = at >= 0 ? 4 : 2;
    const idx = at >= 0 ? at : text.indexOf('\n\n');
    if (idx < 0) return null;
    const head = text.slice(0, idx).split(/\r?\n/);
    const headers = {};
    let status = 200;
    for (const line of head) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        if (k === 'status') status = parseInt(v, 10) || 200;
        else headers[k] = v;
    }
    return { status, headers, bodyAt: idx + sep };
}

function createSmartHttp({ config, repos, mirrors, insights, log = console }) {
    const mayRead = (row, identity) => {
        if (row.visibility === 'public') return true;
        if (!identity) return false;
        if (identity.subject === row.owner_subject) return true;
        return identity.actor_type === 'service' && row.official && identity.scopes.has('git.repo.read');
    };
    const mayWrite = (row, identity) => {
        if (!identity || !identity.scopes.has('git.repo.write')) return false;
        if (identity.subject === row.owner_subject) return true;
        return identity.actor_type === 'service' && row.official;
    };

    /** Run the backend; resolves once the response is written. */
    async function run(req, res, { row, suffix, identity }) {
        const service = String(new URL(req.url, 'http://x').searchParams.get('service') || '');
        const write = suffix === 'git-receive-pack' || (suffix === 'info/refs' && service === 'git-receive-pack');
        if (write ? !mayWrite(row, identity) : !mayRead(row, identity)) {
            // Git retries with the URL's token only after a 401, so a private read asks for one. The API and the
            // pages answer 404 instead and never reveal that a private repository exists.
            if (!identity) res.set('WWW-Authenticate', 'Basic realm="OpenVibe.Git"');
            res.status(identity ? 403 : 401).type('text/plain').send(write ? 'This token may not push here.' : 'This repository is private.');
            return;
        }
        if (suffix === 'info/refs' && service && !['git-upload-pack', 'git-receive-pack'].includes(service)) {
            res.status(400).type('text/plain').send('Unknown service.');
            return;
        }
        const body = req.method === 'POST' ? await readBody(req, config.data.maxPushBytes) : Buffer.alloc(0);
        const pathInfo = `/${row.owner_username}/${row.name}.git/${suffix}`;
        const url = new URL(req.url, 'http://x');
        const env = {
            ...configEnv({
                'receive.fsckObjects': 'true',
                'transfer.fsckObjects': 'true',
                'core.hooksPath': HOOKS_DIR,
                'receive.maxInputSize': String(config.data.maxPushBytes),
            }),
            GIT_PROJECT_ROOT: REPOS_DIR,
            GIT_HTTP_EXPORT_ALL: '1',
            PATH_INFO: pathInfo,
            REQUEST_METHOD: req.method,
            QUERY_STRING: url.search ? url.search.slice(1) : '',
            CONTENT_TYPE: req.headers['content-type'] || '',
            CONTENT_LENGTH: String(body.length),
            REMOTE_USER: identity ? identity.subject : '',
            REMOTE_ADDR: req.ip || '',
            GIT_PROTOCOL: req.headers['git-protocol'] || '',
        };
        let result;
        try {
            result = await runGit(['http-backend'], {
                env,
                input: body,
                maxBuffer: Math.min(config.data.maxPushBytes + 64 * 1024 * 1024, 1024 * 1024 * 1024),
                timeoutMs: 10 * 60_000,
            });
        } catch (err) {
            log.warn(`[OpenVibe.Git] http-backend ${row.owner_username}/${row.name}: ${String(err.message).slice(0, 200)}`);
            if (!res.headersSent) res.status(500).type('text/plain').send('The git server could not answer.');
            return;
        }
        const parsed = cgiHeaders(result.stdout.toString('latin1'));
        if (!parsed) {
            res.status(502).type('text/plain').send('The git server answered something unexpected.');
            return;
        }
        // The body after the CGI header block is bytes: take it from the original buffer.
        const offset = findHeaderEnd(result.stdout);
        const outBody = offset < 0 ? Buffer.alloc(0) : result.stdout.subarray(offset);
        res.status(parsed.status);
        for (const [k, v] of Object.entries(parsed.headers)) {
            if (['connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(k)) continue;
            res.set(k, v);
        }
        res.set('Cache-Control', 'no-cache, max-age=0, must-revalidate');
        res.set('X-Content-Type-Options', 'nosniff');
        res.end(outBody);
        if (write && req.method === 'POST') {
            // The client has its answer; the push is recorded and its push mirror (if any) follows.
            await repos.recordEvent(row, 'push', identity || { subject: null, username: null }, { service });
            await repos.audit(identity, 'git.push', row, {}, req.ip || null);
            await mirrors.afterPush(row);
        } else if (suffix === 'info/refs' && service === 'git-upload-pack' && req.method === 'GET') {
            // A clone or fetch begins here; count it once, not again on the pack that follows.
            if (insights) await insights.recordClone(row, { address: req.ip || '', subject: identity ? identity.subject : null });
        }
    }

    return { run, mayRead, mayWrite, parseGitPath };
}

/** Byte offset of the end of the CGI header block (after the blank line). */
function findHeaderEnd(buf) {
    const crlf = buf.indexOf('\r\n\r\n');
    if (crlf >= 0) return crlf + 4;
    const lf = buf.indexOf('\n\n');
    return lf >= 0 ? lf + 2 : -1;
}

module.exports = { createSmartHttp, parseGitPath, cgiHeaders, findHeaderEnd, ROUTE };
