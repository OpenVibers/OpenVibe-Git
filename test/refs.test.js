'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { validRef, validPath, validOwner, validName, validRepo } = require('../server/git/refs');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n += 1; };
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/.\u0000\n\t ~^:?*[\\@{';

// A valid ref keeps every invariant the git call depends on.
for (let i = 0; i < 20000; i += 1) {
    const len = 1 + (i % 24);
    let s = '';
    for (let j = 0; j < len; j += 1) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!validRef(s)) continue;
    ok(!s.startsWith('-'), 'no leading dash');
    ok(!s.includes('..'), 'no ..');
    ok(!s.includes('\\'), 'no backslash');
    ok(!s.endsWith('/') && !s.endsWith('.'), 'no trailing slash or dot');
    ok(!/[\u0000-\u0020\u007f~^:?*\[\]]/.test(s), 'no control or ref punctuation');
    ok(s.split('/').every((p) => p && !p.startsWith('.') && !p.endsWith('.lock')), 'every component is safe');
}

// The shapes that must never arrive at git.
for (const bad of ['', '-x', '../../etc/passwd', 'a..b', 'a\\b', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a]b', 'a@{b', '/a', 'a/', '.a', 'a/.b', 'a.lock', 'a/.lock', 'a//b', '@']) {
    ok(!validRef(bad), `ref refused: ${JSON.stringify(bad)}`);
}
for (const good of ['main', 'release/1.0', 'feat/thing-2', 'v1.2.3', 'a_b.c']) ok(validRef(good), `ref accepted: ${good}`);

// Paths are relative and never climb.
for (let i = 0; i < 20000; i += 1) {
    const len = 1 + (i % 20);
    let s = '';
    for (let j = 0; j < len; j += 1) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!validPath(s)) continue;
    ok(!s.startsWith('/') && !s.startsWith('-'), 'relative');
    ok(!s.includes('\\'), 'no backslash');
    ok(!s.split('/').some((p) => p === '..' || p === '.' || !p), 'no traversal or empty segment');
    ok(!s.split('/').some((p) => p.toLowerCase() === '.git'), 'never enters .git');
}
for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'a\\b', 'a//b', 'a/./b', '.git/config', 'a/.git/x', 'a\u0000b', '-flag']) ok(!validPath(bad), `path refused: ${JSON.stringify(bad)}`);
for (const good of ['', 'README.md', 'server/git/store.js', 'a.b/c-d_e']) ok(validPath(good), `path accepted: ${good}`);

ok(validOwner('openvibers') && !validOwner('../x') && !validOwner('-x'), 'owners');
ok(validName('openvibe.codes') && !validName('x.git') && !validName('../x'), 'names never end .git');
ok(validRepo('openvibers/openvibe.codes') && !validRepo('openvibers/x.git'), 'repo names');

console.log(`refs: ${n} checks passed`);
