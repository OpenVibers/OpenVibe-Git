# Changes and review

G2 uses the existing `git.repo.read` / `git.repo.write` capabilities. Every read checks repository visibility; every change read also checks the source fork. Session mutations require the exact Origin. Merge, labels and model settings require repository ownership (G1 has no collaborator ACL). Merge and summary requests share a five-per-minute address budget; summaries additionally require ownership.

JSON routes below `/api/v1/repos/:owner/:name`:

- `GET /compare/:base...:head`: commits (up to 200), files (up to 300), added/removed counts and unified lines with old/new numbers. Branch slashes can be percent-encoded.
- `GET|POST /changes`: list or create `{title, body?, base_ref, head_ref, source_repo?}`; source is `owner/name`, same repo or its fork family.
- `GET /changes/:number`: change, diff, comments, approvals for the current SHA, checks and cached summary.
- `POST /changes/:number/comments`: `{head_sha,path,line,side:"old"|"new",message}`.
- `POST /changes/:number/approve`: `{head_sha}`.
- `POST /changes/:number/merge`: `{head_sha,method:"merge"|"squash"|"rebase"}`; conflicts are 409 with `files`.
- `POST /changes/:number/close`: close without merging.
- `POST /changes/:number/summary`: `{head_sha}`; result cached by change, SHA and selected model.
- `POST /review-model`: `{model}`; model identifiers use AI's choices catalogue.
- `GET|POST /issues`: list or create `{title,body?}`. `GET /issues/:number`, `POST /issues/:number/labels` with `{labels:[...]}`, `POST /issues/:number/close`.
- `GET /blame?ref=main&path=README.md`; `GET /search?q=literal` searches the default branch with git grep (three-second timeout, 1 MB output budget, 200 results).

The matching SSR routes are `/:owner/:name/compare/:base...:head`, `/changes`, `/changes/new`, `/changes/:number`, `/issues`, `/issues/new`, `/issues/:number`, `/blame/:ref/*` and `/search`. Forms work without JavaScript. No OpenAPI file existed in G1; this document is the route inventory.

## Integrations and deployment prerequisites

Community uses the existing `community.comment.write` and `community.comment.moderate` capabilities, requested by the server token client. One typed entity thread per change/issue is resolved through `POST /api/v1/comments/threads/resolve`. It is hidden before any content is posted. Git keeps line anchors locally and mirrors messages through an outbox; the opaque thread reference has no repository title. This prevents leaks when a repository later becomes private. The service uses staff moderation only on its own hidden threads. A failed delivery remains in the outbox (up to 12 attempts, one minute apart); inspect undelivered rows after outages. An ambiguous upstream success can duplicate a notification/comment because Community and Network do not offer idempotency for these calls.

Network needs `network.notifications.push` and `identity.subject.resolve`. Notifications address the change author, repository owner and watchers, excluding the actor and checking current visibility before delivery. These scopes must be granted to the Git service principal before deployment; this job does not alter production grants.

AI needs `ai.run.create` and `ai.run.read`, plus the AI-choices API from the concurrent AI-choices job (Contracts #389). G2 checks `GET /api/v1/tasks` for `ai.generate` before posting a run with `{workflow:"ai.generate",choice:{model,source:"openvibe"},on_behalf_of,input}`. Older AI fails closed, without silently using a different model. Local tests use mock runs; no paid calls were made. Run currently has job APIs but no repository/head-commit check lookup: the slot says **No checks**.

## Merge and maintenance

A filesystem directory lock serializes review mutations per target repository across processes. Git runs in a temporary detached worktree with hooks disabled, a fixed environment, argument arrays and time/output bounds. Updating the target uses compare-and-swap against its original SHA; a concurrent push fails instead of being overwritten. The head is checked again immediately before applying the target update. Conflicting files come from the unmerged index. Closed diffs retain their base and head objects under `refs/review/` and survive branch deletion.

Maintenance deletes `agent/*` branches seven days after close/merge only if unchanged, not the default branch, and not used by another open change. Deletion uses compare-and-swap. A crash can leave a review lock directory under `GIT_DATA_DIR/tmp`; inspect the repository and remove that specific stale directory only after confirming no merge is running. Git and SQL are separate stores: after a crash between ref update and the merged-state write, an operator must reconcile the change from the target history before retrying.
