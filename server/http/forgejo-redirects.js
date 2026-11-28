'use strict';
/**
 * Forgejo's old addresses, moved (11-28, openvibe.report/traffic: Meta's AI crawler asked git.openvibe.codes for 2,748
 * Forgejo-shaped addresses in a day, all 404, 1,294 of them /user/login). OpenVibe.Git replaced Forgejo on 2026-11-09 and
 * names a ref and a path in the query, so each old shape answers 301 to the same page here:
 *
 *   /user/login                                          → /auth/login
 *   /:o/:r/src/(branch|tag|commit)/:ref[/path]           → /:o/:r/blob?ref&path (a file) or /:o/:r/tree?ref&path
 *   /:o/:r/commits/(branch|tag|commit)/:ref[/path]       → /:o/:r/commits?ref&path
 *   /:o/:r/raw/(branch|tag|commit)/:ref/path             → /:o/:r/raw?ref&path
 *   /:o/:r/releases/tag/:tag                             → /:o/:r/releases
 *
 * A branch with a slash in its name cannot be told from its path here: the first part is taken as the ref, and a wrong
 * guess answers 404 on the new page, as it did before.
 */
const SHAPE = /^\/([^/]+)\/([^/]+)\/(src|commits|raw)\/(branch|tag|commit)\/([^/]+)(?:\/(.*))?$/;
const RELEASE = /^\/([^/]+)\/([^/]+)\/releases\/tag\/[^/]+\/?$/;
const FILE = /\.[A-Za-z0-9]{1,8}$/;

function forgejoRedirect(path) {
    const p = String(path || '');
    if (p === '/user/login' || p === '/user/sign_up') return '/auth/login';
    const r = RELEASE.exec(p);
    if (r) return `/${r[1]}/${r[2]}/releases`;
    const m = SHAPE.exec(p);
    if (!m) return null;
    const [, owner, name, kind, , ref, rest = ''] = m;
    const at = rest.replace(/\/+$/, '');
    const q = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const base = `/${owner}/${name}`;
    if (kind === 'commits') return `${base}/commits?${q({ ref, path: at })}`;
    if (kind === 'raw') return at ? `${base}/raw?${q({ ref, path: at })}` : `${base}/tree?${q({ ref })}`;
    return `${base}/${at && FILE.test(at) ? 'blob' : 'tree'}?${q({ ref, path: at })}`;
}

/** Express middleware: GET/HEAD of a Forgejo address answers 301 to its page here. */
function forgejoRedirects() {
    return (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const to = forgejoRedirect(req.path);
        if (!to) return next();
        res.set('Cache-Control', 'public, max-age=86400');
        return res.redirect(301, to);
    };
}

module.exports = { forgejoRedirect, forgejoRedirects };
