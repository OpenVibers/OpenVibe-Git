# AGENTS.md — OpenVibe.Git

## Project Overview

OpenVibe.Git hosts code with an OpenVibe account at `git.openvibe.codes`: bare git repositories on disk served by
git's own `git http-backend`, our pages/API/insights, GitHub mirrors, gzip tarballs for pins, commit statuses and
Forge CI, an npm registry, changes/reviews/issues/blame/code search, and the Link relay for clone-to-my-computer.

- **Domain:** `git.openvibe.codes` · **Port:** 5270 in production (dev 5250) · **Service id:** `git` ·
  **Env prefix:** `GIT`
- **Runtime:** Node 22, Express 4, PostgreSQL 18 through `openvibe-sdk/db` (PGlite in dev/tests), bare git repos
  under `GIT_DATA_DIR` (`DATA_DIR/repos/<owner>/<name>.git`), git itself on PATH.
- **Read first:** [README.md](README.md), [docs/g2-review.md](docs/g2-review.md), [docs/ci.md](docs/ci.md),
  [docs/npm-registry.md](docs/npm-registry.md), [.env.example](.env.example).

**Network context:** sign-in is OpenVibe only (`git` OAuth client via `openvibe-sdk/sso`). A first-party service
(Codes, Run, Link) holds a typed Network token for `openvibe.git` and acts for the person it names in
`X-OV-Subject`; it never holds a person's password. GitHub is an external mirror/source (REST + git protocol), and
Community owns discussion threads on changes/issues (referenced by opaque id through the comments API). Events are
OpenVibe.Events; account export/deletion follows ADR-033.

## Commands

```bash
npm ci                         # install (contracts/sdk/shared pinned by tag)
npm run dev                    # http://localhost:5250, PGlite under data/
npm start                      # node server/index.js
npm test                       # every test/*.test.js on temp PGlite and a temp data dir
npm run test:pg                # GIT_TEST_STORE=pg node test/run.js
npm test -- review             # only test files whose name contains the word
node --check <file.js>         # syntax check (no linter configured)
```

No build step: server-rendered pages; assets [public/css/git.css](public/css/git.css),
[public/js/git.js](public/js/git.js). Git itself must be installed in production.

## Architecture at a Glance

- **Entry:** [server/index.js](server/index.js) — listener, migrations, the official-mirror and mirror-poll jobs,
  telemetry, graceful stop. `GIT_DRILL` keeps boot-time work off.
- **App factory:** [server/app.js](server/app.js) — helmet/CSP, `/auth`, Git over HTTPS **mounted before pages**,
  the GitHub webhook, `/shared`, `/api/v1`, pages, 404/error handler. Tests build it with a temp DB/data dir.
- **Config:** [server/config.js](server/config.js) — `load(env)` is pure; production `/etc/openvibe/git.env`
  (data limits, audience `openvibe.git`, official owners, GitHub API, CI).
- **Git on disk:** [server/git/](server/git/) — `store.js`, `refs.js`, `cat-file.js`, `http-backend.js`,
  `review.js`, `run.js`; paths in [server/paths.js](server/paths.js). Wire auth
  [server/auth/git-auth.js](server/auth/git-auth.js).
- **Repositories/mirrors:** [server/repos.js](server/repos.js), [server/mirror.js](server/mirror.js),
  [server/official.js](server/official.js), [server/contracts.js](server/contracts.js),
  [server/github.js](server/github.js), [server/archive.js](server/archive.js) (tarballs),
  [server/starters.js](server/starters.js), [server/insights.js](server/insights.js).
- **Changes/reviews/issues:** [server/git/review.js](server/git/review.js), [server/reviews.js](server/reviews.js),
  [server/review-services.js](server/review-services.js), [server/http/review.js](server/http/review.js),
  [server/http/api.js](server/http/api.js), views [server/views/index.js](server/views/index.js).
