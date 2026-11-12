'use strict';

/**
 * The page shell. Every page is server-rendered through openvibe-shared/shell and works without JavaScript; the
 * shared navbar, footer and kit are the same ones every OpenVibe site wears. Git is developer tooling under
 * openvibe.codes, so it borrows the "make" room's accent and names itself Git.OpenVibe.Codes in the navbar.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const appIcon = require('openvibe-shared/app-icon');
const shell = require('openvibe-shared/shell');
const rooms = require('openvibe-shared/rooms');
const ovServe = require('openvibe-shared/serve');
const cache = require('openvibe-shared/cache-policy');
const { esc } = require('./html');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe Git';
const TAGLINE = 'Git for OpenVibe: host code with your OpenVibe account, clone it with Link, code on it in Codes.';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const NAV = [
    { label: 'Repositories', href: '/', icon: 'fa-code' },
    { label: 'Explore', href: '/explore', icon: 'fa-magnifying-glass' },
    { label: 'New', href: '/new', icon: 'fa-plus' },
    { label: 'Codes', href: 'https://openvibe.codes', icon: 'fa-terminal' },
];
const API_BASE = 'https://git.openvibe.codes';

// An asset's version is its content hash, kept until the file changes: a static-only deploy (public/ is a no-restart
// path) swaps the file under a running process, and a hash kept for good sent pages on to the old file for as long as
// the process lived (11-12: the new-repository form's fixed radios stayed broken after their deploy).
const hashes = new Map();
function assetVersion(rel) {
    const file = path.join(PUBLIC_DIR, rel);
    let stamp = null;
    try { const st = fs.statSync(file); stamp = `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { /* missing asset */ }
    const kept = hashes.get(rel);
    if (kept && kept.stamp === stamp) return kept.v;
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10); } catch { /* missing asset */ }
    hashes.set(rel, { stamp, v });
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

/**
 * o: title, description, body, viewer, config, path, active, index, robots, canonical, jsonLd
 */
function layout(o) {
    const config = o.config || { baseUrl: API_BASE };
    const signedIn = o.viewer && o.viewer.kind === 'user';
    const pathNow = o.path || '/';
    const active = o.active || pathNow;
    const canonical = o.canonical === undefined ? `${String(config.baseUrl).replace(/\/+$/, '')}${pathNow.split('?')[0]}` : o.canonical;
    const navbar = {
        service: 'git',
        brand: { sub: 'git', tld: 'codes' },
        apiBase: NETWORK_URL,
        links: NAV.map((l) => ({ ...l, active: l.href === active || (l.href !== '/' && pathNow.startsWith(`${l.href}/`)) })),
        appBar: [
            { label: 'Repositories', href: '/', icon: 'fa-code' },
            { label: 'Explore', href: '/explore', icon: 'fa-magnifying-glass' },
            { label: 'New', href: '/new', icon: 'fa-plus' },
        ],
        silentLogin: `${String(config.baseUrl).replace(/\/+$/, '')}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',
        logoutUrl: '/auth/logout?next={path}',
        notificationsRealtime: true,
        history: { type: 'page', title: o.title || SITE_NAME },
    };
    const footer = { service: 'git', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME };
    return shell.page({
        name: SITE_NAME,
        lang: 'en',
        title: o.title || `${SITE_NAME}: ${TAGLINE}`,
        titleSuffix: o.title ? ` · ${SITE_NAME}` : '',
        siteName: SITE_NAME,
        description: o.description || `${SITE_NAME}: host code with your OpenVibe account, browse it, mirror GitHub, and clone it.`,
        canonical,
        robots: o.robots || (o.index ? 'index, follow' : 'noindex, follow'),
        jsonLd: (o.jsonLd || []).filter(Boolean),
        home: '/',
        navLinks: NAV,
        navbar,
        footer,
        head: `${appIcon.headTags({})}
<link rel="stylesheet" href="${esc(ovServe.url('kit.css'))}">
<link rel="stylesheet" href="${esc(ovServe.url('room.css'))}">
<link rel="stylesheet" href="${esc(asset('css/git.css'))}">
<script src="${esc(asset('js/git.js'))}" defer></script>
<script src="${esc(ovServe.url('kit-web.js'))}" defer></script>
<meta name="ov-boost" content="git@${esc(RELEASE)}">`,
        body: `<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
<noscript><div class="account-bar" role="navigation" aria-label="Account">${signedIn
    ? `Signed in as <strong>${esc(o.viewer.displayName || o.viewer.username || 'you')}</strong>`
    : '<a href="/auth/login">Sign in with OpenVibe</a>'}</div></noscript>
<main id="main" class="git ov-room" style="${rooms.style('website')}">${o.body}</main>
<script>window.__OV_PAGE = ${JSON.stringify({ navbar, footer }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () { try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* the Frame is optional */ } });</script>`,
    });
}

function send(res, status, o) {
    const personal = o.viewer && o.viewer.kind === 'user';
    if (!res.get('Cache-Control')) res.set('Cache-Control', personal ? cache.htmlHeaders({ private: true }) : (o.cache || cache.htmlHeaders({ public: true, maxAge: 60 })));
    res.set('Vary', 'Cookie');
    res.status(status).type('html').send(layout(o));
}

module.exports = { layout, send, asset, assetVersion, setRelease, SITE_NAME, TAGLINE, NETWORK_URL, NAV, API_BASE };
