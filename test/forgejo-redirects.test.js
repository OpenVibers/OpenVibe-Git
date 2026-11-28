'use strict';
// Forgejo's old addresses answer 301 to the same page (11-28: Meta's AI crawler asked for 2,748 of them in a day, all 404).
const assert = require('assert');
const { forgejoRedirect } = require('../server/http/forgejo-redirects');

const cases = [
    ['/user/login', '/auth/login'],
    ['/OpenVibers/OpenVibe.Contracts/src/branch/main/docs/adr/0001.md', '/OpenVibers/OpenVibe.Contracts/blob?ref=main&path=docs%2Fadr%2F0001.md'],
    ['/OpenVibers/OpenVibe.Contracts/src/tag/v0.76.0/fixtures/vip.plan/valid', '/OpenVibers/OpenVibe.Contracts/tree?ref=v0.76.0&path=fixtures%2Fvip.plan%2Fvalid'],
    ['/OpenVibers/OpenVibe.Contracts/src/commit/2fd098d8/', '/OpenVibers/OpenVibe.Contracts/tree?ref=2fd098d8'],
    ['/OpenVibers/OpenVibe.Contracts/commits/tag/v0.76.0/fixtures/vip.plan/valid', '/OpenVibers/OpenVibe.Contracts/commits?ref=v0.76.0&path=fixtures%2Fvip.plan%2Fvalid'],
    ['/OpenVibers/OpenVibe.Contracts/commits/branch/main', '/OpenVibers/OpenVibe.Contracts/commits?ref=main'],
    ['/OpenVibers/OpenVibe.Live/raw/branch/main/README.md', '/OpenVibers/OpenVibe.Live/raw?ref=main&path=README.md'],
    ['/OpenVibers/OpenVibe.Live/releases/tag/v1.2.3', '/OpenVibers/OpenVibe.Live/releases'],
];
cases.forEach(([from, to]) => assert.strictEqual(forgejoRedirect(from), to, from));
['/', '/OpenVibers/OpenVibe.Live', '/OpenVibers/OpenVibe.Live/tree', '/OpenVibers/OpenVibe.Live/commit/abc', '/auth/login', '/OpenVibers/OpenVibe.Live/blob']
    .forEach((own) => assert.strictEqual(forgejoRedirect(own), null, `${own} is OpenVibe.Git's own`));
console.log('forgejo-redirects: all passed');
