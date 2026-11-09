'use strict';

/**
 * Who is asking: the session (a person), a token presented to the API (a person or a service), or a service
 * acting for a person.
 *
 * A service holds a typed Network token for this audience. It names the person it is working for in
 * X-OV-Subject (usr_…), the same header the other services use; the service is trusted with git.repo.read or
 * git.repo.write, so the person it names is who the call is for. A service that names nobody acts only where a
 * service may (official repositories, public reads).
 */
const USER_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function viewerOf(req) {
    if (!req.user) return null;
    return {
        kind: 'user',
        subject: req.user.subject_id || req.user.sub,
        username: req.user.username || null,
        displayName: req.user.display_name || req.user.username || null,
        role: req.user.role || 'user',
    };
}

/** The person a service token acts for: X-OV-Subject, when it is a usr_ subject. */
function namedSubject(req) {
    const raw = req.get ? req.get('x-ov-subject') : (req.headers && req.headers['x-ov-subject']);
    const value = String(raw || '').trim();
    return USER_RE.test(value) ? value : null;
}

async function callerOf(req, { store, config }) {
    const viewer = viewerOf(req);
    if (viewer) return { subject: viewer.subject, username: viewer.username, actor_type: 'user', scopes: new Set(['git.repo.read', 'git.repo.write']), via: 'session' };
    const identity = await require('../auth/git-auth').identify(req, { store, config });
    if (!identity) return null;
    if (identity.actor_type === 'service') {
        return { ...identity, username: null, on_behalf_of: namedSubject(req) };
    }
    return { ...identity, username: null };
}

/** The person a caller's view is theirs: the caller, or the person a service acts for. */
function viewerFrom(caller) {
    if (!caller) return null;
    const subject = caller.on_behalf_of || (caller.actor_type === 'user' ? caller.subject : null);
    if (!subject) return null;
    return { kind: 'user', subject, username: caller.username || null, displayName: caller.username || null, role: 'user' };
}

const isAdmin = (viewer) => Boolean(viewer && viewer.role === 'admin');

module.exports = { viewerOf, callerOf, viewerFrom, namedSubject, isAdmin };
