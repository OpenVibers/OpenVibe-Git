'use strict';
const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n += 1; };

// ── No shell, anywhere ─────────────────────────────────────
const serverDir = path.join(__dirname, '..', 'server');
const files = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
    }
})(serverDir);
for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    ok(!/shell\s*:\s*true/.test(src), `${path.relative(serverDir, file)}: no shell:true`);
    ok(!/\bexecSync\b|\bexecFileSync\b|\bexecFile\b|(^|[^.\w])exec\s*\(/m.test(src), `${path.relative(serverDir, file)}: no exec*`);
    ok(!/\bspawnSync\b/.test(src), `${path.relative(serverDir, file)}: no spawnSync`);
    ok(!/child_process/.test(src) || /spawn/.test(src), `${path.relative(serverDir, file)}: child_process only for spawn`);
}

// ── Every real git call is an argument array with a command ─
const cp = require('node:child_process');
const originalSpawn = cp.spawn;
const calls = [];
cp.spawn = function patched(command, args, options) {
    calls.push({ command, args, options });
    return originalSpawn.call(this, command, args, options);
};
const { runGit } = require('../server/git/run');
const os = require('node:os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openvibe-git-noshell-'));

(async () => {
    await runGit(['init', '--bare', path.join(tmp, 'r.git')]);
    await runGit(['--version']);
    ok(calls.length >= 2, 'git ran');
    for (const call of calls) {
        ok(call.command === 'git', 'the command is git');
        ok(Array.isArray(call.args), 'arguments are an array');
        ok(call.options && call.options.shell === false, 'shell is off');
        ok(call.args.every((a) => typeof a === 'string'), 'every argument is a string');
        ok(call.args[0] !== '-c' || typeof call.args[1] === 'string', 'no free-form -c from a request');
    }

    // A hostile "argument" stays one argument.
    const hostile = '--upload-pack=$(touch /tmp/owned)';
    await runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', hostile], { cwd: path.join(tmp, 'r.git'), allowFailure: true });
    const last = calls[calls.length - 1];
    ok(last.args.includes(hostile), 'the hostile string is one argument');
    ok(!fs.existsSync('/tmp/owned'), 'nothing executed it');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`no-shell: ${n} checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
