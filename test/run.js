#!/usr/bin/env node
/**
 * Runs every test/*.test.js in its own process. They use a temp PGlite database, a temp git data directory and an
 * in-process mock of OpenVibe.Network with a real RS256 key pair; none needs the network (mirror fetches are the
 * one thing faked at the guard).
 *
 *   npm test                 # everything
 *   npm test -- refs         # only files whose name contains one of the words
 */
'use strict';
const { run } = require('openvibe-shared/test-runner');

run({ dir: __dirname, timeoutMs: 120000, pad: 34, parallel: 1 }).then((r) => {
    if (process.env.VERBOSE) {
        for (const t of r.results) console.log(`\n── ${t.file} ──\n${t.output.trimEnd()}`);
        console.log(`\n${r.summary}`);
    }
    process.exit(r.exitCode);
}, (err) => { console.error(err); process.exit(1); });