- **Checks/CI/npm:** [server/checks.js](server/checks.js), [server/checks-intake.js](server/checks-intake.js),
  [server/ci.js](server/ci.js), [server/ci-auth.js](server/ci-auth.js), [server/npm-registry.js](server/npm-registry.js);
  runner in [runner/](runner/) + install/unit in [deploy/ci/](deploy/ci/) and
  [deploy/systemd-user/openvibe-git-ci.service](deploy/systemd-user/openvibe-git-ci.service).
- **Link relay:** [server/http/link.js](server/http/link.js), [server/link-relay.js](server/link-relay.js).
- **HTTP/render:** [server/http/pages.js](server/http/pages.js), [server/http/identity.js](server/http/identity.js),
  [server/render/](server/render/) (`layout.js`, `html.js`, `markdown.js`, `highlight.js`).
- **Database:** [server/db.js](server/db.js) and [migrations/](migrations/): `git_repos`, `git_tokens`, `git_views`,
  `git_clones`, `git_stars`, `git_watches`, `git_events`, `git_changes`, `git_change_reviews`,
  `git_change_comments`, `git_change_summaries`, `git_issues`, `git_releases`, `git_commit_statuses`,
  `git_checks_sync`, `git_ci_repos`, `git_ci_runs`, `git_npm_versions`, `git_npm_tags`, `git_clone_requests`,
  `git_machines`, `git_review_outbox`, `git_official_state`, `git_audit`.
- **Deploy:** [deploy/systemd/openvibe-git.service](deploy/systemd/openvibe-git.service) (PORT 5270,
  `/etc/openvibe/git.env`) and [deploy/nginx/git.openvibe.codes.conf](deploy/nginx/git.openvibe.codes.conf).
  `sudo ovhost deploy git` (ovhost service name `git`); the repositories live outside the code checkout.

## Ownership and Boundaries

Git owns repositories on disk, refs/trees/blobs/commits, tokens, mirrors and their metadata, official-mirror state,
tarball bytes, views/clones/stars/watches, changes/reviews/issues/releases, commit statuses and checks intake, CI
runs/repos, npm versions/tags, clone requests/machines and the Link relay state. It does **not** own identity,
accounts or roles (Network), discussion threads/comments (Community), event delivery (Events), GitHub itself (mirror
source), or the host/database (Host). A private repository answers **404** to anyone who may not see it — never 403
with a title; check visibility on every read path (page, API, raw, archive, clone).

## Auth and Capabilities

- Sign-in is Network SSO (`git` client). Git over HTTPS uses a short-lived Git token made on the repository page
  (`git.repo.read` / `git.repo.write`) or a typed Network token for audience `openvibe.git`. There is no second
  account system and no password storage.
- Service tokens: a first-party service acting for a person sends `X-OV-Subject` and may use `POST /api/v1/repos`
  (with `owner_username`), `GET /api/v1/profile/:username`, `POST /api/v1/tokens`; the Git token it mints is the
  person's own for clone/push.
- Capabilities used: `git.repo.read`, `git.repo.write`, `git.checks.write` (statuses), plus the
  Community/Network service calls in [docs/g2-review.md](docs/g2-review.md). Check merges/labels/model settings
  against repository ownership (G1 has no collaborator ACL).
- Session mutations require the exact Origin. A merge/summary request budget is five a minute per address.
- Errors are RFC 9457 problem+json with stable codes (`auth.required`, `token.scope`, `repo.not_found`, …); never
  echo a private repository's existence or a token.

## Routes

Git wire: `/<owner>/<name>.git/…` (http-backend) and the same under `/api/v1/repos/<owner>/<name>/`.
Pages: `/`, explore, new repository, profiles, repository tree/blob/log/commit, changes/reviews/issues/blame/search,
`/<owner>/<name>/ci/<run>`, `/machines`, `/settings`, `/auth/*`, discovery.
API: repo CRUD and metadata, raw/blob/tree/commit/diff, tarball `/<owner>/<name>/archive/<ref>.tar.gz`,
`POST /api/v1/repos/:owner/:name/commits/:sha/statuses` (+ GET latest per context), required checks, npm registry,
changes/reviews/issues/releases, clone requests and clone-to-machine, machines, `/api/v1/link/...`, CI claim/result,
GitHub webhook, `/api/health`, `/api/ready`, `/release.json`, `/metrics`.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; no linter/formatter.
- **Never shell out with user input.** Repository/ref/owner/name/path are validated and passed as argv to git, never
  through a shell. `test/no-shell.test.js` guards it; path traversal, `..`, leading `-` and absolute paths are
  refused. Keep `--` before paths.
