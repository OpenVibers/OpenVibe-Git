'use strict';
/**
 * An in-process stand-in for OpenVibe.Network with a real RS256 key pair.
 *
 *   JWKS at /api/.well-known/jwks; a person token (verified as a session) and a typed git token
 *   (aud openvibe.git, typ git, cap git.read/git.write). Nothing else: Git's pages sign in through the
 *   real SSO client, whose callback is not exercised here.
 */
const http = require('http');
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');

function listen(handler) {
    return new Promise((resolve) => {
        const sockets = new Set();
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks);
                const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
                Promise.resolve(handler(req, raw, json, res)).catch((err) => json(500, { error: String(err && err.message) }));
            });
        });
        server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }) }));
    });
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signJwt(claims, privateKey) {
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

async function startNetwork() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    let issuer = null;
    const st = { requests: [] };
    const server = await listen(async (req, _raw, json) => {
        st.requests.push({ method: req.method, path: new URL(req.url, 'http://x').pathname });
        if (new URL(req.url, 'http://x').pathname === '/api/.well-known/jwks') return json(200, { public_key: publicPem, algorithm: 'RS256' });
        return json(404, { error: 'not found' });
    });
    issuer = server.url;
    function userToken({ subject, username, role = 'user', ttl = 3600 } = {}) {
        const now = Math.floor(Date.now() / 1000);
        return signJwt({ iss: issuer, sub: `id_${crypto.randomBytes(6).toString('hex')}`, subject_id: subject, username, display_name: username, role, aud: ['openvibe.network'], iat: now, exp: now + ttl }, privateKey);
    }
    function gitToken({ subject, caps = ['git.read', 'git.write'], ttl = 3600, type = 'git' } = {}) {
        const now = Math.floor(Date.now() / 1000);
        // type null: a service principal's client-credentials token, which carries no typ/purpose.
        return signJwt({ iss: issuer, sub: subject, actor_type: /^svc:/.test(subject) ? 'service' : 'user', aud: ['openvibe.git'], cap: caps, ...(type == null ? {} : { typ: type, purpose: type }), iat: now, exp: now + ttl, jti: `rtk_${crypto.randomBytes(8).toString('hex')}` }, privateKey);
    }
    return { ...server, issuer, userToken, gitToken, requests: st.requests, _privateKey: privateKey };
}

const newSubject = () => ids.newId('user');

module.exports = { startNetwork, signJwt, newSubject };
