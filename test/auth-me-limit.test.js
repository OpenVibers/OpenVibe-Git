'use strict';
// The navbar reads /auth/me on every page. Counted with sign-ins (60 in 15 minutes), a visitor who opened 60 pages
// looked signed out (open.shoes in the browser check, 11-15). /auth/me is not counted there; the sign-in routes still are.
const assert = require('assert');
const { boot } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const statuses = new Set();
        for (let i = 0; i < 70; i++) statuses.add((await t.get('/auth/me')).status);
        assert.ok(!statuses.has(429), `70 session reads answer without 429 (${[...statuses].join(',')})`);
        let limited = false;
        for (let i = 0; i < 70 && !limited; i++) limited = (await t.get('/auth/login')).status === 429;
        assert.ok(limited, 'the sign-in routes are still limited');
        console.log('auth-me-limit: the session read is not counted with sign-ins');
    } finally {
        await t.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
