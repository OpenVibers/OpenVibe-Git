'use strict';

/**
 * Server-side syntax highlighting (highlight.js, common language set). Rendered into the
 * HTML so crawlers and no-JS readers get the same page as everyone else. Anything the
 * highlighter cannot name comes back escaped as plain text — never unhighlighted markup.
 */
const hljs = require('highlight.js/lib/common');

const MAX_HIGHLIGHT_BYTES = 200 * 1024;  // beyond this the page is served as plain text; the raw file is still there

// Media's language names → highlight.js names (and a few aliases people type).
const ALIASES = {
    text: 'plaintext', txt: 'plaintext', plain: 'plaintext', log: 'plaintext',
    js: 'javascript', node: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'shell', ps1: 'powershell',
    yml: 'yaml', md: 'markdown', 'c++': 'cpp', cc: 'cpp', h: 'c', cs: 'csharp', 'c#': 'csharp',
    rb: 'ruby', rs: 'rust', golang: 'go', kt: 'kotlin', docker: 'dockerfile', html: 'xml', htm: 'xml', vue: 'xml', svg: 'xml',
    conf: 'ini', toml: 'ini', env: 'ini', make: 'makefile', mk: 'makefile', patch: 'diff',
};

// What the "language" select offers. `auto` lets Media guess from the content.
const LANGUAGES = [
    ['auto', 'Auto-detect'], ['text', 'Plain text'], ['markdown', 'Markdown'],
    ['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['json', 'JSON'], ['html', 'HTML'], ['css', 'CSS'], ['scss', 'SCSS'],
    ['python', 'Python'], ['bash', 'Bash / shell'], ['powershell', 'PowerShell'], ['sql', 'SQL'], ['yaml', 'YAML'], ['ini', 'INI / TOML'],
    ['go', 'Go'], ['rust', 'Rust'], ['php', 'PHP'], ['java', 'Java'], ['kotlin', 'Kotlin'], ['swift', 'Swift'],
    ['c', 'C'], ['cpp', 'C++'], ['csharp', 'C#'], ['ruby', 'Ruby'], ['lua', 'Lua'], ['perl', 'Perl'], ['r', 'R'],
    ['xml', 'XML'], ['dockerfile', 'Dockerfile'], ['makefile', 'Makefile'], ['diff', 'Diff / patch'], ['nginx', 'nginx config'],
];

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function resolveLanguage(name) {
    const raw = String(name || 'text').trim().toLowerCase();
    const mapped = ALIASES[raw] || raw;
    return hljs.getLanguage(mapped) ? mapped : 'plaintext';
}

/** Human label for a stored language name. */
function languageLabel(name) {
    const raw = String(name || 'text').toLowerCase();
    const known = LANGUAGES.find(([id]) => id === raw);
    if (known) return known[1];
    return raw === 'plaintext' ? 'Plain text' : raw;
}

/**
 * @returns {{ html: string, language: string, lines: number, highlighted: boolean }}
 *   html is the inner HTML of a <code> element.
 */
function highlight(content, language) {
    const text = String(content || '');
    const lines = text.length ? text.split('\n').length : 0;
    const lang = resolveLanguage(language);
    if (lang === 'plaintext' || Buffer.byteLength(text, 'utf8') > MAX_HIGHLIGHT_BYTES) {
        return { html: escapeHtml(text), language: lang, lines, highlighted: false };
    }
    try {
        const out = hljs.highlight(text, { language: lang, ignoreIllegals: true });
        return { html: out.value, language: lang, lines, highlighted: true };
    } catch {
        return { html: escapeHtml(text), language: 'plaintext', lines, highlighted: false };
    }
}

/** File extension for downloads. */
function extensionFor(language) {
    const map = { javascript: 'js', typescript: 'ts', python: 'py', bash: 'sh', shell: 'sh', powershell: 'ps1', markdown: 'md', yaml: 'yml', rust: 'rs', ruby: 'rb', csharp: 'cs', cpp: 'cpp', kotlin: 'kt', dockerfile: 'Dockerfile', makefile: 'Makefile', plaintext: 'txt', text: 'txt', html: 'html', xml: 'xml', json: 'json', css: 'css', scss: 'scss', sql: 'sql', go: 'go', php: 'php', java: 'java', swift: 'swift', c: 'c', lua: 'lua', perl: 'pl', r: 'r', ini: 'ini', diff: 'diff', nginx: 'conf' };
    return map[String(language || 'text').toLowerCase()] || 'txt';
}

module.exports = { highlight, escapeHtml, resolveLanguage, languageLabel, extensionFor, LANGUAGES };
