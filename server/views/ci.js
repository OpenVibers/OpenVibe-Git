'use strict';

/**
 * The CI pages: the runs of one repository and one run's log. Plain and readable, no JavaScript needed. The
 * verdict is also a commit status ("forge/test") on the change page and in the API.
 */
const kit = require('openvibe-shared/kit');
const { esc } = require('../render/html');
const { repoTabs } = require('./index');

const base = (r) => `/${r.owner_username}/${r.name}`;
const STATE = {
    queued: 'Queued', running: 'Running', success: 'Passed', failure: 'Failed', error: 'Error',
    timed_out: 'Timed out', superseded: 'Superseded',
};

function when(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function duration(ms) {
    if (ms == null) return '—';
    const s = Math.max(0, Math.round(Number(ms) / 1000));
    const m = Math.floor(s / 60);
    return m ? `${m}m ${s % 60}s` : `${s}s`;
}

function state(s) { return `<span class="git-check git-check--${esc(s)}">${esc(STATE[s] || s)}</span>`; }

function list({ row, enabled, runs, context }) {
    const b = base(row);
    const rows = runs.map((run) => `<li class="git-ci-row">
  ${state(run.state)}
  <a class="git-ci-main" href="${b}/ci/${esc(run.id)}"><b>${esc(run.branch)}</b><code>${esc(String(run.sha).slice(0, 12))}</code></a>
  <span class="git-muted">${esc(run.pusher || '—')} · ${esc(duration(run.duration_ms))} · ${esc(when(run.created_at))}</span>
</li>`).join('');
    return `<div class="git-list-page"><header class="git-page-head"><p class="git-crumb"><a href="${b}">${esc(row.owner_username)}/${esc(row.name)}</a></p><h1>CI</h1>
<p>${enabled ? `The forge runner tests branch pushes by OpenVibers members and reports <code>${esc(context)}</code>.` : 'Forge CI is not enabled for this repository; GitHub Actions still runs.'}</p></header>
${repoTabs(row, 'ci')}
${runs.length ? `<ul class="git-ci-list">${rows}</ul>` : kit.empty({ icon: 'gear', title: 'No forge runs yet', text: 'A run appears here when someone pushes a branch.' })}
<p class="git-muted git-small">The runner clones the branch, installs dependencies through an allowlisted proxy, then runs the tests with no network at all. Logs stay on the run they belong to.</p></div>`;
}

function run({ row, run: r }) {
    const b = base(row);
    const log = String(r.log || '');
    return `<div class="git-list-page"><header class="git-page-head"><p class="git-crumb"><a href="${b}">${esc(row.owner_username)}/${esc(row.name)}</a> · <a href="${b}/ci">CI</a></p>
<h1>${esc(r.branch)} <code>${esc(String(r.sha).slice(0, 12))}</code></h1>
<p>${state(r.state)} <span class="git-muted">${esc(r.description || '')}</span></p></header>
${repoTabs(row, 'ci')}
<ul class="git-ci-facts">
  <li><span>Commit</span><a href="${b}/commit/${esc(r.sha)}"><code>${esc(r.sha)}</code></a></li>
  <li><span>Pusher</span>${esc(r.pusher || '—')}</li>
  <li><span>Started</span>${esc(when(r.started_at))}</li>
  <li><span>Finished</span>${esc(when(r.finished_at))}</li>
  <li><span>Duration</span>${esc(duration(r.duration_ms))}</li>
  <li><span>Exit code</span>${r.exit_code == null ? '—' : esc(r.exit_code)}</li>
</ul>
<section class="git-card" aria-labelledby="git-ci-log-h"><h2 id="git-ci-log-h">Log</h2>
${log ? `<pre class="git-cmd git-ci-log" aria-live="polite">${esc(log)}</pre>` : '<p class="git-muted">No output was kept.</p>'}
${r.state === 'running' ? '<p class="git-muted git-small">This run is still writing its log; reload to see more.</p>' : ''}</section></div>`;
}

module.exports = { list, run, when, duration, STATE };
