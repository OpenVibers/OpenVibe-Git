'use strict';
// An asset's ?v= follows its file: a static-only deploy swaps public/ under a running process, and the page must point
// at the new file at once (11-12: a hash kept for the life of the process left the fixed radios unseen).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { assetVersion, asset } = require('../server/render/layout');
const rel = `css/__asset-version-${process.pid}.css`;
const file = path.join(__dirname, '..', 'public', rel);
try {
    fs.writeFileSync(file, '.a{color:red}');
    const first = assetVersion(rel);
    assert.match(first, /^[0-9a-f]{10}$/);
    assert.strictEqual(assetVersion(rel), first, 'unchanged file, same version');
    fs.writeFileSync(file, '.a{color:blue}');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    const second = assetVersion(rel);
    assert.notStrictEqual(second, first, 'a changed file gets a new version without a restart');
    assert.strictEqual(asset(rel), `/${rel}?v=${second}`);
    fs.rmSync(file);
    assert.strictEqual(assetVersion(rel), 'dev', 'a missing file is dev, not its old hash');
    console.log('asset version: follows the file, no restart needed');
} finally { fs.rmSync(file, { force: true }); }
