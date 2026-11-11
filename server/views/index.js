'use strict';

/**
 * The pages. Server-rendered, phone first, complete without JavaScript: forms are plain POSTs, the Get it
 * sheet is a <details>, the split diff is a second panel toggled by git.js. Every section has its own class
 * (git-home, git-repo, git-tree, git-file, git-commit, git-insights, …) so the look can be restyled without
 * touching the markup's meaning.
 */
const kit = require('openvibe-shared/kit');
const { esc, bytes, ago, date, initials, plural, spark, languageBar } = require('../render/html');
const { highlight, resolveLanguage } = require('../render/highlight');
const { renderMarkdown } = require('../render/markdown');

const icon = (name) => kit.icon(name);
const qs = (o) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v != null && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
};
const fullOf = (repo) => repo.full_name || `${repo.owner_username}/${repo.name}`;

function stars(n) { return Number(n) || 0; }

// ── Home ─────────────────────────────────────────────────────
function home({ viewer, stats, trending = [], activity = [], official = [], baseUrl }) {
    const signedIn = viewer && viewer.kind === 'user';
    const stat = (v, label) => `<li><b>${Number(v).toLocaleString('en-GB')}</b><span>${esc(label)}</span></li>`;
    return `<div class="git-home">
<section class="git-hero">
  <div class="git-hero-copy">
    <h1>Git for OpenVibe</h1>
    <p class="git-lede">Host code with your OpenVibe account, browse it, mirror GitHub, and clone it to your computer with Link. Every push is git's own; every page is ours.</p>
    <div class="git-actions">
      <a class="ovk-btn ovk-btn--primary" href="${signedIn ? '/new' : '/auth/login?next=%2Fnew'}">${icon('plus')} New repository</a>
      <a class="ovk-btn ovk-btn--ghost" href="/explore">${icon('search')} Explore</a>
      ${signedIn ? `<a class="ovk-btn ovk-btn--ghost" href="/machines">${icon('computer')} Your computers</a>` : ''}
    </div>
  </div>
  <div class="git-hero-motif" role="img" aria-label="A repository, its branch, and a clone to a computer">
    <div class="git-m-repo"><span class="git-m-dot"></span><b>openvibers/contracts</b><small>mirror of github.com</small><span class="git-m-bar"><i style="width:48%"></i><i style="width:27%"></i><i style="width:25%"></i></span></div>
    <div class="git-m-line"><span></span><em>git clone</em></div>
    <div class="git-m-pc"><span class="git-m-dot"></span><b>your computer</b><small>clone · commit · push</small><span class="git-m-ok">${icon('check')} OpenVibe sign-in</span></div>
  </div>
</section>
<ul class="git-stats" aria-label="OpenVibe Git in numbers">
  ${stat(stats.repositories, stats.repositories === 1 ? 'repository' : 'repositories')}
  ${stat(stats.pushes_this_week, 'pushes this week')}
  ${stat(stats.people, stats.people === 1 ? 'person' : 'people')}
  ${stat(stats.clones_this_week, 'clones this week')}
</ul>

<section class="git-section" aria-labelledby="git-trending-h">
  <div class="git-section-head"><h2 id="git-trending-h">Trending this week</h2><a href="/explore?sort=trending">All repositories</a></div>
  ${trending.length ? `<ul class="git-cards">${trending.map(card).join('')}</ul>` : kit.empty({ icon: 'code', title: 'No repositories yet', text: signedIn ? 'Make the first one: an empty repository, a starter app or a mirror of a public GitHub URL.' : 'Sign in and make the first one: an empty repository, a starter app or a mirror of a public GitHub URL.', action: { href: signedIn ? '/new' : '/auth/login?next=%2Fnew', label: 'New repository', icon: 'plus' } })}
</section>

<div class="git-split">
<section class="git-section" aria-labelledby="git-activity-h">
  <div class="git-section-head"><h2 id="git-activity-h">Recent activity</h2></div>
  ${activity.length ? `<ul class="git-activity">${activity.map(activityRow).join('')}</ul>` : kit.empty({ icon: 'clock', title: 'Nothing has happened yet', text: 'Pushes, changes and issues appear here as people work.', action: { href: '/explore', label: 'Explore repositories', icon: 'search' } })}
</section>
<section class="git-section" aria-labelledby="git-official-h">
  <div class="git-section-head"><h2 id="git-official-h">Official OpenVibe repositories</h2></div>
  ${official.length ? `<ul class="git-official">${official.map((r) => `<li><a class="git-official-main" href="/${esc(r.full_name)}"><span class="git-avatar git-avatar--org">${icon('code')}</span><span><b>${esc(r.name)}</b><small>${esc(r.description || 'The OpenVibe projects.')}</small></span></a>${r.github_full_name ? `<a class="git-official-gh" href="https://github.com/${esc(r.github_full_name)}" rel="noopener">${icon('open')} GitHub</a>` : ''}</li>`).join('')}</ul>` : kit.empty({ icon: 'code', title: 'The official repositories are on their way', text: 'The OpenVibe projects appear here once their mirrors are up.' })}
</section>
</div>

<section class="git-cta">
  <h2>Your code, on OpenVibe</h2>
  <p>Make a repository in one screen: empty, an OpenVibe app with the shared navbar, a static site, or imported from a public GitHub URL. Clone it over HTTPS in one tap, or send it to your computer with Link.</p>
  <a class="ovk-btn ovk-btn--primary" href="${signedIn ? '/new' : '/auth/login?next=%2Fnew'}">${icon('plus')} New repository</a>
</section>
</div>`;
}

