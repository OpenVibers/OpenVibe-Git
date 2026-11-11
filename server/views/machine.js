'use strict';

/**
 * The G3 pages: a clone request's progress, and a person's computers published through Link. Plain kit markup and
 * no new styles; the design pass owns the look.
 */
const kit = require('openvibe-shared/kit');
const { esc, bytes, ago, initials } = require('../render/html');

const icon = (name) => kit.icon(name);
const qs = (o) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v != null && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
};

function clonePage({ row, request, link }) {
    const full = `${row.owner_username}/${row.name}`;
    return `<div class="git-list-page git-clone">
<header class="git-page-head"><p class="git-crumb"><a href="/${esc(full)}">${esc(full)}</a></p><h1>Clone to my computer</h1>
<p>OpenVibe Link asks you on your computer. The folder is inside the root you chose in Link, and the request ends after two minutes.</p></header>
<div class="git-get-choice">
  <p class="git-clone-line" data-clone-request="${esc(request.id)}" role="status" aria-live="polite">Waiting for your answer in Link…</p>
  <p><a class="ovk-btn ovk-btn--primary" href="openvibe-link://clone?url=${encodeURIComponent(link)}">${icon('computer')} Open Link</a></p>
  <p class="muted">No Link window? Run this in a terminal:</p>
  <pre class="git-cmd">openvibe-link clone '${esc(link)}'</pre>
  <p class="muted"><a href="/${esc(full)}">Back to ${esc(full)}</a></p>
</div>
</div>`;
}

/** The clone's own page: the same plain progress line the Get it panel shows, for a link opened on its own. */
function cloneToMachinePage({ row, request }) {
    const full = `${row.owner_username}/${row.name}`;
    return `<div class="git-list-page git-clone">
<header class="git-page-head"><p class="git-crumb"><a href="/${esc(full)}">${esc(full)}</a></p><h1>Clone to my computer</h1>
<p>Your computer asks you in Link before it writes anything. The folder is inside the root you chose there, and the request ends after two minutes.</p></header>
<div class="git-get-choice">
  <p class="git-clone-line" data-clone-request="${esc(request.id)}" data-clone-endpoint="/api/v1/repos/${esc(full)}/clone-to-machine/${esc(request.id)}" role="status" aria-live="polite">${esc(words(request))}</p>
  <p class="muted"><a href="/${esc(full)}">Back to ${esc(full)}</a></p>
</div>
</div>`;
}

function words(request) {
    const text = {
        queued: 'Sent to your computer…', waiting: 'Waiting for your answer in Link…',
        pending: 'Waiting for your answer in Link…', approved: 'Approved; Link is starting git…',
        cloning: 'Cloning…', done: 'Cloned.', refused: 'Refused in Link.', failed: 'The clone failed.',
        expired: 'The request expired after two minutes.',
    }[request.state] || request.state || '';
    if (request.state === 'done' && request.path) return `Cloned into ${request.path}`;
    return request.reason ? `${text} ${request.reason}` : text;
}

function machinesPage({ viewer, machines = [], error = null }) {
    const name = viewer && viewer.username ? viewer.username : 'you';
    const rows = machines.map((m) => `<li class="git-machine">
  <a href="/machines/${esc(m.id)}"><span class="git-entry-icon">${icon('computer')}</span><b>${esc(m.name)}</b></a>
  <span class="git-chip">${m.online ? 'online' : `offline since ${esc(ago(m.offline_since || m.last_seen_at))}`}</span>
  <small>${m.online ? `${m.repos.length} ${m.repos.length === 1 ? 'repository' : 'repositories'}` : 'Link is not checking in'}</small>
</li>`).join('');
    return `<div class="git-list-page">
<header class="git-page-head"><h1>Your computers</h1><p>Repositories on your own computers, published through Link. Read-only: Git can look, never write. Browsing works while the computer is online.</p></header>
${error ? `<p class="git-error" role="alert">${esc(error)}</p>` : ''}
${machines.length ? `<ul class="git-refs git-machines">${rows}</ul>` : kit.empty({ icon: 'computer', title: 'No computer is connected yet', text: 'Link publishes the repositories under a folder on your computer. Connect one below to browse them here.', action: { href: '/machines', label: 'Connect a computer', icon: 'computer' } })}
<details class="git-fold"><summary class="ovk-btn ovk-btn--primary">${icon('plus')} Connect a computer</summary>
<form method="post" action="/machines" class="git-form">
  <label>Name <input name="name" maxlength="80" placeholder="my laptop"></label>
  <p class="muted">Link shows you the command; it publishes the repositories under the root you chose there.</p>
  <button class="ovk-btn ovk-btn--primary" type="submit">Make a Link command</button>
</form></details>
<p class="muted">Signed in as @${esc(name)}.</p>
</div>`;
}

