'use strict';
// The new-repository form's choices (who can see it, how it starts) on a phone: each a row with a small dot, never the
// text field's 44 px padded box blown up into a circle above its name (the owner's phone, 2026-11-12).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'git.css'), 'utf8');
const fieldRule = css.split('\n').find((l) => l.startsWith('.git-search select,'));
assert.ok(fieldRule, 'the field box rule exists');
assert.ok(!/\.git-form input[ ,{]/.test(fieldRule) && !/\.git-field input[ ,{]/.test(fieldRule), 'the field box skips radios and checkboxes');
assert.match(fieldRule, /\.git-form input:not\(\[type=radio\]\):not\(\[type=checkbox\]\)/);
assert.match(css, /\.git-form \.git-radio, \.git-radio \{ display: flex;/, 'a choice is one row, also inside the form (its label grid does not win)');
const dot = css.split('\n').find((l) => l.startsWith('.git-form .git-radio input, .git-radio input {'));
assert.ok(dot && /width: 20px; height: 20px; min-height: 0;/.test(dot) && /padding: 0;/.test(dot) && /flex: none;/.test(dot), 'the dot is 20 px, unpadded, and does not stretch');
console.log('form choices: a row with a small dot, the field box left to text fields');