function card(r) {
    return `<li class="git-card"><a href="/${esc(r.full_name)}">
<span class="git-card-top"><span class="git-avatar">${icon('code')}</span><span class="git-card-name"><b>${esc(r.full_name)}</b><small>${esc(r.description || 'No description yet.')}</small></span></span>
${languageBar(r.languages)}
<span class="git-card-meta"><span>${icon('star')} ${stars(r.stars)}</span><span>${icon('clock')} ${esc(ago(r.pushed_at || r.updated_at))}</span>${r.mirror ? '<span class="git-chip">mirror</span>' : ''}${r.github ? '<span class="git-chip git-chip--gh">GitHub</span>' : ''}</span>
</a></li>`;
}

function activityRow(e) {
    const target = e.owner && e.name ? `<a href="/${esc(e.owner)}/${esc(e.name)}">${esc(e.owner)}/${esc(e.name)}</a>` : 'a repository';
    const words = {
        push: 'pushed to', create: 'made', release: 'published a release on', star: 'starred', fork: 'forked', mirror: 'synced',
    }[e.type] || 'updated';
    const who = e.actor ? `<b>@${esc(e.actor)}</b> ` : '';
    return `<li><span class="git-avatar git-avatar--event">${icon(e.type === 'release' ? 'tag' : e.type === 'star' ? 'star' : 'code')}</span><span>${who}${esc(words)} ${target}<small>${esc(ago(e.at))}</small></span></li>`;
}

