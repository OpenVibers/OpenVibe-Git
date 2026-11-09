'use strict';
const assert = require('assert');
const { boot } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const sam = t.asUser('sam');
        await t.ctx.repos.create({ actor: sam, name: 'numbers', starter: 'empty' });
        const row = await t.ctx.repos.getRow('sam', 'numbers');

        // Two views from one visitor in a day are two views and one unique visitor.
        await t.ctx.insights.recordView(row, { address: '198.51.100.7', userAgent: 'a phone' });
        await t.ctx.insights.recordView(row, { address: '198.51.100.7', userAgent: 'a phone' });
        await t.ctx.insights.recordView(row, { address: '198.51.100.8', userAgent: 'a laptop' });
        await t.ctx.insights.recordClone(row, { address: '198.51.100.7' });
        await t.ctx.insights.recordClone(row, { address: '198.51.100.8' });
        await t.ctx.repos.star(row, sam.subject, true);

        const data = await t.ctx.insights.forRepo(row, { days: 30, commitsPerWeek: () => t.ctx.git.commitsPerWeek('sam', 'numbers', 'main') });
        assert.equal(data.repo, 'sam/numbers');
        assert.equal(data.window_days, 30);
        assert.equal(data.views, 3);
        assert.equal(data.unique_visitors, 2);
        assert.equal(data.clones, 2);
        assert.equal(data.stars.total, 1);
        assert.equal(data.stars.in_window, 1);
        assert.equal(data.daily.length, 30);
        assert.ok(data.commits_per_week.length >= 20);
        assert.ok(data.commits_per_week.some((w) => w.commits >= 1));

        // The API hands the same numbers to the page.
        const api = await t.get('/api/v1/repos/sam/numbers/insights?days=7');
        assert.equal(api.status, 200);
        assert.equal(api.json().window_days, 7);
        assert.equal(api.json().views, 3);

        // A view through the page is recorded too.
        const before = (await t.get('/api/v1/repos/sam/numbers/insights')).json().views;
        await t.get('/sam/numbers');
        const after = (await t.get('/api/v1/repos/sam/numbers/insights')).json().views;
        assert.equal(after, before + 1);

        console.log('insights: 16 checks passed');
    } finally { await t.close(); }
})().catch((err) => { console.error(err); process.exit(1); });
