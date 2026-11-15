'use strict';
/**
 * Settings → GitHub (plan §AD.10 step 3): link one GitHub token, so a repository's push mirror needs none of its own.
 * Plain forms; the token is never shown again once saved, only the account it belongs to.
 */
const { esc } = require('../render/html');

function page({ linked = null, ok = '', error = '' } = {}) {
    const notice = `${ok ? `<p class="git-notice" role="status">${esc(ok)}</p>` : ''}${error ? `<p class="git-notice git-notice--bad" role="alert">${esc(error)}</p>` : ''}`;
    const state = linked
        ? `<p>Linked to <b>@${esc(linked.login)}</b> on GitHub. A push mirror with no token of its own pushes with it.</p>
<form method="post" action="/settings/github/unlink" class="git-inline"><button class="ovk-btn ovk-btn--ghost" type="submit">Unlink</button></form>
<h2>Use another token</h2>`
        : '<p>Nothing is linked. Each push mirror needs its own token until you link one here.</p>';
    return `<div class="git-message git-settings">
<h1>GitHub</h1>
${notice}
${state}
<form method="post" action="/settings/github" class="git-form">
  <label>GitHub token <input name="token" type="password" autocomplete="off" spellcheck="false" required placeholder="github_pat_… or ghp_…"></label>
  <p class="git-gh-cache">A fine-grained token with Contents: Read and write on the repositories you mirror. It is sealed here, used only to push your mirrors, and never shown again.</p>
  <button class="ovk-btn ovk-btn--primary" type="submit">${linked ? 'Replace the token' : 'Link GitHub'}</button>
</form>
</div>`;
}

module.exports = { page };
