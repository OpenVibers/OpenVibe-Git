'use strict';
/**
 * The review pages of a repository (G2): changes, issues, compare, code search and blame. Opus's design pass (11-09):
 * a change reads like a code review, not a form: the description, the AI summary and the diff with each comment at its
 * line on the left, and one merge box on the right (one column on a phone, the box first). Buttons are sized to their
 * words; only Merge is filled; Close is quiet. Every form keeps its fields and routes (server/http/review.js).
 */
const { esc } = require('../render/html');
const { renderMarkdown } = require('../render/markdown');
const glyphs = require('openvibe-shared/glyphs');

const base = (r) => `/${r.owner_username}/${r.name}`;
const ic = (name, size = 16) => `<span class="git-ic" aria-hidden="true">${glyphs.svg(name, { size })}</span>`;
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
const field = (name, label, value = '', extra = '') => `<label class="git-field"><span>${esc(label)}</span><input name="${name}" value="${esc(value)}" required${extra}></label>`;
const submit = (label, kind = 'primary', icon = '') => `<button class="ovk-btn ovk-btn--${kind}" type="submit">${icon ? ic(icon) : ''}<span>${esc(label)}</span></button>`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const STATE = { open: 'Open', merged: 'Merged', closed: 'Closed' };
const state = (s) => `<span class="git-state git-state--${esc(s)}">${esc(STATE[s] || s)}</span>`;

