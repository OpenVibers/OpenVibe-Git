'use strict';
/**
 * A directory's "last commit" column comes from one history walk at the ref being read (server/git/store.js
 * lastCommitsFor). Before 2026-11-19 it ran one `git log -1` per entry, one after another and without the ref:
 * tree pages took 0.86 s on average, and a branch's tree showed the default branch's history. What this proves:
 *   - every entry's last commit is the one `git log -1 <ref> -- <path>` names, at the root and in a subdirectory;
 *   - a branch's tree shows the branch's history, the default branch's shows its own;
 *   - a second read answers the same (kept by commit and directory);
 *   - a subfolder lists its own children (it listed itself, one row at "dir/dir", until the same day), and a missing
 *     folder or a file is not a directory.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'openvibe-git-tree-'));
process.env.GIT_DATA_DIR = DATA;
const store = require('../server/git/store');
const { REPOS_DIR } = require('../server/paths');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'openvibe-git-tree-work-'));
let tick = 0;
const git = (...args) => {
    tick += 1;
    const when = `2026-11-0${1 + Math.floor(tick / 10)}T0${tick % 10}:00:00Z`;
    return execFileSync('git', args, {
        cwd: work, encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Sam', GIT_AUTHOR_EMAIL: 'sam@example.test',
            GIT_COMMITTER_NAME: 'Sam', GIT_COMMITTER_EMAIL: 'sam@example.test', GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    }).trim();
};
const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true }); fs.writeFileSync(path.join(work, file), text); };
const commit = (message) => { git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };

(async () => {
    git('init', '-q', '-b', 'main');
    write('README.md', 'one'); write('src/a.js', 'a'); write('src/b.js', 'b'); write('docs/x.md', 'x');
    const first = commit('First');
    write('src/a.js', 'a2');
    const touchA = commit('Touch a');
    write('README.md', 'two');
    const readme = commit('Readme');
    git('checkout', '-q', '-b', 'feat');
    write('src/b.js', 'b2'); write('new.txt', 'n');
    const feat = commit('Feature');
    git('checkout', '-q', 'main');
    write('docs/x.md', 'x2');
    const docs = commit('Docs');

    fs.mkdirSync(path.join(REPOS_DIR, 'sam'), { recursive: true });
    execFileSync('git', ['clone', '-q', '--bare', work, path.join(REPOS_DIR, 'sam', 'proj.git')], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    const bare = path.join(REPOS_DIR, 'sam', 'proj.git');
    const truth = (ref, p) => execFileSync('git', ['log', '-1', '--format=%H', ref, '--', p], { cwd: bare, encoding: 'utf8' }).trim();

    const lastOf = async (ref, dir) => {
        const tree = await store.readTree('sam', 'proj', ref, dir);
        assert.ok(tree, `${ref}:${dir || '/'} reads`);
        for (const e of tree.entries) assert.strictEqual(e.last_commit && e.last_commit.sha, truth(ref, e.path), `${ref} ${e.path}: the commit git names`);
        return Object.fromEntries(tree.entries.map((e) => [e.name, e.last_commit.sha]));
    };

    assert.deepStrictEqual(await lastOf('main', ''), { 'README.md': readme, docs, src: touchA }, 'the root of main');
    assert.deepStrictEqual(await lastOf('main', 'src'), { 'a.js': touchA, 'b.js': first }, 'a subdirectory of main');
    assert.deepStrictEqual(await lastOf('feat', ''), { 'README.md': readme, docs: first, 'new.txt': feat, src: feat }, "the branch's root shows the branch's history");
    assert.deepStrictEqual(await lastOf('feat', 'src'), { 'a.js': touchA, 'b.js': feat });
    assert.deepStrictEqual(await lastOf('main', ''), { 'README.md': readme, docs, src: touchA }, 'a second read answers the same');

    const src = await store.readTree('sam', 'proj', 'main', 'src');
    assert.deepStrictEqual(src.entries.map((e) => [e.name, e.path, e.type]), [['a.js', 'src/a.js', 'blob'], ['b.js', 'src/b.js', 'blob']], 'a subfolder lists its children');
    assert.strictEqual(await store.readTree('sam', 'proj', 'main', 'nope'), null, 'a missing folder is not a directory');
    assert.strictEqual(await store.readTree('sam', 'proj', 'main', 'README.md'), null, 'nor is a file');

    const shown = (await store.readTree('sam', 'proj', 'main', 'src')).entries[0].last_commit;
    assert.deepStrictEqual(Object.keys(shown).sort(), ['author_name', 'date', 'message', 'sha'], 'the same fields as before');
    assert.strictEqual(shown.author_name, 'Sam');
    assert.strictEqual(shown.message, 'Touch a');

    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
    console.log('tree last commits: one walk at the ref, the commit git names for every entry');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