- Limits are policy: `GIT_MAX_PUSH_BYTES` (512 MiB), `GIT_MAX_REPO_BYTES` (3 GiB), `GIT_MAX_FILE_BYTES` (2 MiB),
  `GIT_MAX_ARCHIVE_BYTES` (256 MiB). Stream, never buffer a whole repository.
- Tarballs: `git archive` of the resolved commit, top folder `<name>-<commit>/`, commit as ETag; a tag/full id caches
  immutably, a branch one minute. A package pin must point at a tag, not a branch.
- Mirrors: never delete anything on the forge; official seed falls back to the contracts' repository list when
  GitHub's listing is refused (403/429/5xx/network), uses `ls-refs` (no REST quota) to check public/existing, skips
  forks/archived, and reports each skip's reason.
- Checks: a change is mergeable only when its required contexts are green (per-repository, empty by default). For a
  mirror, intake copies GitHub check-runs at most every two minutes and only when a head moved.
- Forge CI: only branch pushes to official OpenVibers repos by members; one live run per repo, a newer push
  supersedes; install phase network only through the allowlisted proxy (`registry.npmjs.org`, `codeload.github.com`),
  test phase `--network=none`; the verdict is `forge/test` and the GitHub copy is best effort. Never turn a GitHub
  workflow off from here.
- CSP: add origins to `helmet` in [server/app.js](server/app.js); highlighted code is escaped, never raw source HTML.
- Phone first: pages fit 390 px; no Font Awesome (shared glyphs); a diff/table may scroll in its own box, never the
  page.
- "Calm reduces, only Off removes": hiding a fork/notification reduces; only an explicit delete/ref deletion removes.

## Key Pitfalls

- **Git over HTTPS is mounted before every page**: `/owner/name.git/...` must never fall through to a page, and a page
  must never shadow a repository path.
- **A private repo is 404**, including its raw file, archive and clone URL; do not leak a title, a branch or a count.
  A repository that becomes private also hides its Community thread's content (the opaque thread reference has no
  title); undelivered outbox rows should be inspected after an outage.
- **Token lifetime:** Git tokens are short-lived, scoped and revocable; never log or persist one. A token's audience
  is `openvibe.git`; a typed `typ`/`purpose` token is refused.
- **CI sandbox:** the install proxy allows exactly npm and codeload; test phase has no network. A dependency that
  downloads with Node's own fetch must be baked into the image, not fetched at run time.
- **Npm registry and tarballs** are public/private aware; a private package must not resolve without a token.
- **Mirror webhooks** are verified; a forged webhook writes nothing. A mirror poll fetches only when refs changed.
- **Starter repositories** are seeded only on first creation; never overwrite a person's existing repo.
- **Account export/deletion** is idempotent and never leaks another person's repository list.
- **Drill mode** (`GIT_DRILL`) keeps the official seed, mirror poll, checks intake and CI timers off.

## Testing

`npm test` runs each file in its own process on a temp PGlite database and data directory: refs/trees/blobs, http and
archive, API/pages, mirrors and quota, official seed, checks and intake, CI and runner, reviews/issues, Link relay and
clone-to-machine, npm registry, service delegation, insights, starters, security and no-shell. `npm run test:pg` uses
PostgreSQL. Run the narrowest file first, then the suite; always `node --check` changed files.

## Documentation

- [README.md](README.md) — run, official mirrors, tarballs/pins/checks, layout, Link clone/machines.
- [docs/g2-review.md](docs/g2-review.md) — changes/reviews/issues/blame/search, capabilities, Community integration.
- [docs/ci.md](docs/ci.md) — Forge CI, membership, sandbox, images, adding a repository.
- [docs/npm-registry.md](docs/npm-registry.md) — the npm registry surface.
- [SECURITY.md](SECURITY.md), [.env.example](.env.example).
