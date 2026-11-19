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
<p>${enabled ? `The forge runner tests branch pushes by OpenVibers members and reports <code>${esc(context)}</code>. <a href="/ci">Every repository's runs</a>.` : 'Forge CI is not enabled for this repository; GitHub Actions still runs.'}</p></header>
${repoTabs(row, 'ci')}
${runs.length ? `<ul class="git-ci-list">${rows}</ul>` : kit.empty({ icon: 'gear', title: 'No forge runs yet', text: 'A run appears here when someone pushes a branch.' })}
<p class="git-muted git-small">The runner clones the branch, installs dependencies through an allowlisted proxy, then runs the tests with no network at all. Logs stay on the run they belong to.</p></div>`;
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const since = (value, now = Date.now()) => {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? duration(now - t) : '—';
};

function boardRow(r, extra = '') {
    return `<li class="git-ci-row">
  ${state(r.state)}
  <a class="git-ci-main" href="/${esc(r.repo)}/ci/${esc(r.id)}"><b>${esc(String(r.repo).replace(/^openvibers\//, ''))}</b> ${esc(r.branch)}<code>${esc(String(r.sha).slice(0, 12))}</code></a>
  <span class="git-muted">${extra}</span>
</li>`;
}

/** /ci: every public repository's runs, on our own runners. */
function board({ running, queued, recent, day, runners = 3 }) {
    const now = Date.now();
    const runningRows = running.map((r) => boardRow(r, `${esc(r.runner || '—')} · ${esc(since(r.started_at || r.created_at, now))} so far`)).join('');
    const queuedRows = queued.map((r, i) => boardRow(r, `next ${i + 1} · waiting ${esc(since(r.created_at, now))}`)).join('');
    const recentRows = recent.map((r) => boardRow(r, `${esc(r.description || '')} · ${esc(when(r.finished_at || r.created_at))}`)).join('');
    return `<div class="git-list-page"><header class="git-page-head"><h1>CI</h1>
<p>Every push to an OpenVibers repository is tested here, on our own runner: the shared node runs ${esc(runners)} at once, with
the work in memory and installs kept per lockfile. The verdict is the commit's <code>forge/test</code> status.</p></header>
<ul class="git-ci-facts">
  <li><span>Runs, last day</span>${esc(day.runs)}</li>
  <li><span>Passed</span>${esc(pct(day.passed, day.verdicts))}</li>
  <li><span>Median time (passed)</span>${esc(duration(day.median_ms))}</li>
  <li><span>Installs from the cache</span>${esc(pct(day.from_cache, day.installs))}</li>
</ul>
<h2>Now</h2>
${running.length || queued.length ? `<ul class="git-ci-list">${runningRows}${queuedRows}</ul>` : '<p class="git-muted">Nothing running or waiting.</p>'}
<h2>Latest</h2>
${recent.length ? `<ul class="git-ci-list">${recentRows}</ul>` : kit.empty({ icon: 'gear', title: 'No runs yet', text: 'A run appears here when someone pushes a branch.' })}
<p class="git-muted git-small">How it works: <a href="/openvibers/openvibe-git/src/branch/main/docs/ci.md">docs/ci.md</a>. The JSON is <code>/api/v1/ci/board</code>.</p></div>`;
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

module.exports = { list, run, when, duration, STATE, board };
