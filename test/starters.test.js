'use strict';
const assert = require('assert');
const { boot } = require('./helpers/boot');
const { starterFiles } = require('../server/starters');

(async () => {
    const t = await boot();
    try {
        const sam = t.asUser('sam');
        for (const kind of ['empty', 'app', 'static']) {
            const repo = await t.ctx.repos.create({ actor: sam, name: `start-${kind}`, starter: kind });
            const tree = await t.ctx.git.readTree('sam', `start-${kind}`, 'main', '');
            assert.ok(tree.entries.some((e) => e.name === 'README.md'), `${kind}: README`);
            const readme = await t.ctx.git.readBlob('sam', `start-${kind}`, 'main', 'README.md');
            assert.match(readme.text, new RegExp(`sam/start-${kind}`));
            assert.equal(repo.default_branch, 'main');
        }
        const appTree = await t.ctx.git.readTree('sam', 'start-app', 'main', '');
        assert.ok(appTree.entries.some((e) => e.name === 'package.json'));
        assert.ok(appTree.entries.some((e) => e.name === 'server'));
        const staticTree = await t.ctx.git.readTree('sam', 'start-static', 'main', '');
        assert.ok(staticTree.entries.some((e) => e.name === 'index.html'));

        // The starter files never carry a path that leaves the repository.
        for (const kind of ['empty', 'app', 'static']) {
            for (const file of starterFiles(kind, { full: 'sam/x' })) {
                assert.ok(!file.path.includes('..') && !file.path.startsWith('/') && !file.path.endsWith('.git'));
            }
        }

        // A name that ends in .git is refused at creation.
        await assert.rejects(() => t.ctx.repos.create({ actor: sam, name: 'bad.git' }), /name|\.git/);
        console.log('starters: 13 checks passed');
    } finally { await t.close(); }
})().catch((err) => { console.error(err); process.exit(1); });
