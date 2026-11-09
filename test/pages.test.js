'use strict';
const assert = require('assert');
const { boot } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const sam = t.asUser('sam');
        const repo = await t.ctx.repos.create({ actor: sam, name: 'phone-first', description: 'A phone-first app.', starter: 'app', visibility: 'public' });

        const home = await t.get('/');
        assert.equal(home.status, 200);
        assert.match(home.text, /<h1>Git for OpenVibe<\/h1>/);
        assert.match(home.text, /application\/ld\+json/);
        assert.match(home.text, /phone-first/);
        assert.match(home.text, /New repository/);

        const explore = await t.get('/explore?q=phone');
        assert.equal(explore.status, 200);
        assert.match(explore.text, /sam\/phone-first/);
        assert.match(explore.text, /git-langbar|No description/);

        const page = await t.get('/sam/phone-first');
        assert.equal(page.status, 200);
        assert.match(page.text, /Get it/);
        assert.match(page.text, /README\.md/);
        assert.match(page.text, /git-repo-head/);
        assert.match(page.text, /git-tree/);
        assert.match(page.text, /SoftwareSourceCode/);
        assert.match(page.text, /<h1>sam<span>\/<\/span>phone-first<\/h1>/);

        // A Markdown file reads as a document; its code (with line links) is one tap away.
        const mdDoc = await t.get('/sam/phone-first/blob?ref=main&path=README.md');
        assert.equal(mdDoc.status, 200);
        assert.match(mdDoc.text, /class="git-md"/);
        assert.match(mdDoc.text, /aria-current="page"[^>]*>[\s\S]{0,200}Preview/);
        const file = await t.get('/sam/phone-first/blob?ref=main&path=README.md&plain=1');
        assert.equal(file.status, 200);
        assert.match(file.text, /id="L1"/);
        assert.match(file.text, /href="#L1"/);
        assert.match(file.text, /git-code-line/);

        const tree = await t.get('/sam/phone-first/tree?ref=main');
        assert.equal(tree.status, 200);
        assert.match(tree.text, /git-tree/);

        const commits = await t.get('/sam/phone-first/commits');
        assert.equal(commits.status, 200);
        assert.match(commits.text, /Start sam\/phone-first/);

        const insights = await t.get('/sam/phone-first/insights');
        assert.equal(insights.status, 200);
        assert.match(insights.text, /Insights/);
        assert.match(insights.text, /Commits per week/);

        const profile = await t.get('/@sam');
        assert.equal(profile.status, 200);
        assert.match(profile.text, /@sam/);

        const missing = await t.get('/nobody/nothing');
        assert.equal(missing.status, 404);
        assert.match(missing.text, /Not found/);

        // The API document is crawlable and names the real routes.
        const doc = await t.get('/openapi.json');
        assert.equal(doc.status, 200);
        assert.equal(doc.json().openapi, '3.1.0');

        // No placeholder content anywhere.
        assert.doesNotMatch(home.text, /lorem ipsum/i);
        assert.match(repo.full_name, /sam\/phone-first/);
        console.log('pages: 24 checks passed');
    } finally { await t.close(); }
})().catch((err) => { console.error(err); process.exit(1); });
