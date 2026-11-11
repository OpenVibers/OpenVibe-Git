'use strict';

/**
 * Make the runner's token, or print the hash of the one it already has.
 *
 *   node runner/token.js --out ~/.config/openvibe/git-ci.token
 *       creates a random token, writes it with mode 0600 and prints the scrypt line for
 *       deploy/ci/runner-token (the service never sees the token itself).
 *
 *   node runner/token.js --from ~/.config/openvibe/git-ci.token
 *       prints the scrypt line for an existing token (rotation: write the same line to the repo).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashToken } = require('../server/ci-auth');

function main(argv) {
    const arg = (name, fallback = null) => {
        const i = argv.indexOf(name);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
    };
    const from = arg('--from');
    let token;
    let out = arg('--out');
    if (from) {
        token = fs.readFileSync(String(from).replace(/^~(?=$|\/)/, os.homedir()), 'utf8').trim();
    } else {
        token = crypto.randomBytes(32).toString('base64url');
        out = String(out || path.join(os.homedir(), '.config', 'openvibe', 'git-ci.token')).replace(/^~(?=$|\/)/, os.homedir());
        fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
        fs.writeFileSync(out, `${token}\n`, { mode: 0o600 });
        process.stdout.write(`token written to ${out} (0600)\n`);
    }
    if (!token || token.length < 16) throw new Error('the token is empty or too short');
    process.stdout.write(`${hashToken(token)}\n`);
}

if (require.main === module) {
    try { main(process.argv.slice(2)); } catch (err) { process.stderr.write(`${err.message}\n`); process.exit(1); }
}

module.exports = { main };