// ── Explore ──────────────────────────────────────────────────
function explore({ viewer, repositories = [], query = '', filters = {}, next = null, languages = [] }) {
    const chip = (key, label, href, on) => `<a class="git-filter${on ? ' is-on' : ''}" href="${esc(href)}">${esc(label)}</a>`;
    const base = { q: query, sort: filters.sort || 'trending', language: filters.language || '' };
    const keep = (extra) => `/explore${qs({ ...base, ...extra, official: undefined, mirror: undefined, mine: undefined, starred: undefined, ...(extra.official ? { official: 1 } : {}), ...(extra.mirror ? { mirror: 1 } : {}), ...(extra.mine ? { mine: 1 } : {}), ...(extra.starred ? { starred: 1 } : {}) })}`;
    return `<div class="git-explore">
<header class="git-page-head"><h1>Explore</h1><p>Every public repository on OpenVibe Git. Official projects, mirrors of GitHub, and what people are making.</p></header>
<form class="git-search" method="get" action="/explore">
  <label class="git-search-box">${icon('search')}<input type="search" name="q" value="${esc(query)}" placeholder="Search repositories and descriptions" aria-label="Search repositories"></label>
  <select name="language" aria-label="Language"><option value="">Every language</option>${languages.map((l) => `<option value="${esc(l)}"${filters.language === l ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
  <select name="sort" aria-label="Sort"><option value="trending"${filters.sort === 'trending' ? ' selected' : ''}>Trending</option><option value="pushed"${filters.sort === 'pushed' ? ' selected' : ''}>Recently pushed</option><option value="stars"${filters.sort === 'stars' ? ' selected' : ''}>Most starred</option><option value="new"${filters.sort === 'new' ? ' selected' : ''}>Newest</option></select>
  <button class="ovk-btn ovk-btn--primary" type="submit">Search</button>
</form>
<nav class="git-filters" aria-label="Filters">
  ${chip('all', 'All', keep({}), !filters.official && !filters.mirror && !filters.mine && !filters.starred)}
  ${chip('official', 'Official', keep({ official: 1 }), filters.official)}
  ${chip('mirror', 'Mirrors', keep({ mirror: 1 }), filters.mirror)}
  ${chip('mine', 'Mine', keep({ mine: 1 }), filters.mine)}
  ${chip('starred', 'Starred', keep({ starred: 1 }), filters.starred)}
</nav>
${repositories.length ? `<ul class="git-cards git-cards--wide">${repositories.map(card).join('')}</ul>` : kit.empty({ icon: 'search', title: 'Nothing matches', text: query ? `No repository matches “${query}”. Try another filter, or make one.` : 'Try another filter, or make one.', action: { href: '/new', label: 'Make a repository', icon: 'plus' } })}
${next ? `<a class="ovk-btn ovk-btn--ghost git-more" href="/explore${qs({ ...base, ...(filters.official ? { official: 1 } : {}), ...(filters.mirror ? { mirror: 1 } : {}), ...(filters.mine ? { mine: 1 } : {}), ...(filters.starred ? { starred: 1 } : {}), cursor: next })}">More</a>` : ''}
</div>`;
}

// ── Repository ───────────────────────────────────────────────
function repoTabs(row, active, ref) {
    const base = `/${row.owner_username}/${row.name}`;
    const tabs = [
        ['code', 'Code', base],
        ['changes', 'Changes', `${base}/changes`],
        ['issues', 'Issues', `${base}/issues`],
        ['ci', 'CI', `${base}/ci`],
        ['search', 'Search code', `${base}/search`],
        ['commits', 'Commits', `${base}/commits`],
        ['branches', 'Branches', `${base}/branches`],
        ['tags', 'Tags', `${base}/tags`],
        ['releases', 'Releases', `${base}/releases`],
        ['contributors', 'Contributors', `${base}/contributors`],
        ['insights', 'Insights', `${base}/insights`],
    ];
    return `<nav class="git-tabs" aria-label="Repository">${tabs.map(([key, label, href]) => `<a class="git-tab${active === key ? ' is-on' : ''}" href="${esc(href)}${key === 'commits' && ref ? qs({ ref }) : ''}"${active === key ? ' aria-current="page"' : ''}>${esc(label)}</a>`).join('')}</nav>`;
}

function repoHead({ row, viewer, starred, watching, forkOf, machines = null, cloneRequest = null }) {
    const signedIn = viewer && viewer.kind === 'user';
    const base = `/${row.owner_username}/${row.name}`;
    const starAction = signedIn
        ? `<form method="post" action="${base}/star" class="git-inline"><button class="ovk-btn ovk-btn--ghost${starred ? ' is-on' : ''}" type="submit" aria-pressed="${starred ? 'true' : 'false'}">${icon('star')} Star <b>${stars(row.stars)}</b></button></form>`
        : `<a class="ovk-btn ovk-btn--ghost" href="/auth/login?next=${encodeURIComponent(base)}">${icon('star')} Star <b>${stars(row.stars)}</b></a>`;
    const watchAction = signedIn
        ? `<form method="post" action="${base}/watch" class="git-inline"><button class="ovk-btn ovk-btn--ghost${watching ? ' is-on' : ''}" type="submit" aria-pressed="${watching ? 'true' : 'false'}">${icon('bell')} Watch <b>${row.watchers}</b></button></form>`
        : `<span class="ovk-btn ovk-btn--ghost is-off">${icon('bell')} Watch <b>${row.watchers}</b></span>`;
    return `<header class="git-repo-head">
  <p class="git-crumb"><a href="/">Repositories</a> ${icon('chevron')} <a href="/${esc(row.owner_username)}">${esc(row.owner_username)}</a> ${icon('chevron')} <b>${esc(row.name)}</b>${row.visibility === 'private' ? ' <span class="git-chip git-chip--private">private</span>' : ''}${row.official ? ' <span class="git-chip">official</span>' : ''}</p>
  <div class="git-repo-title">
    <div><h1>${esc(row.owner_username)}<span>/</span>${esc(row.name)}</h1>
    <p class="git-desc">${esc(row.description || 'No description yet.')}</p>
    ${row.topics && row.topics.length ? `<ul class="git-topics">${row.topics.map((t) => `<li><a href="/explore?q=${encodeURIComponent(t)}">${esc(t)}</a></li>`).join('')}</ul>` : ''}
    ${forkOf ? `<p class="git-forked">Forked from <a href="/${esc(forkOf)}">${esc(forkOf)}</a>.</p>` : ''}
    </div>
    <div class="git-repo-actions">${starAction}${watchAction}${signedIn ? `<form method="post" action="${base}/fork" class="git-inline"><button class="ovk-btn ovk-btn--ghost" type="submit">${icon('forward')} Fork <b>${row.forks}</b></button></form>` : `<a class="ovk-btn ovk-btn--ghost" href="/auth/login?next=${encodeURIComponent(base)}">${icon('forward')} Fork <b>${row.forks}</b></a>`}</div>
  </div>
  ${getIt(row, signedIn, machines, cloneRequest)}
</header>`;
}

/** One plain button per online Link computer; the offline ones say since when, and nothing is sent to them. */
function machineChoices(full, machines) {
    const online = machines.filter((m) => m.online);
    const offline = machines.filter((m) => !m.online);
    if (!online.length) {
        return `<p>No Link computer is online right now. Start Link on your computer, then ask again.</p>
      <form method="post" action="/${esc(full)}/clone" class="git-inline"><button class="ovk-btn ovk-btn--quiet" type="submit">${icon('computer')} Get a terminal command instead</button></form>
      ${offline.length ? `<p class="muted">${offline.map((m) => `${esc(m.name)} is offline since ${esc(ago(m.offline_since || m.last_seen_at))}`).join(' · ')}</p>` : ''}`;
    }
    return `${online.map((m) => `<form method="post" action="/${esc(full)}/clone-to-machine" class="git-inline">
        <input type="hidden" name="machine" value="${esc(m.id)}">
        <button class="ovk-btn ovk-btn--primary" type="submit">${icon('computer')} Clone to ${esc(m.name)}</button>
      </form>`).join('')}
      ${offline.length ? `<p class="muted">${offline.map((m) => `${esc(m.name)} is offline since ${esc(ago(m.offline_since || m.last_seen_at))}`).join(' · ')}</p>` : ''}
      <p class="muted"><a href="/machines">Your computers</a></p>`;
}

/** The plain words of a clone request's state; the progress line (git.js) uses the same ones. */
function cloneWords(request) {
    const words = {
        queued: 'Sent to your computer…', waiting: 'Waiting for your answer in Link…',
        pending: 'Waiting for your answer in Link…', approved: 'Approved; Link is starting git…',
        cloning: 'Cloning…', done: 'Cloned.', refused: 'Refused in Link.', failed: 'The clone failed.',
        expired: 'The request expired after two minutes.',
    };
    let text = words[request.state] || request.state || '';
    if (request.progress && (request.state === 'cloning' || request.state === 'done')) text = `${request.progress.percent}% · ${request.progress.line}`;
    if (request.state === 'done' && request.path) text = `Cloned into ${request.path}`;
    if (request.reason) text = `${text} ${request.reason}`;
    return text;
}

function getIt(row, signedIn, machines = null, cloneRequest = null) {
    const clone = `${row.owner_username}/${row.name}.git`;
    const full = `${row.owner_username}/${row.name}`;
    return `<details class="git-get" id="get"${cloneRequest ? ' open' : ''}>
  <summary class="ovk-btn ovk-btn--primary">${icon('download')} Get it <span class="git-get-caret">${icon('down')}</span></summary>
  <div class="git-sheet">
    <h2>Get this repository</h2>
    <div class="git-get-choice">
      <b>Clone over HTTPS</b>
      <p>A Git token is made for this copy and shown once. It can read and write the repositories you own, and expires in an hour.</p>
      <button class="ovk-btn ovk-btn--primary" type="button" data-git-token data-repo="${esc(full)}">${icon('copy')} Copy a clone command</button>
      <pre class="git-cmd" data-git-command>git clone https://git.openvibe.codes/${esc(clone)}</pre>
    </div>
    <div class="git-get-choice">
      <b>Clone to my computer</b>
      <p>OpenVibe Link asks you on your computer. The folder is inside the root you chose in Link, and the request ends after two minutes.</p>
      ${!signedIn
        ? `<a class="ovk-btn" href="/auth/login?next=${encodeURIComponent('/' + full)}">${icon('computer')} Clone to my computer</a>`
        : machines === null
          ? `<form method="post" action="/${esc(full)}/clone" class="git-inline"><button class="ovk-btn ovk-btn--primary" type="submit">${icon('computer')} Clone to my computer</button></form>`
          : machineChoices(full, machines)}
    </div>
    ${cloneRequest ? `<p class="git-clone-line" data-clone-request="${esc(cloneRequest.id)}" data-clone-endpoint="/api/v1/repos/${esc(full)}/clone-to-machine/${esc(cloneRequest.id)}" role="status" aria-live="polite">${esc(cloneWords(cloneRequest))}</p>` : ''}
    <div class="git-get-choice">
      <b>Open in Codes</b>
      <p>A Codes session clones from our disk: no network, no GitHub quota. When this repository has a GitHub twin, Codes pushes there too.</p>
      <a class="ovk-btn" href="https://openvibe.codes/new?repo=${encodeURIComponent(full)}">${icon('terminal')} Open in Codes</a>
    </div>
  </div>
</details>`;
}

function githubCard(card, row) {
    if (!card) return '';
    const ci = { success: ['passing', 'is-ok'], failure: ['failing', 'is-bad'], pending: ['running', 'is-warn'], unknown: ['unknown', ''] }[card.ci_state] || ['unknown', ''];
    return `<aside class="git-gh-card" aria-labelledby="git-gh-h">
  <p class="git-gh-title" id="git-gh-h">${icon('globe')} On GitHub <a href="${esc(card.html_url)}" rel="noopener">${esc(card.full_name)} ${icon('open')}</a></p>
  <ul><li><b>${card.stars.toLocaleString('en-GB')}</b><span>stars</span></li><li><b>${card.open_issues}</b><span>open issues</span></li><li><b>${card.open_pull_requests}</b><span>open pull requests</span></li><li><b class="git-ci ${ci[1]}">${ci[0]}</b><span>last CI</span></li></ul>
  <p class="git-gh-cache">Read ${esc(ago(card.fetched_at))}, kept for ten minutes.</p>
  ${row.mirror ? `<p class="git-gh-mirror">Mirror synced ${esc(ago(row.mirror.last_synced_at))}.</p>` : ''}
</aside>`;
}

function treeTable(row, ref, dirPath, entries, { crumbs = [] } = {}) {
    const base = `/${row.owner_username}/${row.name}`;
    const crumb = `<nav class="git-path" aria-label="Path">${crumbs.map((c, i) => `${i ? icon('chevron') : ''}<a href="${base}/tree${qs({ ref, path: c.path })}">${esc(c.name)}</a>`).join('')}</nav>`;
    return `<div class="git-tree-head">${crumb}<span class="git-ref-chip">${icon('code')} ${esc(ref)}</span></div>
<div class="table-wrap"><table class="git-tree"><caption class="sr-only">Files at ${esc(ref)}</caption><tbody>
${dirPath && crumbs.length > 1 ? `<tr><td class="git-entry"><a href="${base}/tree${qs({ ref, path: crumbs[crumbs.length - 2].path })}">${icon('back')} ..</a></td><td></td><td></td></tr>` : ''}
${entries.map((e) => {
        const href = e.type === 'tree' ? `${base}/tree${qs({ ref, path: e.path })}` : `${base}/blob${qs({ ref, path: e.path })}`;
        const last = e.last_commit;
        return `<tr><td class="git-entry"><a href="${esc(href)}"><span class="git-entry-icon">${icon(e.type === 'tree' ? 'folder' : e.type === 'commit' ? 'link' : 'file')}</span>${esc(e.name)}</a></td><td class="git-entry-msg">${last ? `<a href="${base}/commit/${esc(last.sha)}">${esc(last.message)}</a>` : '<span>—</span>'}</td><td class="git-entry-when">${last ? esc(ago(last.date)) : ''}</td><td class="git-entry-size">${e.size == null ? '' : esc(bytes(e.size))}</td></tr>`;
    }).join('')}
</tbody></table></div>`;
}

function readmeBlock(row, ref, readme) {
    if (!readme) return '';
    return `<section class="git-readme" aria-labelledby="git-readme-h"><div class="git-readme-head"><h2 id="git-readme-h">${icon('book')} ${esc(readme.path)}</h2><a href="/${esc(row.owner_username)}/${esc(row.name)}/blob${qs({ ref, path: readme.path })}">View file</a></div><div class="git-md">${readme.html}</div></section>`;
}

function treePage({ row, viewer, starred, watching, forkOf, tree, card, languages }) {
    const crumbs = [{ name: row.name, path: '' }, ...String(tree.path || '').split('/').filter(Boolean).map((seg, i, all) => ({ name: seg, path: all.slice(0, i + 1).join('/') }))];
    return `<div class="git-repo">
${repoHead({ row, viewer, starred, watching, forkOf })}
<div class="git-repo-grid">
  <div class="git-repo-main">${repoTabs(row, 'code')}${treeTable(row, row.default_branch, tree.path || '', tree.entries, { crumbs })}</div>
  <aside class="git-repo-side">${githubCard(card, row)}<div class="git-about"><h2>About</h2><p>${esc(row.description || 'No description yet.')}</p>${languageBar(languages || {})}</div></aside>
</div></div>`;
}

function repoPage({ row, viewer, starred, watching, forkOf, tree, readme, card, languages, isOwner = false, machines = null, cloneRequest = null }) {
    const base = `/${row.owner_username}/${row.name}`;
    const crumbs = [{ name: row.name, path: '' }, ...String(tree.path || '').split('/').filter(Boolean).map((seg, i, all) => ({ name: seg, path: all.slice(0, i + 1).join('/') }))];
    return `<div class="git-repo">
${repoHead({ row, viewer, starred, watching, forkOf, machines, cloneRequest })}
<div class="git-repo-grid">
  <div class="git-repo-main">
    ${repoTabs(row, 'code')}
    ${treeTable(row, row.default_branch, tree.path || '', tree.entries, { crumbs })}
    ${readmeBlock(row, row.default_branch, readme)}
  </div>
  <aside class="git-repo-side">
    ${githubCard(card, row)}
    <div class="git-about">
      <h2>About</h2>
      <p>${esc(row.description || 'No description yet.')}</p>
      ${languageBar(languages || {})}
      <ul class="git-about-list">
        <li>${icon('star')} <b>${stars(row.stars)}</b> stars</li>
        <li>${icon('eye')} <b>${row.watchers}</b> watching</li>
        <li>${icon('forward')} <b>${row.forks}</b> forks</li>
        <li>${icon('clock')} pushed ${esc(ago(row.pushed_at))}</li>
      </ul>
      <a class="git-about-link" href="${base}/insights">${icon('chart')} Insights</a>
    </div>
    ${isOwner ? `<div class="git-about git-owner-tools"><h2>Mirror</h2>
      ${row.mirror_url ? `<p class="git-gh-cache">From GitHub, synced ${esc(ago(row.mirror_last_synced_at))}.</p><form method="post" action="${base}/sync" class="git-inline"><button class="ovk-btn ovk-btn--ghost ovk-btn--small" type="submit">${icon('retry')} Sync now</button></form>` : '<p class="git-gh-cache">Push every push back to GitHub. Use a token for the twin repository.</p>'}
      <details class="git-fold"><summary class="ovk-btn ovk-btn--ghost ovk-btn--small">${icon('upload')} Push mirror</summary>
        <form method="post" action="${base}/push-mirror" class="git-form">
          <label>GitHub URL <input name="push_url" value="${esc(row.push_mirror_url || '')}" placeholder="https://github.com/you/${esc(row.name)}" inputmode="url"></label>
          <label>Token <input name="push_token" type="password" placeholder="${row.push_mirror_token ? 'a token is stored' : 'a token with repo scope'}" autocomplete="off"></label>
          <button class="ovk-btn ovk-btn--primary ovk-btn--small" type="submit">Save</button>
          ${row.push_mirror_url ? '<p class="git-gh-cache">Save an empty URL to turn it off.</p>' : ''}
        </form>
      </details>
    </div>` : ''}
  </aside>
</div>
</div>`;
}

// ── File, commits, commit ────────────────────────────────────
function filePage({ row, ref, path: filePath, blob, crumbs = [], plain = false }) {
    const base = `/${row.owner_username}/${row.name}`;
    const lang = resolveLanguage(filePath.split('.').pop());
    const raw = `${base}/raw${qs({ ref, path: filePath })}`;
    const hist = `${base}/commits${qs({ ref, path: filePath })}`;
    let body;
    if (blob.binary) {
        body = `<p class="git-empty">A binary file (${esc(bytes(blob.size))}). <a href="${raw}">Download it</a>.</p>`;
    } else if (blob.truncated) {
        body = `<p class="git-notice">This file is ${esc(bytes(blob.size))}; the page shows its beginning. <a href="${raw}">Download the whole file</a>.</p>`;
    } else if (!plain && /\.(md|markdown)$/i.test(filePath)) {
        // A Markdown file reads as the document it is (as a README does on the repository page); its code is one tap away.
        const here = `${base}/blob`;
        body = `<section class="git-readme git-doc"><div class="git-readme-head"><nav class="git-view" aria-label="View"><a aria-current="page" href="${here}${qs({ ref, path: filePath })}">${icon('book')} Preview</a><a href="${here}${qs({ ref, path: filePath, plain: '1' })}">${icon('code')} Code</a></nav></div><div class="git-md">${renderMarkdown(blob.text || '')}</div></section>`;
    } else {
        const lines = String(blob.text || '').split('\n');
        const toggle = /\.(md|markdown)$/i.test(filePath)
            ? `<nav class="git-view git-view--bar" aria-label="View"><a href="${base}/blob${qs({ ref, path: filePath })}">${icon('book')} Preview</a><a aria-current="page" href="${base}/blob${qs({ ref, path: filePath, plain: '1' })}">${icon('code')} Code</a></nav>` : '';
        body = `${toggle}<div class="git-code"><table class="git-code-table"><tbody>${lines.map((line, i) => {
            const n = i + 1;
            const h = highlight(line, lang);
            return `<tr id="L${n}"><td class="git-ln"><a href="#L${n}" aria-label="Line ${n}">${n}</a></td><td class="git-code-line">${h.html || ' '}</td></tr>`;
        }).join('')}</tbody></table></div>`;
    }
    return `<div class="git-file">
<header class="git-page-head git-file-head">
  <p class="git-crumb"><a href="${base}">${esc(row.full_name || `${row.owner_username}/${row.name}`)}</a> ${icon('chevron')} ${crumbs.map((c, i) => `${i ? icon('chevron') : ''}<a href="${base}/blob${qs({ ref, path: c.path })}">${esc(c.name)}</a>`).join('')}</p>
  <h1>${esc(filePath.split('/').pop())}</h1>
  <p class="git-file-meta"><span class="git-chip">${esc(ref)}</span> ${esc(blob.size != null ? bytes(blob.size) : '')} ${blob.text ? `· ${String(blob.text).split('\n').length} lines` : ''} · ${esc(lang)}</p>
  <div class="git-actions"><a class="ovk-btn ovk-btn--ghost" href="${raw}">${icon('download')} Raw</a><a class="ovk-btn ovk-btn--ghost" href="${hist}">${icon('clock')} History</a><a class="ovk-btn ovk-btn--ghost" href="${base}/blame/${encodeURIComponent(ref)}/${filePath.split('/').map(encodeURIComponent).join('/')}">Blame</a><a class="ovk-btn ovk-btn--ghost" href="${base}">${icon('back')} Repository</a></div>
</header>
${body}
</div>`;
}

function commitsPage({ row, ref, path: filePath, commits, next }) {
    const base = `/${row.owner_username}/${row.name}`;
    return `<div class="git-commits">
<header class="git-page-head"><p class="git-crumb"><a href="${base}">${esc(row.owner_username)}/${esc(row.name)}</a></p><h1>Commits</h1><p class="git-file-meta"><span class="git-chip">${esc(ref)}</span>${filePath ? ` · ${esc(filePath)}` : ''}</p></header>
${repoTabs(row, 'commits', ref)}
${commits.length ? `<ul class="git-commit-list">${commits.map((c) => `<li><a href="${base}/commit/${esc(c.sha)}">
<span class="git-avatar git-avatar--commit">${icon('code')}</span>
<span class="git-commit-main"><b>${esc(c.subject || c.message || '(no message)')}</b><small>${esc(c.author.name)} · ${esc(ago(c.date))}</small></span>
<span class="git-commit-sha"><code>${esc(c.short || c.sha.slice(0, 7))}</code></span>
</a></li>`).join('')}</ul>` : kit.empty({ icon: 'code', title: 'No commits here yet', text: 'The first commit starts the history.' })}
${next ? `<a class="ovk-btn ovk-btn--ghost git-more" href="${base}/commits${qs({ ref, path: filePath, cursor: next })}">More commits</a>` : ''}
</div>`;
}

function diffRows(diff) {
    return String(diff || '').split('\n').map((line) => {
        let kind = '';
        if (line.startsWith('+++') || line.startsWith('---')) kind = 'is-meta';
        else if (line.startsWith('@@')) kind = 'is-hunk';
        else if (line.startsWith('+')) kind = 'is-add';
        else if (line.startsWith('-')) kind = 'is-del';
        else if (line.startsWith('diff --git') || line.startsWith('index ')) kind = 'is-meta';
        return { line, kind };
    });
}

/** Pair removed and added lines into two columns, contexts on both sides. */
function splitRows(diff) {
    const rows = [];
    for (const item of diffRows(diff)) {
        const l = item.line;
        if (l.startsWith('+') && !l.startsWith('+++')) rows.push({ left: '', right: l, kind: 'is-add' });
        else if (l.startsWith('-') && !l.startsWith('---')) rows.push({ left: l, right: '', kind: 'is-del' });
        else rows.push({ left: l, right: l, kind: item.kind });
    }
    return rows;
}

function commitPage({ row, commit, diff = true }) {
    const base = `/${row.owner_username}/${row.name}`;
    const unified = diffRows(commit.diff).map((r) => `<div class="git-diff-line ${r.kind}"><span class="git-diff-sign">${r.line ? esc(r.line[0]) : ' '}</span><span>${esc(r.line)}</span></div>`).join('');
    const split = diff && commit.diff ? `<div class="git-diff-split" hidden>${splitRows(commit.diff).map((r) => `<div class="git-diff-row"><div class="git-diff-cell git-diff-left ${r.kind}">${r.left ? esc(r.left) : ''}</div><div class="git-diff-cell git-diff-right ${r.kind}">${r.right ? esc(r.right) : ''}</div></div>`).join('')}</div>` : '';
    return `<div class="git-commit">
<header class="git-commit-head">
  <p class="git-crumb"><a href="${base}">${esc(row.owner_username)}/${esc(row.name)}</a> ${icon('chevron')} <a href="${base}/commits">Commits</a></p>
  <h1>${esc((commit.message || '').split('\n')[0])}</h1>
  <p class="git-commit-meta"><span class="git-avatar git-avatar--sm">${esc(initials(commit.author.name))}</span> <b>${esc(commit.author.name)}</b> committed ${esc(ago(commit.date))} · <code>${esc(commit.sha.slice(0, 10))}</code>${commit.stats ? ` · ${plural(commit.stats.files, 'file')}, <span class="git-add">+${commit.stats.additions}</span> <span class="git-del">−${commit.stats.deletions}</span>` : ''}</p>
  ${(commit.message || '').includes('\n') ? `<pre class="git-commit-message">${esc(commit.message.split('\n').slice(1).join('\n').trim())}</pre>` : ''}
</header>
${diff && commit.diff ? `<div class="git-diff" data-git-diff><div class="git-diff-head"><h2>Changes</h2><button class="ovk-btn ovk-btn--ghost ovk-btn--small" type="button" data-git-diff-toggle>Split view</button></div><div class="git-diff-unified"><pre>${unified}</pre></div>${split}</div>` : '<p class="git-empty">This commit has no diff to show.</p>'}
</div>`;
}

// ── Branches, tags, releases, contributors, insights ─────────
function branchesPage({ row, branches }) {
    const base = `/${row.owner_username}/${row.name}`;
    return `<div class="git-list-page"><header class="git-page-head"><p class="git-crumb"><a href="${base}">${esc(row.full_name || `${row.owner_username}/${row.name}`)}</a></p><h1>Branches</h1></header>${repoTabs(row, 'branches')}
${branches.length ? `<ul class="git-refs">${branches.map((b) => `<li><a href="${base}/tree${qs({ ref: b.name })}"><span>${icon('code')} <b>${esc(b.name)}</b>${b.name === row.default_branch ? ' <span class="git-chip">default</span>' : ''}</span><small>${esc(b.subject)} · ${esc(ago(b.date))}</small><code>${esc(b.sha.slice(0, 7))}</code></a></li>`).join('')}</ul>` : kit.empty({ icon: 'branch', title: 'No branches yet', text: 'Push a branch and it appears here.' })}</div>`;
}

function tagsPage({ row, tags }) {
    const base = `/${row.owner_username}/${row.name}`;
    return `<div class="git-list-page"><header class="git-page-head"><p class="git-crumb"><a href="${base}">${esc(row.full_name || `${row.owner_username}/${row.name}`)}</a></p><h1>Tags</h1></header>${repoTabs(row, 'tags')}
${tags.length ? `<ul class="git-refs">${tags.map((t) => `<li><a href="${base}/tree${qs({ ref: t.name })}"><span>${icon('tag')} <b>${esc(t.name)}</b></span><small>${esc(t.subject)} · ${esc(ago(t.date))}</small><code>${esc(t.sha.slice(0, 7))}</code></a></li>`).join('')}</ul>` : kit.empty({ icon: 'tag', title: 'No tags yet', text: 'Tag a commit to mark a release.' })}</div>`;
}

function releasesPage({ row, releases, viewer }) {
    const base = `/${row.owner_username}/${row.name}`;
    const canPublish = viewer && viewer.kind === 'user';
    return `<div class="git-list-page"><header class="git-page-head"><p class="git-crumb"><a href="${base}">${esc(row.full_name || `${row.owner_username}/${row.name}`)}</a></p><h1>Releases</h1></header>${repoTabs(row, 'releases')}
${releases.length ? `<ul class="git-releases">${releases.map((r) => `<li><div class="git-release-head"><h2>${esc(r.name || r.tag)}</h2><span class="git-chip">${esc(r.tag)}</span><small>${esc(date(r.published_at))}</small></div>${r.body ? `<div class="git-md">${renderMarkdown(r.body)}</div>` : kit.empty({ icon: 'tag', title: 'No notes yet', text: 'Write what changed in this release.' })}${r.sha ? `<p class="git-release-sha"><a href="${base}/commit/${esc(r.sha)}"><code>${esc(r.sha.slice(0, 10))}</code></a></p>` : ''}</li>`).join('')}</ul>` : kit.empty({ icon: 'tag', title: 'No releases yet', text: 'A tag becomes a release when its notes are written.' })}
${canPublish ? `<details class="git-fold"><summary class="ovk-btn ovk-btn--ghost">${icon('plus')} Write release notes</summary><form method="post" action="${base}/releases" class="git-form"><label>Tag <input name="tag" required placeholder="v1.0.0"></label><label>Name <input name="name" placeholder="First release"></label><label>Notes <textarea name="body" rows="5" placeholder="What changed"></textarea></label><button class="ovk-btn ovk-btn--primary" type="submit">Publish</button></form></details>` : ''}
</div>`;
}

function contributorsPage({ row, contributors }) {
    const base = `/${row.owner_username}/${row.name}`;
    return `<div class="git-list-page"><header class="git-page-head"><p class="git-crumb"><a href="${base}">${esc(row.full_name || `${row.owner_username}/${row.name}`)}</a></p><h1>Contributors</h1></header>${repoTabs(row, 'contributors')}
${contributors.length ? `<ul class="git-people">${contributors.map((c) => `<li><span class="git-avatar">${esc(initials(c.name))}</span><span><b>${esc(c.name)}</b>${c.username ? ` <a href="/@${esc(c.username)}">@${esc(c.username)}</a>` : ''}<small>${esc(c.email)}</small></span><em>${plural(c.commits, 'commit')}</em></li>`).join('')}</ul>` : kit.empty({ icon: 'members', title: 'No contributors yet', text: 'People who commit to this repository appear here.' })}</div>`;
}

function insightsPage({ row, data }) {
    const base = `/${row.owner_username}/${row.name}`;
    const maxWeek = Math.max(1, ...data.commits_per_week.map((w) => w.commits));
    const value = (n) => Number(n || 0).toLocaleString('en-GB');
    return `<div class="git-insights">
<header class="git-page-head"><p class="git-crumb"><a href="${base}">${esc(row.full_name || `${row.owner_username}/${row.name}`)}</a></p><h1>Insights</h1><p>Views, clones, stars and commits. Public for a public repository: no admin account needed, unlike GitHub's traffic.</p></header>
${repoTabs(row, 'insights')}
<ul class="git-insight-stats">
  <li><b>${value(data.views)}</b><span>views · ${data.window_days} days</span></li>
  <li><b>${value(data.unique_visitors)}</b><span>unique visitors</span></li>
  <li><b>${value(data.clones)}</b><span>clones</span></li>
  <li><b>${value(data.stars.total)}</b><span>stars · ${value(data.stars.in_window)} new</span></li>
</ul>
<section class="git-chart" aria-labelledby="git-views-h"><div class="git-chart-head"><h2 id="git-views-h">Views and unique visitors</h2><span>per day</span></div>${spark(data.daily, 'views', { height: 64, label: 'views per day' })}${spark(data.daily, 'unique_visitors', { height: 32, label: 'unique visitors per day' })}</section>
<section class="git-chart" aria-labelledby="git-clones-h"><div class="git-chart-head"><h2 id="git-clones-h">Clones</h2><span>per day</span></div>${spark(data.daily, 'clones', { height: 48, label: 'clones per day' })}</section>
<section class="git-chart" aria-labelledby="git-weekly-h"><div class="git-chart-head"><h2 id="git-weekly-h">Commits per week</h2><span>last 26 weeks</span></div><ul class="git-weeks">${data.commits_per_week.map((w) => `<li><i style="height:${Math.max(2, Math.round((w.commits / maxWeek) * 72))}px" title="${esc(`${w.week}: ${w.commits}`)}"></i><span>${esc(w.week.slice(5))}</span></li>`).join('')}</ul></section>
</div>`;
}

// ── Profile, new, messages ───────────────────────────────────
function profilePage({ profile }) {
    return `<div class="git-profile"><header class="git-profile-head"><span class="git-avatar git-avatar--big">${esc(initials(profile.username))}</span><div><h1>@${esc(profile.username)}</h1><p>${plural(profile.repositories.length, 'public repository', 'public repositories')} on OpenVibe Git.</p></div></header>
${profile.repositories.length ? `<ul class="git-cards git-cards--wide">${profile.repositories.map(card).join('')}</ul>` : kit.empty({ icon: 'code', title: 'No public repositories yet', text: 'When this person makes one public it appears here.' })}</div>`;
}

function newPage({ viewer, values = {}, error = null }) {
    const v = (k, d = '') => esc(values[k] == null ? d : values[k]);
    return `<div class="git-new">
<header class="git-page-head"><h1>New repository</h1><p>One screen: a name, who can see it, and how it starts. No card, no second account.</p></header>
${error ? `<p class="git-error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/new" class="git-form git-form--new">
  <label class="git-field"><span>Owner</span><span class="git-owner">${esc(viewer && viewer.username ? viewer.username : 'you')} <i>/</i></span></label>
  <label class="git-field"><span>Repository name</span><input name="name" required maxlength="100" pattern="[a-z0-9][a-z0-9._-]*" value="${v('name')}" placeholder="my-project" autocapitalize="none" autocomplete="off" spellcheck="false"><small>Lower-case letters, digits, dots, dashes and underscores. Never ends in .git.</small></label>
  <label class="git-field"><span>Description</span><input name="description" maxlength="500" value="${v('description')}" placeholder="What it is, in a line."></label>
  <fieldset class="git-field"><legend>Who can see it</legend><label class="git-radio"><input type="radio" name="visibility" value="public"${v('visibility', 'public') === 'public' ? ' checked' : ''}> <span><b>Public</b><small>Anyone can read and clone it. It appears in Explore.</small></span></label><label class="git-radio"><input type="radio" name="visibility" value="private"${v('visibility') === 'private' ? ' checked' : ''}> <span><b>Private</b><small>Only you. Clone over HTTPS with your token.</small></span></label></fieldset>
  <fieldset class="git-field"><legend>How it starts</legend>
    ${starterChoice('empty', 'Empty', 'A README that says what it is.', v('starter', 'empty'))}
    ${starterChoice('app', 'OpenVibe app', 'An SDK starter with the shared navbar, footer and sign-in.', v('starter'))}
    ${starterChoice('static', 'Static site', 'index.html and a stylesheet, ready to publish.', v('starter'))}
    <label class="git-radio"><input type="radio" name="starter" value="mirror"${v('starter') === 'mirror' ? ' checked' : ''}> <span><b>Import from a URL</b><small>A public GitHub repository, mirrored here and kept in sync.</small></span></label>
  </fieldset>
  <label class="git-field"><span>GitHub URL (for Import)</span><input name="mirror_url" value="${v('mirror_url')}" placeholder="https://github.com/OpenVibers/OpenVibe.Contracts" inputmode="url" autocapitalize="none" spellcheck="false"><small>Public repositories only. The mirror syncs on GitHub's push webhook and every ten minutes.</small></label>
  <button class="ovk-btn ovk-btn--primary" type="submit">${icon('plus')} Make the repository</button>
</form>
</div>`;
}

function starterChoice(value, title, text, current) {
    return `<label class="git-radio"><input type="radio" name="starter" value="${value}"${current === value ? ' checked' : ''}> <span><b>${esc(title)}</b><small>${esc(text)}</small></span></label>`;
}

function message({ title, text, link = null, code = null }) {
    return `<div class="git-message"><h1>${esc(title)}</h1><p>${esc(text)}</p>${code ? `<pre class="git-cmd">${esc(code)}</pre>` : ''}${link ? `<a class="ovk-btn ovk-btn--primary" href="${esc(link.href)}">${esc(link.label)}</a>` : ''}</div>`;
}

const notFound = () => message({ title: 'Not found', text: 'That repository, file or person is not here. It may be private, or the link may be old.', link: { href: '/', label: 'OpenVibe Git' } });

module.exports = {
    home, explore, repoPage, treePage, repoHead, repoTabs, treeTable, filePage, commitsPage, commitPage, branchesPage, tagsPage,
    releasesPage, contributorsPage, insightsPage, profilePage, newPage, message, notFound, githubCard, card,
};
