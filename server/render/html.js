'use strict';

/** Page helpers: escape everything dynamic, and the small formatting functions the views share. */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function bytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
    return `${(v / 1024 ** 3).toFixed(2)} GB`;
}

function ago(iso, now = Date.now()) {
    if (!iso) return 'never';
    const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
    if (!Number.isFinite(s)) return 'never';
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 30) return `${Math.round(s / 86400)} days ago`;
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const date = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');

const initials = (name) => String(name || '?').trim().slice(0, 2).toUpperCase();

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

/** A small bar chart from daily numbers, as div columns (no script, no canvas). */
function spark(rows, key = 'views', { height = 34, label = 'activity' } = {}) {
    const max = Math.max(1, ...rows.map((r) => Number(r[key]) || 0));
    return `<div class="git-spark" style="--git-spark-h:${height}px" role="img" aria-label="${esc(label)}">${rows.map((r) => {
        const v = Number(r[key]) || 0;
        return `<span style="height:${Math.max(2, Math.round((v / max) * height))}px" title="${esc(`${r.day || r.week}: ${v}`)}"></span>`;
    }).join('')}</div>`;
}

/** The language bar: a stack of percentages. */
function languageBar(languages = {}) {
    // The four largest by share, then the rest as "Other": a legend of "YAML 0%" and "Shell 0.1%" was noise (11-09).
    const all = Object.entries(languages).map(([k, v]) => [k, Number(v) || 0]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const top = all.filter(([, v]) => v >= 1).slice(0, 4);
    const rest = Math.round((100 - top.reduce((n, [, v]) => n + v, 0)) * 10) / 10;
    const entries = rest >= 0.5 && all.length > top.length ? [...top, ['Other', rest]] : top;
    if (!entries.length) return '';
    const colours = ['var(--git-l1)', 'var(--git-l2)', 'var(--git-l3)', 'var(--git-l4)', 'var(--git-l5)', 'var(--git-l6)'];
    return `<div class="git-langbar" role="img" aria-label="${esc(entries.map(([k, v]) => `${k} ${v}%`).join(', '))}">${entries.map(([k, v], i) => `<span style="width:${Math.min(100, v)}%;background:${colours[i]}"></span>`).join('')}</div>
<p class="git-langlist">${entries.map(([k, v], i) => `<span><i style="background:${colours[i]}"></i>${esc(k)} <b>${v}%</b></span>`).join('')}</p>`;
}

module.exports = { esc, bytes, ago, date, initials, plural, spark, languageBar };