function machineConnectPage({ machine, link }) {
    return `<div class="git-list-page">
<header class="git-page-head"><p class="git-crumb"><a href="/machines">Your computers</a></p><h1>${esc(machine.name)}</h1>
<p>Run this on the computer. Link publishes the repositories under the root you chose in Link, read-only, and keeps checking in until you stop it.</p></header>
<pre class="git-cmd">openvibe-link git connect '${esc(link)}'</pre>
<p><a class="ovk-btn ovk-btn--primary" href="openvibe-link://git?url=${encodeURIComponent(link)}">${icon('computer')} Open Link</a></p>
<p class="muted">This link is the computer's own; keep it private. It appears in <a href="/machines">Your computers</a> when Link connects.</p>
</div>`;
}

function machinePage({ machine, repos = [] }) {
    const rows = repos.map((r) => `<li class="git-machine">
  <a href="/machines/${esc(machine.id)}/${esc(r.name)}"><span class="git-entry-icon">${icon('code')}</span><b>${esc(r.name)}</b></a>
  <span class="git-ref-chip">${esc(r.branch)}</span>
  <small>${esc(r.head_subject || '')} · ${esc(ago(r.updated_at))}</small>
</li>`).join('');
    return `<div class="git-list-page">
<header class="git-page-head"><p class="git-crumb"><a href="/machines">Your computers</a></p><h1>${esc(machine.name)}</h1>
<p>${machine.online ? 'Online now, read-only through Link.' : `Offline since ${esc(ago(machine.offline_since || machine.last_seen_at))}. Start Link to browse.`}</p></header>
${repos.length ? `<ul class="git-refs git-machines">${rows}</ul>` : kit.empty({ icon: 'code', title: 'No repositories under the root yet', text: 'Choose a folder on the computer when Link asks where to publish from.' })}
</div>`;
}

function machineRepoPage({ machine, repo, ref, path = '', entries = [], offline = null, error = null }) {
    const base = `/machines/${machine.id}/${repo.name}`;
    if (offline) return machineOffline({ machine, repo });
    if (error) return machineError({ machine, repo, error });
    const crumbs = [{ name: repo.name, path: '' }, ...String(path || '').split('/').filter(Boolean).map((seg, i, all) => ({ name: seg, path: all.slice(0, i + 1).join('/') }))];
    const rows = entries.map((e) => {
        const href = e.type === 'tree' ? `${base}/tree${qs({ ref, path: e.path })}` : `${base}/blob${qs({ ref, path: e.path })}`;
        return `<tr><td class="git-entry"><a href="${esc(href)}"><span class="git-entry-icon">${icon(e.type === 'tree' ? 'folder' : 'file')}</span>${esc(e.name)}</a></td><td class="git-entry-size">${e.size == null ? '' : esc(bytes(e.size))}</td></tr>`;
    }).join('');
    return `<div class="git-file">
<header class="git-page-head"><p class="git-crumb"><a href="/machines/${esc(machine.id)}">${esc(machine.name)}</a> ${icon('chevron')} <a href="${esc(base)}">${esc(repo.name)}</a></p><h1>${esc(repo.name)}</h1>
<p class="git-file-meta"><span class="git-chip">${esc(ref)}</span> · read-only through Link</p>
<div class="git-actions"><a class="ovk-btn ovk-btn--ghost" href="${base}/commits${qs({ ref })}">${icon('clock')} History</a><a class="ovk-btn ovk-btn--ghost" href="/machines/${esc(machine.id)}">${icon('back')} This computer</a></div></header>
<nav class="git-path" aria-label="Path">${crumbs.map((c, i) => `${i ? icon('chevron') : ''}<a href="${base}/tree${qs({ ref, path: c.path })}">${esc(c.name)}</a>`).join('')}</nav>
<div class="table-wrap"><table class="git-tree"><caption class="sr-only">Files in ${esc(repo.name)}</caption><tbody>
${path && crumbs.length > 1 ? `<tr><td class="git-entry"><a href="${base}/tree${qs({ ref, path: crumbs[crumbs.length - 2].path })}">${icon('back')} ..</a></td><td></td></tr>` : ''}
${rows || '<tr><td class="git-empty">This folder is empty (or the machine has not answered yet).</td><td></td></tr>'}
</tbody></table></div>
</div>`;
}

