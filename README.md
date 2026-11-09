# OpenVibe.Git

Git for OpenVibe: host code with your OpenVibe account, browse it, mirror GitHub, and clone it to your computer with
Link.

**Live site:** https://git.openvibe.codes · **API docs:** https://openvibe.services · **For AI:** https://git.openvibe.codes/llms.txt
**Run it:** `npm ci && npm run dev` (Node 22 or newer) · **Tests:** `npm test`

`git.openvibe.codes` is served by this Node service. Repositories are bare git repositories on disk and the wire
protocol is git's own `git http-backend`; the pages, the API and the insights are ours, built with the shared navbar,
footer and kit.

## Run

```sh
npm install
npm run dev            # http://localhost:5250, an embedded PGlite database under data/
npm test               # every test file on a temp PGlite database
npm run test:pg        # the same through PostgreSQL + PgBouncer
```

Production reads `/etc/openvibe/git.env`; see `.env.example`. `DATABASE_URL` serves, `DATABASE_DIRECT_URL` migrates, and
`GIT_DATA_DIR` holds the bare repositories (`DATA_DIR/repos/<owner>/<name>.git`).

## Official mirrors

The Forgejo cut-over keeps the mirror list and nothing else, so the service rebuilds it from GitHub itself. When
`GIT_OFFICIAL_ORG` is set, a due-based background job mirrors that organisation's public repositories under
`GIT_OFFICIAL_OWNER` (by default the first of `GIT_OFFICIAL_OWNERS`, `openvibers`):

- it lists every page of the organisation through GitHub's REST API, with `GIT_GITHUB_TOKEN` when set. When that
  listing is refused for any reason (403/429/5xx/network — the host shares GitHub's 60 anonymous calls an hour), it
  falls back to the repositories named in `openvibe-contracts` (`manifests/services/*.json` and
  `manifests/repositories/*.json`), deduplicated, and the run says which list it used;
- each candidate is checked as public and existing through git's protocol (protocol-v2 `ls-refs` over
  `github.com`, which spends no REST quota); private and missing repositories are skipped and counted with the
  reason, and the answer names the default branch;
- it skips forks and archived repositories, and creates each missing repository as a GitHub mirror through the
  normal repository code, a few clones at a time (`GIT_OFFICIAL_CONCURRENCY`, default 3) and with the mirror
  timeout. When the API refuses the metadata for quota, the clone still runs and the card is marked pending; a
  later run fills the description, topics and default branch;
- names follow this service's rule, so `OpenVibe.Live` becomes `openvibe.live`; a name that cannot be used here is
  skipped and counted as invalid;
- it never deletes anything, and one log line per run reports the list's source, created, existing, skipped (with
  each reason) and failed.

The ten-minute mirror poll reads the remote's refs with `git ls-remote` (also `ls-refs`, also no REST quota) and
fetches only when something changed.

A run is due when `GIT_OFFICIAL_SYNC_MS` (default six hours) has passed since the last finished run; the last run
is a row in the database, so a deploy does not reset the interval. The first check is shortly after boot and the
job ticks hourly, in the background: `/api/ready` never waits on it, and a failed run waits for the next due time.
An empty `GIT_OFFICIAL_ORG` turns the job off, and so does drill mode.

## Layout

- `server/git/` — repositories on disk: creation, refs, trees, blobs, commits, diffs, bunches, and `http-backend`.
- `server/http/` — the pages and `/api/v1`.
- `server/mirror.js` — GitHub mirrors: the push webhook, the ten-minute poll, and the push mirror back.
- `server/official.js` — the due-based seed of the official mirrors from a GitHub organisation or the contracts.
- `server/contracts.js` — the repository list named by openvibe-contracts when GitHub's listing is refused.
- `server/insights.js` — views, unique visitors, clones, stars and commits per week.
- `contracts` — `git.repo@1`, `git.commit@1`, `git.tree@1`, `git.insights@1` (OpenVibe.Contracts).
- `deploy/` — the systemd unit and the nginx vhost for `git.openvibe.codes`.

Sign-in is OpenVibe only. Git over HTTPS uses a short-lived Git token made on the repository page (`git.repo.read` /
`git.repo.write`) or a typed Network token for the same audience; no second account system exists.

A first-party service (Codes, Run, Link) holds a typed Network token for `openvibe.git` and acts for the person it
names in `X-OV-Subject`: `POST /api/v1/repos` (with `owner_username`), `GET /api/v1/profile/:username` and
`POST /api/v1/tokens` then work as that person, and the Git token it mints is the person's own for clone and push.
A service never holds a person's password.

G2 adds changes and review, compare, issues, blame and code search. See [the API and integration notes](docs/g2-review.md) for routes, capability grants, the AI-choices dependency, and recovery details.
