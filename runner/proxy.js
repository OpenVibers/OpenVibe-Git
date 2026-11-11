'use strict';

/**
 * The install-phase egress proxy: an HTTP CONNECT proxy on a Unix socket, bound into the sandbox for the one
 * phase that may install dependencies. It answers only the hosts the runner names (npm's registry and GitHub's
 * codeload for the pinned tarballs), resolves them itself and refuses every non-public address. The test phase
 * gets no proxy and no network at all.
 *
 * It is a plain TCP relay after the CONNECT answer: it never reads TLS, keeps no request bodies and logs only
 * the host it refused.
 */
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns').promises;

const PRIVATE_V4 = [
    [/^0\./, 'this network'], [/^10\./, 'private'], [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, 'carrier NAT'],
    [/^127\./, 'loopback'], [/^169\.254\./, 'link local'], [/^172\.(1[6-9]|2\d|3[01])\./, 'private'],
    [/^192\.0\.0\./, 'IETF'], [/^192\.0\.2\./, 'documentation'], [/^192\.168\./, 'private'],
    [/^198\.(1[89]|51\.100)\./, 'benchmark/documentation'], [/^203\.0\.113\./, 'documentation'],
    [/^22[4-9]\./, 'multicast'], [/^2[3-5]\d\./, 'multicast'], [/^255\./, 'broadcast'],
];

function isPublicAddress(address) {
    const value = String(address || '').toLowerCase();
    if (net.isIPv4(value)) return !PRIVATE_V4.some(([re]) => re.test(value));
    if (net.isIPv6(value)) {
        if (value === '::' || value === '::1') return false;
        if (/^f[cd]/.test(value) || /^fe[89ab]/.test(value) || /^ff/.test(value)) return false;
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
        if (mapped) return isPublicAddress(mapped[1]);
        return true;
    }
    return false;
}

async function resolvePublic(host) {
    if (!host || net.isIP(host)) throw new Error('an IP literal is not allowed');
    const answers = await dns.lookup(host, { all: true, verbatim: true });
    if (!answers.length) throw new Error('no address');
    for (const answer of answers) {
        if (!isPublicAddress(answer.address)) throw new Error(`resolves to a non-public address (${answer.address})`);
    }
    return answers[0];
}

function createProxy({ allow = ['registry.npmjs.org', 'codeload.github.com'], log = console } = {}) {
    const allowed = new Set(allow.map((h) => String(h).toLowerCase()));
    const sockets = new Set();
    let server = null;

    const permit = (host) => allowed.has(String(host || '').toLowerCase());
    const track = (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => { try { socket.destroy(); } catch { /* gone */ } });
        return socket;
    };
    const deny = (client, code, text) => {
        try { client.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
    };

    async function target(host, port) {
        if (!permit(host)) throw Object.assign(new Error('host not on the allowlist'), { code: 403, reason: 'not allowed' });
        if (![80, 443].includes(Number(port))) throw Object.assign(new Error('port'), { code: 403, reason: 'port not allowed' });
        const answer = await resolvePublic(host);
        return { host, port: Number(port), address: answer.address, family: answer.family };
    }

    function onConnect(req, client, head) {
        const [host, portText] = String(req.url || '').split(':');
        const port = parseInt(portText, 10) || 443;
        target(host, port).then((t) => {
            const upstream = track(net.connect({ host: t.address, port: t.port, family: t.family }));
            upstream.once('connect', () => {
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head && head.length) upstream.write(head);
                client.pipe(upstream);
                upstream.pipe(client);
            });
            upstream.once('error', (err) => {
                log.warn(`[git-ci-proxy] ${t.host}: ${err.code || err.message}`);
                try { client.destroy(); } catch { /* gone */ }
            });
            client.on('error', () => { try { upstream.destroy(); } catch { /* gone */ } });
        }).catch((err) => {
            log.warn(`[git-ci-proxy] refused ${host}: ${err.reason || err.message}`);
            deny(client, 403, 'Forbidden');
        });
    }

    function onRequest(req, res) {
        let url;
        try { url = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
        if (url.protocol !== 'http:') { res.writeHead(403); res.end(); return; }
        target(url.hostname, url.port || 80).then((t) => {
            const upstream = track(net.connect({ host: t.address, port: t.port, family: t.family }));
            upstream.once('connect', () => {
                const path = `${url.pathname}${url.search}`;
                upstream.write(`${req.method} ${path} HTTP/1.1\r\n`);
                for (const [k, v] of Object.entries(req.headers)) {
                    if (['proxy-connection', 'proxy-authorization'].includes(k.toLowerCase())) continue;
                    upstream.write(`${k}: ${v}\r\n`);
                }
                upstream.write('\r\n');
                req.pipe(upstream);
                upstream.pipe(res);
            });
            upstream.once('error', () => { try { res.writeHead(502); res.end(); } catch { /* gone */ } });
        }).catch((err) => {
            log.warn(`[git-ci-proxy] refused ${url.hostname}: ${err.reason || err.message}`);
            res.writeHead(403); res.end();
        });
    }

    async function listen(socketPath) {
        fs.rmSync(socketPath, { force: true });
        server = http.createServer(onRequest);
        server.on('connect', onConnect);
        server.keepAliveTimeout = 5000;
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => { try { fs.chmodSync(socketPath, 0o600); } catch { /* best effort */ } resolve(); });
        });
        return socketPath;
    }

    async function close() {
        for (const socket of sockets) { try { socket.destroy(); } catch { /* gone */ } }
        sockets.clear();
        if (!server) return;
        await new Promise((resolve) => server.close(resolve));
        server = null;
    }

    return { listen, close, permit, target, allowed };
}

module.exports = { createProxy, isPublicAddress, resolvePublic };