function machineFilePage({ machine, repo, ref, path, blob, offline = null, error = null }) {
    if (offline) return machineOffline({ machine, repo });
    if (error) return machineError({ machine, repo, error });
    const base = `/machines/${machine.id}/${repo.name}`;
    let body;
    if (blob.binary) body = `<p class="git-empty">A binary file (${esc(bytes(blob.size))}).</p>`;
    else if (blob.truncated) body = `<p class="git-notice">This file is ${esc(bytes(blob.size))}; the page shows the start of it.</p><pre class="git-cmd">${esc((blob.text || '').slice(0, 200000))}</pre>`;
    else body = `<div class="git-code"><table class="git-code-table"><tbody>${String(blob.text || '').split('\n').map((line, i) => `<tr id="L${i + 1}"><td class="git-ln"><a href="#L${i + 1}" aria-label="Line ${i + 1}">${i + 1}</a></td><td class="git-code-line">${esc(line) || ' '}</td></tr>`).join('')}</tbody></table></div>`;
    return `<div class="git-file">
<header class="git-page-head"><p class="git-crumb"><a href="${esc(base)}">${esc(repo.name)}</a> ${icon('chevron')} <a href="${base}/tree${qs({ ref, path: path.split('/').slice(0, -1).join('/') })}">${esc(path.split('/').slice(0, -1).join('/') || repo.name)}</a></p><h1>${esc(path.split('/').pop())}</h1>
<p class="git-file-meta"><span class="git-chip">${esc(ref)}</span> ${esc(bytes(blob.size))} · read-only through Link</p>
<div class="git-actions"><a class="ovk-btn ovk-btn--ghost" href="${base}/commits${qs({ ref, path })}">${icon('clock')} History</a></div></header>
${body}
</div>`;
}

function machineCommitsPage({ machine, repo, ref, path = '', commits = [], offline = null, error = null }) {
    if (offline) return machineOffline({ machine, repo });
    if (error) return machineError({ machine, repo, error });
    const base = `/machines/${machine.id}/${repo.name}`;
    return `<div class="git-commits">
<header class="git-page-head"><p class="git-crumb"><a href="${esc(base)}">${esc(repo.name)}</a></p><h1>Commits</h1><p class="git-file-meta"><span class="git-chip">${esc(ref)}</span>${path ? ` · ${esc(path)}` : ''} · read-only through Link</p></header>
${commits.length ? `<ul class="git-commit-list">${commits.map((c) => `<li><a href="${base}/commits${qs({ ref })}">
<span class="git-avatar git-avatar--commit">${icon('commit')}</span>
<span class="git-commit-main"><b>${esc(c.subject || '(no message)')}</b><small>${esc(c.author)} · ${esc(ago(c.date))}</small></span>
<span class="git-commit-sha"><code>${esc(c.short || c.sha.slice(0, 7))}</code></span></a></li>`).join('')}</ul>` : kit.empty({ icon: 'code', title: 'No commits here yet', text: 'The first commit starts the history.' })}
</div>`;
}

function machineOffline({ machine, repo }) {
    return `<div class="git-list-page">
<header class="git-page-head"><p class="git-crumb"><a href="/machines/${esc(machine.id)}">${esc(machine.name)}</a></p><h1>${esc(repo.name)}</h1>
<p>This computer is offline since ${esc(ago(machine.offline_since || machine.last_seen_at))}. OpenVibe Git browses it through Link, so it comes back when Link checks in again.</p></header>
<p><a class="ovk-btn" href="/machines/${esc(machine.id)}">${icon('back')} This computer</a></p>
</div>`;
}

function machineError({ machine, repo, error }) {
    return `<div class="git-list-page">
<header class="git-page-head"><p class="git-crumb"><a href="/machines/${esc(machine.id)}">${esc(machine.name)}</a></p><h1>${esc(repo.name)}</h1>
<p class="git-error" role="alert">${esc(error)}</p></header>
<p><a class="ovk-btn" href="/machines/${esc(machine.id)}">${icon('back')} This computer</a></p>
</div>`;
}

module.exports = { clonePage, cloneToMachinePage, machinesPage, machineConnectPage, machinePage, machineRepoPage, machineFilePage, machineCommitsPage };
