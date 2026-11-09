'use strict';

/** Who is asking: the session (a person) or a token presented to the API (a person or a service). */
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

async function callerOf(req, { store, config }) {
    const viewer = viewerOf(req);
    if (viewer) return { subject: viewer.subject, username: viewer.username, actor_type: 'user', scopes: new Set(['git.read', 'git.write']), via: 'session' };
    const identity = await require('../auth/git-auth').identify(req, { store, config });
    if (!identity) return null;
    return { ...identity, username: null };
}

const isAdmin = (viewer) => Boolean(viewer && viewer.role === 'admin');

module.exports = { viewerOf, callerOf, isAdmin };
