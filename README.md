# OpenVibe.Git

Git for OpenVibe: host code with your OpenVibe account, browse it, mirror GitHub, and clone it to your computer with
Link.

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

## Layout

- `server/git/` — repositories on disk: creation, refs, trees, blobs, commits, diffs, bunches, and `http-backend`.
- `server/http/` — the pages and `/api/v1`.
- `server/mirror.js` — GitHub mirrors: the push webhook, the ten-minute poll, and the push mirror back.
- `server/insights.js` — views, unique visitors, clones, stars and commits per week.
- `contracts` — `git.repo@1`, `git.commit@1`, `git.tree@1`, `git.insights@1` (OpenVibe.Contracts).
- `deploy/` — the systemd unit and the nginx vhost for `git.openvibe.codes`.

Sign-in is OpenVibe only. Git over HTTPS uses a short-lived Git token made on the repository page (`git.repo.read` /
`git.repo.write`) or a typed Network token for the same audience; no second account system exists.

A first-party service (Codes, Run, Link) holds a typed Network token for `openvibe.git` and acts for the person it
names in `X-OV-Subject`: `POST /api/v1/repos` (with `owner_username`), `GET /api/v1/profile/:username` and
`POST /api/v1/tokens` then work as that person, and the Git token it mints is the person's own for clone and push.
A service never holds a person's password.
