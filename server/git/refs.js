'use strict';

/**
 * The names a request may reach: repository owner/name, refs and paths. Validation happens before any git
 * call, and git checks the ref again itself (`git check-ref-format`), because two opinions are how a ref
 * stays a ref. The rules are git's own with the extra refusals this service needs:
 *
 *   - no leading '-' (an argument, not a name);
 *   - no '..' anywhere (a ref is not a path walk);
 *   - no control characters, backslashes or NUL;
 *   - a path is relative, has no empty/'.'/'..' segment and never enters a '.git';
 *   - a repository name never ends in '.git' (the clone suffix is not part of the name).
 */
const { runGit } = require('./run');

const OWNER_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const NAME_RE = /^(?!.*\.git$)[a-z0-9][a-z0-9._-]{0,99}$/;
const REPO_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}\/(?!.*\.git$)[a-z0-9][a-z0-9._-]{0,99}$/;
const REF_LEN = 255;
const PATH_LEN = 4096;

const validOwner = (s) => typeof s === 'string' && OWNER_RE.test(s);
const validName = (s) => typeof s === 'string' && NAME_RE.test(s);
const validRepo = (s) => typeof s === 'string' && REPO_RE.test(s);

/** True when a ref (branch, tag or short name) is safe to hand to git as one argument. */
function validRef(ref) {
    if (typeof ref !== 'string' || !ref.length || ref.length > REF_LEN) return false;
    if (ref.startsWith('-') || ref.endsWith('/') || ref.endsWith('.') || ref === '@') return false;
    if (ref.includes('..') || ref.includes('//') || ref.includes('@{') || ref.includes('\\')) return false;
    // Control characters, space and git's ref punctuation are never part of a ref.
    if (/[\u0000-\u0020\u007f~^:?*\[\]]/.test(ref)) return false;
    for (const part of ref.split('/')) {
        if (!part || part.startsWith('.') || part.endsWith('.lock') || part.endsWith('.')) return false;
    }
    return true;
}

/** True when a path inside a repository is safe: relative, no traversal, no '.git', one argument. */
function validPath(p) {
    if (typeof p !== 'string' || p.length > PATH_LEN) return false;
    if (!p.length) return true;
    if (p.startsWith('/') || p.startsWith('-') || p.includes('\\')) return false;
    if (/[\u0000-\u001f\u007f]/.test(p)) return false;
    for (const part of p.split('/')) {
        if (!part || part === '.' || part === '..') return false;
        const lower = part.toLowerCase();
        if (lower === '.git' || lower.endsWith('.git')) return false;
    }
    return true;
}

/** git's own verdict for a ref (`refs/heads/<ref>`), for a name this service already accepted. */
async function checkRefWithGit(cwd, ref) {
    if (!validRef(ref)) return false;
    try {
        await runGit(['check-ref-format', `refs/heads/${ref}`], { cwd });
        return true;
    } catch { return false; }
}

/** A path's segments, or null. Never returns a path that climbs out. */
function pathSegments(p) {
    if (!validPath(p)) return null;
    return p ? p.split('/') : [];
}

/** Join a directory and a child name, refusing anything that leaves the directory. */
function joinInside(dir, name) {
    if (!validPath(name) || name.includes('/')) return null;
    return dir ? `${dir}/${name}` : name;
}

module.exports = { OWNER_RE, NAME_RE, REPO_RE, validOwner, validName, validRepo, validRef, validPath, checkRefWithGit, pathSegments, joinInside };
