'use strict';
// server/render/markdown.js is openvibe-sdk/markdown (0.178.0) with this site's highlighter (the consolidation's hand
// merge of 2026-11-17): what a forum post may say is escaped, headings are demoted, code goes through highlight.js,
// and pipe tables (new with the SDK's renderer) draw as a scrolling region.
//   node test/markdown.test.js
const assert = require('assert');
const { renderMarkdown: md, markdownToText } = require('../server/render/markdown');

assert.strictEqual(md('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>', 'raw HTML is text');
assert.strictEqual(md('# Title'), '<h3>Title</h3>', 'headings demoted two levels: the page keeps one h1');
assert.ok(md('```js\nconst a = 1;\n```').includes('<span class="hljs-keyword">const</span>'), 'code through this site\'s highlighter');
assert.ok(md('| a | b |\n|---|---|\n| 1 | 2 |').includes('<table><thead><tr><th>a</th><th>b</th></tr></thead>'), 'pipe tables');
assert.ok(!md('[x](javascript:alert(1))').includes('href="javascript'), 'only safe links');
assert.strictEqual(markdownToText('**Bold** and `code`'), 'Bold and code');
console.log('markdown: openvibe-sdk/markdown with highlight.js; escaped, demoted, tables, safe links');
