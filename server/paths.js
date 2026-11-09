'use strict';

/**
 * Where OpenVibe.Git keeps what is its own: the bare git repositories and the empty hooks directory
 * (a repository never runs a user's hook; core.hooksPath points here). GIT_DATA_DIR (or DATA_DIR) moves
 * it; production uses /var/lib/openvibe/git, which the host's backups cover.
 */
const path = require('path');

const DATA_DIR = path.resolve(process.env.GIT_DATA_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const REPOS_DIR = path.join(DATA_DIR, 'repos');
const HOOKS_DIR = path.join(DATA_DIR, 'no-hooks');
const TMP_DIR = path.join(DATA_DIR, 'tmp');

module.exports = { DATA_DIR, REPOS_DIR, HOOKS_DIR, TMP_DIR };
