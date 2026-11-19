'use strict';
// The forge runner keeps installs between runs and runs several at once (2026-11-19: the owner asked for our own CI on
// the shared node, "optimized, efficient … making use of the RAM").
// - The cache key changes with anything that decides an install, and there is no key without a lockfile.
// - What an install made (node_modules folders and the files it changed outside them) is kept and comes back whole.
// - The store keeps to its size, least recently used first.
// - `auto` picks the install command from the lockfile, and a repository with no test script has nothing to run.
// - The download caches are mounted in the install phase only; Node's own fetch goes through the proxy.
// - The configuration allows up to 8 workers, and repositories default to `auto`.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDepsCache, cacheKey, survey, installed, autoCommands } = require('../runner/deps-cache');
const { bwrapArgs, podmanArgs, installScript } = require('../runner/sandbox');
const { loadConfig, registrations } = require('../runner/config');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-ci-deps-'));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

(async () => {
    try {
        // ── The key ──
        const a = path.join(tmp, 'a');
        write(path.join(a, 'package.json'), JSON.stringify({ name: 'a', scripts: { test: 'node t.js' } }));
        const base = { dir: a, repo: 'OpenVibers/A', install: 'npm ci', image: 'img', engine: 'bwrap' };
        assert.strictEqual(cacheKey(base), null, 'no lockfile, no key');
        write(path.join(a, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
        const k1 = cacheKey(base);
        assert.match(k1, /^[0-9a-f]{40}$/);
        assert.strictEqual(cacheKey(base), k1, 'the same inputs give the same key');
        assert.strictEqual(cacheKey({ ...base, repo: 'openvibers/a' }), k1, 'the repository name is case-insensitive');
        assert.notStrictEqual(cacheKey({ ...base, install: 'npm ci --omit=dev' }), k1, 'the install command is in the key');
        assert.notStrictEqual(cacheKey({ ...base, repo: 'openvibers/b' }), k1, 'each repository keeps its own');
        assert.notStrictEqual(cacheKey({ ...base, node: 'v99.0.0' }), k1, 'Node is in the key');
        write(path.join(a, 'package.json'), JSON.stringify({ name: 'a', scripts: { test: 'node other.js' } }));
        assert.strictEqual(cacheKey(base), k1, 'a changed test script does not change the install');
        write(path.join(a, 'package.json'), JSON.stringify({ name: 'a', scripts: { test: 'node t.js', postinstall: 'node build.js' } }));
        const k2 = cacheKey(base);
        assert.notStrictEqual(k2, k1, 'an install script is in the key');
        write(path.join(a, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"x":{}}}');
        assert.notStrictEqual(cacheKey(base), k2, 'the lockfile is in the key');

        // ── What an install made ──
        write(path.join(a, 'src', 'index.js'), 'module.exports = 1;\n');
        write(path.join(a, '.ci', 'etc', 'passwd'), 'runner file\n');
        const before = survey(a);
        write(path.join(a, 'node_modules', 'dep', 'index.js'), 'module.exports = "dep";\n');
        write(path.join(a, 'node_modules', 'dep', 'node_modules', 'inner', 'x.js'), '1\n');
        write(path.join(a, 'packages', 'p', 'node_modules', 'q', 'q.js'), 'q\n');
        write(path.join(a, 'dist', 'built.js'), 'built by prepare\n');
        write(path.join(a, '.home', '.npmrc'), 'runner home\n');
        const made = installed(before, survey(a));
        assert.deepStrictEqual(made.modules, ['node_modules', 'packages/p/node_modules'], 'top-level node_modules folders only');
        assert.deepStrictEqual(made.changed, ['dist/built.js'], 'the files the install wrote, never the runner\'s own');

        // ── Kept, and back in a fresh checkout ──
        const store = path.join(tmp, 'store');
        const cache = createDepsCache({ root: store, maxMb: 256 });
        const key = cacheKey(base);
        assert.strictEqual(await cache.restore(key, a), null, 'a miss before anything is kept');
        const kept = await cache.save(key, a, made);
        assert.ok(kept && kept.bytes > 0, 'kept with its size');
        assert.strictEqual(await cache.save(key, a, made), null, 'kept once');
        const b = path.join(tmp, 'b');
        write(path.join(b, 'src', 'index.js'), 'module.exports = 1;\n');
        const back = await cache.restore(key, b);
        assert.ok(back, 'a hit');
        assert.deepStrictEqual(back.modules, made.modules);
        assert.strictEqual(fs.readFileSync(path.join(b, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = "dep";\n');
        assert.ok(fs.existsSync(path.join(b, 'node_modules', 'dep', 'node_modules', 'inner', 'x.js')), 'nested dependencies come back');
        assert.ok(fs.existsSync(path.join(b, 'packages', 'p', 'node_modules', 'q', 'q.js')), 'a workspace\'s node_modules comes back');
        assert.strictEqual(fs.readFileSync(path.join(b, 'dist', 'built.js'), 'utf8'), 'built by prepare\n', 'what prepare built comes back');
        assert.ok(!fs.existsSync(path.join(b, '.home', '.npmrc')), 'the runner\'s own folders are not kept');
        // A run that changes its copy does not change what is kept.
        fs.writeFileSync(path.join(b, 'node_modules', 'dep', 'index.js'), 'tampered\n');
        const c = path.join(tmp, 'c');
        fs.mkdirSync(c);
        await cache.restore(key, c);
        assert.strictEqual(fs.readFileSync(path.join(c, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = "dep";\n', 'a copy, not the kept files');

        // ── The store keeps to its size, least recently used first ──
        const small = createDepsCache({ root: path.join(tmp, 'small'), maxMb: 256 });
        const big = path.join(tmp, 'big');
        const blob = Buffer.alloc(100 * 1024 * 1024, 1);
        write(path.join(big, 'package-lock.json'), '{}');
        write(path.join(big, 'node_modules', 'blob', 'data.bin'), blob);
        const bigMade = { modules: ['node_modules'], changed: [] };
        const keys = ['1', '2', '3'].map((n) => cacheKey({ dir: big, repo: `r${n}`, install: 'npm ci' }));
        await small.save(keys[0], big, bigMade);
        await small.save(keys[1], big, bigMade);
        // The first one was used since: the second is now the least recently used.
        const later = new Date(Date.now() + 60_000);
        fs.utimesSync(path.join(small.root, keys[0], 'manifest.json'), later, later);
        await small.save(keys[2], big, bigMade);
        const left = fs.readdirSync(small.root).filter((n) => !n.startsWith('.')).sort();
        assert.deepStrictEqual(left, [keys[0], keys[2]].sort(), `256 MB holds two of three 100 MB entries, the least recently used went (${left})`);

        // ── auto ──
        const auto = (files) => {
            const d = fs.mkdtempSync(path.join(tmp, 'auto-'));
            for (const [name, text] of Object.entries(files)) write(path.join(d, name), text);
            return autoCommands(d);
        };
        const pkg = JSON.stringify({ scripts: { test: 'node test/run.js' } });
        assert.deepStrictEqual(auto({ 'package.json': pkg, 'package-lock.json': '{}' }), { install: 'npm ci --no-audit --no-fund', test: 'npm test' });
        assert.deepStrictEqual(auto({ 'package.json': pkg, 'pnpm-lock.yaml': '' }), { install: 'pnpm install --frozen-lockfile', test: 'npm test' });
        assert.deepStrictEqual(auto({ 'package.json': pkg }), { install: 'npm install --no-audit --no-fund', test: 'npm test' });
        assert.match(auto({ 'package.json': '{}' }).none, /no test script/);
        assert.match(auto({ 'go.mod': 'module x' }).none, /no package\.json/);

        // ── The sandbox: download caches in the install phase only ──
        const ws = path.join(tmp, 'ws');
        fs.mkdirSync(ws);
        const limits = { cpus: 2, memory_mb: 2048 };
        const shared = path.join(tmp, 'shared');
        const inst = bwrapArgs({ workspace: ws, limits, proxySock: path.join(ws, 'p.sock'), sharedCache: shared, script: 'true' }).args;
        const at = inst.indexOf(shared);
        assert.ok(at > 0 && inst[at - 1] === '--bind' && inst[at + 1] === '/cache', 'the install phase gets /cache');
        assert.ok(inst.includes('npm_config_cache') && inst[inst.indexOf('npm_config_cache') + 1] === '/cache/npm');
        const testArgs = bwrapArgs({ workspace: ws, limits, proxySock: null, sharedCache: shared, script: 'true' }).args;
        assert.ok(!testArgs.includes(shared) && !testArgs.includes('/cache'), 'the test phase gets no shared cache');
        assert.strictEqual(testArgs[testArgs.indexOf('npm_config_cache') + 1], '/workspace/.cache/npm');
        const pod = podmanArgs({ name: 'n', workspace: ws, image: 'img', limits, proxySock: path.join(ws, 'p.sock'), sharedCache: shared, script: 'true' });
        assert.ok(pod.includes(`${shared}:/cache:rw`) && pod.includes('npm_config_prefer_offline=true'));
        const podTest = podmanArgs({ name: 'n', workspace: ws, image: 'img', limits, proxySock: null, sharedCache: shared, script: 'true' });
        assert.ok(!podTest.some((x) => String(x).includes(':/cache')), 'podman\'s test phase gets no shared cache either');
        assert.match(installScript('npm ci'), /NODE_USE_ENV_PROXY=1/, 'Node\'s own fetch uses the proxy');
        // Read-only host folders (Chrome under /opt/google): existing absolute folders only, never a home, /etc or /.
        const { safeRoBinds } = require('../runner/sandbox');
        assert.deepStrictEqual(safeRoBinds(['/usr/share', '/', '/etc', '/home/x', '/tmp', 'relative', '/usr/share/../../etc', '/does/not/exist']), ['/usr/share']);
        const withBind = bwrapArgs({ workspace: ws, limits, proxySock: null, roBinds: ['/usr/share', '/etc'], script: 'true' }).args;
        assert.ok(withBind.some((a, i) => a === '--ro-bind' && withBind[i + 1] === '/usr/share' && withBind[i + 2] === '/usr/share'), 'shown read-only at the same path');
        const podBind = podmanArgs({ name: 'n', workspace: ws, image: 'img', limits, proxySock: null, roBinds: ['/usr/share', '/etc'], script: 'true' });
        assert.ok(podBind.includes('/usr/share:/usr/share:ro') && !podBind.includes('/etc:/etc:ro'), 'podman too, and /etc is never bound');
        const etcDir = fs.readFileSync(path.join(ws, '.ci', 'etc', 'nsswitch.conf'), 'utf8');
        assert.match(etcDir, /^hosts: files myhostname$/m, '*.localhost resolves to loopback, as on GitHub\'s runners');
        // The test phase gets the timeout scale; the install phase does not.
        const scaledTest = bwrapArgs({ workspace: ws, limits, proxySock: null, testEnv: { OV_TEST_TIMEOUT_SCALE: '2' }, script: 'true' }).args;
        assert.strictEqual(scaledTest[scaledTest.indexOf('OV_TEST_TIMEOUT_SCALE') + 1], '2');
        const scaledInstall = bwrapArgs({ workspace: ws, limits, proxySock: path.join(ws, 'p.sock'), testEnv: { OV_TEST_TIMEOUT_SCALE: '2' }, script: 'true' }).args;
        assert.ok(!scaledInstall.includes('OV_TEST_TIMEOUT_SCALE'));
        assert.ok(podmanArgs({ name: 'n', workspace: ws, image: 'img', limits, proxySock: null, testEnv: { OV_TEST_TIMEOUT_SCALE: '2' }, script: 'true' }).includes('OV_TEST_TIMEOUT_SCALE=2'));
        assert.doesNotMatch(installScript('npm test', { proxy: false }), /NODE_USE_ENV_PROXY/);

        // ── The configuration ──
        const token = path.join(tmp, 'token');
        fs.writeFileSync(token, 'x'.repeat(40), { mode: 0o600 });
        const conf = path.join(tmp, 'ci.json');
        fs.writeFileSync(conf, JSON.stringify({ tokenFile: token, concurrency: 8, testTimeoutScale: 2, repos: { 'OpenVibers/OpenVibe.Live': {} } }));
        const cfg = loadConfig({ GIT_CI_CONFIG: conf });
        assert.strictEqual(cfg.testTimeoutScale, 2);
        assert.strictEqual(cfg.concurrency, 8);
        assert.ok(cfg.depsCache && cfg.sharedCache, 'both caches are on by default');
        assert.deepStrictEqual(registrations(cfg).map((r) => [r.full_name, r.install_command, r.test_command]), [['openvibers/openvibe.live', 'auto', 'auto']]);
        fs.writeFileSync(conf, JSON.stringify({ tokenFile: token, concurrency: 50, depsCache: '', sharedCache: '' }));
        const off = loadConfig({ GIT_CI_CONFIG: conf });
        assert.strictEqual(off.concurrency, 8, 'at most 8 workers');
        assert.strictEqual(off.depsCache, '');
        assert.strictEqual(off.sharedCache, '');

        console.log('ci-deps-cache: key, keep and restore, size limit, auto commands, install-only caches and workers passed');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
