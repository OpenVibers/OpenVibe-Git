'use strict';

/* OpenVibe.Git's small behaviour: copy a clone command (making a Git token the first time), and the diff's
   split view. Every page works without this file. */
(function () {
    async function copy(text) {
        try { await navigator.clipboard.writeText(text); return true; }
        catch {
            const area = document.createElement('textarea');
            area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
            document.body.appendChild(area); area.select();
            try { document.execCommand('copy'); } catch { /* the text is still on the page */ }
            area.remove();
            return false;
        }
    }

    document.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-git-token]');
        if (!button) return;
        event.preventDefault();
        const command = button.parentElement.querySelector('[data-git-command]');
        const repo = button.getAttribute('data-repo') || '';
        button.disabled = true;
        const said = button.textContent;
        button.textContent = 'Making a token…';
        try {
            const res = await fetch('/api/v1/tokens', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ scopes: ['git.read', 'git.write'], label: repo }),
            });
            if (res.status === 401) { window.location.href = `/auth/login?next=${encodeURIComponent(window.location.pathname)}`; return; }
            const data = await res.json();
            if (!res.ok || !data.token) throw new Error((data && data.detail) || 'the token was not made');
            const host = window.location.host;
            const text = `git clone https://x-access-token:${data.token}@${host}/${repo}.git`;
            if (command) command.textContent = text.replace(data.token, '‹token›');
            await copy(text);
            button.textContent = 'Copied with the token';
            setTimeout(() => { button.textContent = said; button.disabled = false; }, 4000);
        } catch (err) {
            button.textContent = 'Could not copy';
            setTimeout(() => { button.textContent = said; button.disabled = false; }, 3000);
        }
    });

    // A clone request's progress line: the page polls the row, Link posts each step. The page works without this
    // file: the request is still made (the form is a plain POST) and the terminal command is on the page.
    const line = document.querySelector('[data-clone-request]');
    if (line) {
        const id = line.getAttribute('data-clone-request');
        const endpoint = line.getAttribute('data-clone-endpoint') || `/api/v1/clone-requests/${encodeURIComponent(id)}`;
        const words = { queued: 'Sent to your computer…', waiting: 'Waiting for your answer in Link…', pending: 'Waiting for your answer in Link…', approved: 'Approved; Link is starting git…', cloning: 'Cloning…', done: 'Cloned.', refused: 'Refused in Link.', failed: 'The clone failed.', expired: 'The request expired after two minutes.' };
        const tick = async () => {
            try {
                const res = await fetch(endpoint, { credentials: 'same-origin' });
                if (!res.ok) return;
                const data = await res.json();
                const req = data.request || {};
                let text = words[req.state] || req.state || '';
                if (req.progress && (req.state === 'cloning' || req.state === 'done')) text = `${req.progress.percent}% · ${req.progress.line}`;
                if (req.state === 'done' && req.path) text = `Cloned into ${req.path}`;
                if (req.reason) text = `${text} ${req.reason}`;
                line.textContent = text;
                if (['done', 'refused', 'failed', 'expired'].includes(req.state)) return;
            } catch { /* the next tick tries again */ }
            setTimeout(tick, 1500);
        };
        setTimeout(tick, 600);
    }

    document.addEventListener('click', (event) => {
        const toggle = event.target.closest('[data-git-diff-toggle]');
        if (!toggle) return;
        const wrap = toggle.closest('[data-git-diff]');
        const unified = wrap.querySelector('.git-diff-unified');
        const split = wrap.querySelector('.git-diff-split');
        if (!split) return;
        const showSplit = split.hasAttribute('hidden');
        split.toggleAttribute('hidden', !showSplit);
        unified.toggleAttribute('hidden', showSplit);
        toggle.textContent = showSplit ? 'Unified view' : 'Split view';
    });

    document.addEventListener('click', (event) => {
        const sheet = document.querySelector('.git-get[open]');
        if (!sheet) return;
        if (sheet.contains(event.target)) return;
        sheet.removeAttribute('open');
    });
})();