/** The page: the repository, the title, and the repository's review tabs with the current one marked. */
function wrap(r, title, body, tab = '') {
    const b = base(r);
    const tabs = [['code', 'Code', b], ['changes', 'Changes', `${b}/changes`], ['issues', 'Issues', `${b}/issues`], ['search', 'Search code', `${b}/search`],
        ['compare', 'Compare', `${b}/compare/${encodeURIComponent(r.default_branch)}...${encodeURIComponent(r.default_branch)}`]];
    return `<div class="git-review"><header class="git-page-head git-review-head"><p class="git-crumb"><a href="${b}">${esc(r.owner_username)}/${esc(r.name)}</a></p><h1>${esc(title)}</h1></header>
<nav class="git-tabs" aria-label="Repository review">${tabs.map(([id, label, href]) => `<a href="${href}"${id === tab ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>${body}</div>`;
}

/** The changed files: a summary row, then one card per file with its diff; comments sit under the line they are about. */
function diff(d, comments = []) {
    const at = new Map();
    for (const m of comments) {
        if (m.head_sha !== d.head) continue;
        const key = `${m.path}\u0000${m.side}\u0000${m.line}`;
        if (!at.has(key)) at.set(key, []);
        at.get(key).push(m);
    }
    const thread = (list) => `<div class="git-inline">${list.map((m) => `<article class="git-inline-c"><div class="git-readme-body">${renderMarkdown(m.message)}</div></article>`).join('')}</div>`;
    const files = d.files.map((f, i) => {
        // git's own header lines (diff --git, index, ---/+++, mode) say nothing the card's head does not: left out.
        const lines = f.lines.map((l, j) => {
            if (l.kind === 'meta') return '';
            const here = [...(at.get(`${f.path}\u0000new\u0000${l.new_line}`) || []), ...(l.kind === 'remove' ? (at.get(`${f.path}\u0000old\u0000${l.old_line}`) || []) : [])];
            return `<div class="git-diff-line git-diff-${l.kind}" id="file-${i}-line-${j}"><span>${l.old_line || ''}</span><span>${l.new_line || ''}</span><code>${esc(l.text)}</code></div>${here.length ? thread(here) : ''}`;
        }).join('');
        return `<article class="git-review-file" id="file-${i}"><header class="git-file-head">${ic('code')}<h3>${esc(f.path)}</h3><span class="git-delta"><b class="is-add">+${f.added}</b><b class="is-del">−${f.removed}</b></span></header>
${f.binary ? '<p class="git-muted git-file-note">Binary file changed</p>' : `<div class="git-unified" aria-label="Unified diff of ${esc(f.path)}">${lines}</div>`}</article>`;
    }).join('');
    return `<section class="git-files" aria-labelledby="git-files-h"><header class="git-sec-head"><h2 id="git-files-h">${plural(d.files.length, 'file')} changed</h2><span class="git-delta"><b class="is-add">+${d.added}</b><b class="is-del">−${d.removed}</b></span></header>
${d.files.length > 1 ? `<nav class="git-file-chips" aria-label="Files">${d.files.map((f, i) => `<a href="#file-${i}">${esc(f.path)}</a>`).join('')}</nav>` : ''}${files}</section>`;
}

function compare(r, d) {
    return wrap(r, 'Compare', `<p class="git-review-meta"><code class="git-ref">${esc(d.base.slice(0, 12))}</code> → <code class="git-ref">${esc(d.head.slice(0, 12))}</code></p>
<section class="git-card" aria-labelledby="git-commits-h"><h2 id="git-commits-h">${plural(d.commits.length, 'commit')}</h2><ul class="git-commit-rows">${d.commits.map((c) => `<li><code>${esc(c.sha.slice(0, 12))}</code><span>${esc(c.subject)}</span></li>`).join('') || '<li class="git-muted">No commits between these two.</li>'}</ul></section>${diff(d)}`, 'compare');
}

function list(r, kind, items) {
    const path = kind === 'change' ? 'changes' : 'issues';
    const rows = items.map((c) => `<li><a class="git-row" href="${base(r)}/${path}/${c.number}">${state(c.state)}<span class="git-row-title">${esc(c.title)}</span><span class="git-row-num">#${c.number}</span>${(c.labels || []).map((l) => `<small class="git-label">${esc(l)}</small>`).join('')}</a></li>`).join('');
    return wrap(r, kind === 'change' ? 'Changes' : 'Issues', `<div class="git-list-bar"><a class="ovk-btn ovk-btn--primary" href="${base(r)}/${path}/new">${ic('plus')}<span>New ${kind}</span></a></div>
${rows ? `<ul class="git-review-list">${rows}</ul>` : `<div class="git-empty">${ic(kind === 'change' ? 'branch' : 'chat', 22)}<p><b>No ${kind === 'change' ? 'changes' : 'issues'} yet</b></p><p class="git-muted">${kind === 'change' ? 'Push a branch, then open a change to ask for it to be merged.' : 'Report a problem or suggest something for this repository.'}</p></div>`}`, path);
}

function form(r, kind) {
    const path = kind === 'change' ? 'changes' : 'issues';
    return wrap(r, `New ${kind}`, `<form class="git-card git-review-form" method="post" action="${base(r)}/${path}">${field('title', 'Title')}
${kind === 'change' ? `<div class="git-field-row">${field('head_ref', 'From branch')}<span class="git-arrow" aria-hidden="true">→</span>${field('base_ref', 'Into branch', r.default_branch)}</div>${field('source_repo', 'From repository', `${r.owner_username}/${r.name}`)}` : ''}
<label class="git-field"><span>Description</span><textarea name="body" rows="6"></textarea></label><div class="git-form-go">${submit(`Open ${kind}`)}</div></form>`, path);
}

function change(r, out, canWrite, signed) {
    const c = out.change, b = `${base(r)}/changes/${c.number}`, open = c.state === 'open';
    const action = (op, inner) => `<form class="git-inline-form" method="post" action="${b}/${op}">${hidden('head_sha', out.diff.head)}${inner}</form>`;
    const outdated = out.comments.filter((m) => m.head_sha !== out.diff.head);
    const approvals = out.approvals.length;
    const checkItems = (out.checks || []).map((s) => {
        const name = s.target_url ? `<a href="${esc(s.target_url)}" rel="noopener">${esc(s.context)}</a>` : `<span>${esc(s.context)}</span>`;
        return `<li class="git-check git-check--${esc(s.state)}">${ic(s.state === 'success' ? 'check' : s.state === 'pending' ? 'eye' : 'shield')}${name}<span class="git-muted">${esc(s.state)}</span></li>`;
    }).join('');
    const requiredNote = (out.required || []).length && !out.mergeable ? '<p class="git-muted">Required checks are not passing.</p>' : '';
    const box = `<section class="git-card git-merge-box" aria-labelledby="git-merge-h"><h2 id="git-merge-h">Review</h2>
<ul class="git-status"><li class="${approvals ? 'is-ok' : ''}">${ic(approvals ? 'check' : 'eye')}<span>${approvals ? `${plural(approvals, 'approval')} for this commit` : 'No approvals for this commit yet'}</span></li><li>${ic('shield')}<span>${esc(out.checks_label)}</span></li></ul>
${checkItems ? `<ul class="git-checks">${checkItems}</ul>` : ''}${requiredNote}
${open && (signed || canWrite) ? `<div class="git-merge-acts">${signed ? action('approve', submit('Approve', 'quiet', 'check')) : ''}
${canWrite ? action('merge', `<label class="git-field git-field--inline"><span>How</span><select name="method"><option value="merge">Merge commit</option><option value="squash">Squash</option><option value="rebase">Rebase</option></select></label>${submit('Merge', 'primary', 'branch')}`) : ''}
${signed ? action('close', `<button class="git-close" type="submit">Close this change</button>`) : ''}</div>` : `<p class="git-muted">${open ? 'Sign in to review this change.' : `This change is ${esc(STATE[c.state] || c.state).toLowerCase()}.`}</p>`}</section>`;
    const model = canWrite ? `<section class="git-card" aria-labelledby="git-model-h"><h2 id="git-model-h">Review model</h2><p class="git-muted">The model that writes this repository's change summaries.</p>
<form class="git-inline-form git-model-form" method="post" action="${base(r)}/review-model"><label class="git-field"><span class="git-sr">Model</span><input name="model" value="${esc(r.review_model || '')}" placeholder="The account default" required></label>${submit('Save', 'quiet')}</form></section>` : '';
    const ai = `<section class="git-card git-ai" aria-labelledby="git-ai-h"><header class="git-sec-head">${ic('spark')}<h2 id="git-ai-h">AI summary and risk</h2></header>
${out.summary ? `<div class="git-readme-body">${renderMarkdown(out.summary.text)}</div><p class="git-muted git-small">Written by ${esc(out.summary.model)} for this commit.</p>` : '<p class="git-muted">No summary for this commit yet.</p>'}
${canWrite ? action('summary', submit(out.summary ? 'Summarize again' : 'Summarize and assess risk', 'quiet', 'spark')) : ''}</section>`;
    const paths = out.diff.files.map((f) => f.path);
    const commentForm = signed && open ? `<details class="git-card git-comment-new" id="git-comment"><summary>${ic('chat')}<span>Comment on a line</span></summary>
${action('comments', `<div class="git-field-row">${paths.length ? `<label class="git-field"><span>File</span><select name="path" required>${paths.map((p) => `<option>${esc(p)}</option>`).join('')}</select></label>` : field('path', 'File')}
<label class="git-field git-field--num"><span>Line</span><input name="line" type="number" min="1" required inputmode="numeric"></label>
<fieldset class="git-seg"><legend class="git-sr">Side</legend><label><input type="radio" name="side" value="new" checked><span>New</span></label><label><input type="radio" name="side" value="old"><span>Old</span></label></fieldset></div>
<label class="git-field"><span>Comment</span><textarea name="message" required rows="3"></textarea></label><div class="git-form-go">${submit('Comment', 'primary')}</div>`)}</details>` : '';
    const old = outdated.length ? `<section class="git-card" aria-labelledby="git-old-h"><h2 id="git-old-h">On earlier commits</h2>${outdated.map((m) => `<article class="git-review-comment"><p class="git-muted git-small"><code>${esc(m.path)}:${m.line}</code> · ${esc(m.side)} · ${esc(m.head_sha.slice(0, 12))} · Outdated</p><div class="git-readme-body">${renderMarkdown(m.message)}</div></article>`).join('')}</section>` : '';
    return wrap(r, `${c.title}`, `<p class="git-review-meta">${state(c.state)}<span class="git-row-num">#${c.number}</span><code class="git-ref">${esc(c.head_ref)}</code><span aria-hidden="true">→</span><code class="git-ref">${esc(c.base_ref)}</code><span class="git-muted">${plural(out.diff.files.length, 'file')} · <b class="is-add">+${out.diff.added}</b> <b class="is-del">−${out.diff.removed}</b> · ${plural(out.comments.length, 'comment')}</span></p>
<div class="git-cr"><aside class="git-cr-side">${box}${model}</aside><div class="git-cr-main">
<section class="git-card git-cr-body" aria-label="Description">${c.body && String(c.body).trim() ? `<div class="git-readme-body">${renderMarkdown(c.body)}</div>` : '<p class="git-muted">No description.</p>'}</section>
${ai}${diff(out.diff, out.comments)}${commentForm}${old}</div></div>`, 'changes');
}

function issue(r, c, canWrite, signed) {
    const b = `${base(r)}/issues/${c.number}`;
    const close = signed && c.state === 'open' ? `<form class="git-side-foot" method="post" action="${b}/close"><button class="git-close" type="submit">Close this issue</button></form>` : '';
    const side = canWrite
        ? `<section class="git-card" aria-labelledby="git-labels-h"><h2 id="git-labels-h">Labels</h2><form class="git-inline-form git-model-form" method="post" action="${b}/labels"><label class="git-field"><span class="git-sr">Labels, comma separated</span><input name="labels" value="${esc(c.labels.join(', '))}" placeholder="bug, docs" required></label>${submit('Save', 'quiet')}</form>${close}</section>`
        : close ? `<section class="git-card">${close}</section>` : '';
    return wrap(r, `${c.title}`, `<p class="git-review-meta">${state(c.state)}<span class="git-row-num">#${c.number}</span>${c.labels.map((l) => `<small class="git-label">${esc(l)}</small>`).join('')}</p>
<div class="git-cr">${side ? `<aside class="git-cr-side">${side}</aside>` : ''}<div class="git-cr-main"><section class="git-card git-cr-body" aria-label="Description">${c.body && String(c.body).trim() ? `<div class="git-readme-body">${renderMarkdown(c.body)}</div>` : '<p class="git-muted">No description.</p>'}</section>
<p class="git-muted git-small git-thread-note">${ic('chat', 14)}<span>${c.thread_id ? 'The discussion lives on OpenVibe.Community.' : 'The discussion opens on OpenVibe.Community shortly.'}</span></p></div></div>`, 'issues');
}

function search(r, out, q) {
    // A result is git grep's line, "path:line:text"; it links to the line when it has that shape.
    const row = (x) => {
        const m = /^([^:]+):(\d+):(.*)$/s.exec(String(x));
        if (!m) return `<li><pre class="git-review-results">${esc(x)}</pre></li>`;
        const href = `${base(r)}/blob/${encodeURIComponent(r.default_branch)}/${m[1].split('/').map(encodeURIComponent).join('/')}#L${m[2]}`;
        return `<li><a class="git-result-at" href="${href}"><code>${esc(m[1])}</code><span>:${m[2]}</span></a><pre class="git-review-results">${esc(m[3])}</pre></li>`;
    };
    return wrap(r, 'Search code', `<form class="git-search" method="get" role="search">${ic('code')}<label class="git-sr" for="git-q">Search the default branch</label><input id="git-q" name="q" value="${esc(q)}" placeholder="Search the default branch" required>${submit('Search')}</form>
${out ? `<section aria-labelledby="git-results-h"><h2 id="git-results-h">${plural(out.results.length, 'result')}${out.truncated ? ' · more matches left out' : ''}</h2><ul class="git-card git-results">${out.results.map(row).join('') || '<li class="git-muted">Nothing matches.</li>'}</ul></section>` : ''}`, 'search');
}

function blame(r, out) {
    return wrap(r, `Blame · ${out.path}`, `<div class="git-card git-unified">${out.lines.map((l) => `<div class="git-blame-line"><a href="${base(r)}/commit/${esc(l.commit)}"><code>${esc(String(l.commit).slice(0, 8))}</code></a><span>${esc(l.author || '')}</span><span>${l.line}</span><code>${esc(l.text)}</code></div>`).join('')}</div>`, 'code');
}

module.exports = { compare, list, form, change, issue, search, blame };
