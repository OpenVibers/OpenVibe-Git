# Forge CI

`git.openvibe.codes` runs the tests for a push to an OpenVibers repository on the workstation, in a sandbox, and
reports the verdict on the commit. GitHub Actions stays exactly as it is: this is the first-party path that runs
beside it, not a replacement yet. Nothing in this document turns a GitHub workflow off.

## What runs, and when

A run is made only when all of these are true:

- the push is to a **branch** (`refs/heads/…`, never a tag or a deletion);
- the repository is an **official** OpenVibers mirror on the forge (its owner is in `GIT_OFFICIAL_OWNERS`, by
  default `openvibers`, and it mirrors `OpenVibers/<name>` on GitHub);
- the **push event's pusher** is the owning GitHub account, a login in `GIT_CI_MEMBERS`, or a collaborator GitHub
  says has `admin`, `maintain` or `write` on that repository. GitHub's answer is cached for 10 minutes;
- the repository has a CI entry (the runner registers the repositories it is configured for, see below).

It never runs for a pull request, a pull request from a fork, a push to a fork, a tag, a bot, or a non-member.
A repository with no CI entry is not tested here. The checks intake from GitHub (`server/checks-intake.js`) keeps
copying GitHub's check-runs, so a change can show both `test` (GitHub) and `forge/test` (here).

**One run per repository is live.** A newer branch push supersedes the queued or running one: the older run becomes
`superseded`, its runner sees that on the next heartbeat (every 15 s), kills its sandbox and reports no verdict.
The newer run then starts. The repository's `forge/test` status is pending from enqueue, and success, failure or
error when the runner reports; a timed-out run is a failure.

## What a run does

1. The runner claims one queued run from `POST /api/v1/ci/runs/claim` (its own token).
2. It clones **the pushed commit** from the forge (`https://git.openvibe.codes/<owner>/<name>.git`), retrying
   while the mirror catches up with the webhook.
3. **Install phase** — inside the sandbox, with one writable path (`/workspace`, the per-run directory) and the
   network only through the runner's proxy, which allows exactly `registry.npmjs.org` and `codeload.github.com`
   (the pinned OpenVibe tarballs). Everything else is refused, including private and link-local addresses. A
   dependency whose postinstall downloads with Node's own `fetch` (mediasoup's worker, onnxruntime's CUDA package)
   does not see that proxy, so those binaries are baked into a local image instead of fetched during the run.
4. **Test phase** — a fresh sandbox with **no network at all** (`--network=none` / an empty network namespace),
   the same workspace, no proxy socket mounted.
5. The log streams to the forge while it runs; the verdict goes back with the duration and is written as the
   `forge/test` commit status. The log is on `/<owner>/<name>/ci/<run>` and its JSON is
   `GET /api/v1/repos/<owner>/<name>/ci/runs/<id>`.

The commands, image and limit are per repository, registered by the runner from `~/.config/openvibe/git-ci.json`.
The defaults are `npm ci --no-audit --no-fund` then `npm test`, the image `docker.io/library/node:22-bookworm`, and
30 minutes. The first five repositories use three local images on top of the node image:

- `localhost/openvibe-ci-node22:1` — node 22 + pnpm 10.6.5 (`OpenVibe.Games`), because Corepack downloads pnpm with
  Node's `fetch`, which has no proxy.
- `localhost/openvibe-ci-node22-ffmpeg:1` — the pnpm image + ffmpeg (`OpenVibe.Chat`), matching GitHub's
  `apt-packages: ffmpeg`.
- `localhost/openvibe-ci-node22-mediasoup:1` — node 22 + the mediasoup 3.25.0 prebuilt worker, kernel6 asset
  (`OpenVibe.Live`); `MEDIASOUP_WORKER_BIN` points at it, so the postinstall does not fetch from GitHub. Live's
  install also sets `ONNXRUNTIME_NODE_INSTALL=skip`: the CUDA package is not needed on this CPU-only host and
  would fetch from NuGet.

The runner's own relay and proxy socket live in the container's `/run` tmpfs, never in the checkout: a
repository's linter must not see them. `OpenVibe.Games`' pnpm store is `node_modules/.pnpm-store` for the same
reason.

## How it is contained

| | |
|---|---|
| engine | rootless **podman** if `podman info` says rootless, else **bubblewrap** (the workstation has both; podman is used) |
| identity | a new user namespace; container root is not host root. The podman user namespace keeps the host uid (`--userns=keep-id`); bubblewrap uses uid/gid 1000 inside its own namespace |
| filesystem | read-only root (`--read-only`), a tmpfs `/tmp`, and **one** host path: the per-run work directory bind-mounted at `/workspace`. No home, no `/etc/openvibe`, no git checkout of the runner, no Docker socket, no SSH agent |
| secrets | none. The runner's own token is not mounted; no repository secret is passed; the container environment is an allowlist (HOME, PATH, locale, npm cache inside the workspace) |
| network | install: loopback only, with the proxy on a Unix socket (the sandbox has no route anywhere else). test: no network namespace route at all |
| limits | `--cpus 4`, `--memory 6144m` (swap the same), `--pids-limit 2048`, 30 minutes wall clock (configurable 30 s–1 h). A run past it is killed and reported `timed_out`; a runner that disappears is reaped by the service a minute after its limit |
| capabilities | all dropped, `no-new-privileges`, a new session; bubblewrap also disables nested user namespaces |
| concurrency | one run per repository (the forge's rule), and one at a time on this runner by default (`concurrency`) |

**What is not contained, and why.** A container is not a virtual machine: a kernel or runtime escape is still a
host compromise, and the workstation is the busiest machine in the estate (it also runs the portal and agent jobs).
The design reduces what an escape reaches (no secrets, no home, no socket, no host network in the test phase), but
it does not make the host disposable. The repositories are public and accept forks, which is why forks and pull
requests never reach this runner; the trigger is a same-repository branch push by a person GitHub says may push.
The full `test:pg` path (PostgreSQL + PgBouncer + Valkey containers) is not run here — there is no Docker socket
inside the sandbox, so the runner runs the repository's `npm test` (PGlite). For those suites GitHub Actions remains
the gate. If the machine is ever dedicated to CI, a disposable VM per run is the next step (see
`research-2026-11-10/forge-first.md` §4).

## Adding a repository

1. It must already be an official mirror on the forge (the official mirrors seed creates one for every public
   `OpenVibers` repository). Check: `GET https://git.openvibe.codes/api/v1/repos/openvibers/<name>`.
2. Add an entry to the runner's `repos` in `~/.config/openvibe/git-ci.json`:

   ```json
   "openvibers/openvibe.example": {
     "install_command": "npm ci --no-audit --no-fund",
     "test_command": "npm test",
     "timeout_seconds": 1800
   }
   ```

   Optional: `image`, `cpus` (1–8), `memory_mb` (512–12288). Only official repositories are accepted.
3. Restart the runner: `systemctl --user restart openvibe-git-ci`. On start it registers the entry through
   `POST /api/v1/ci/repos`; the forge now queues its member pushes.
4. Push to a branch, or start one by hand as the owner:
   `POST /api/v1/repos/openvibers/<name>/ci/runs` with `{"branch":"main"}` (a signed-in owner, or the runner token).
   The run appears at `https://git.openvibe.codes/openvibers/<name>/ci`.

Removing an entry stops new runs; it does not delete past runs or their statuses.

## Running it on the workstation

```sh
# from a checkout of OpenVibe.Git, as the workstation user (no sudo)
deploy/ci/install.sh --start
systemctl --user status openvibe-git-ci
journalctl --user -u openvibe-git-ci -f
```

`install.sh` checks the sandbox engine, pulls `node:22-bookworm`, keeps a checkout at `~/openvibe/git-ci`,
copies `deploy/ci/git-ci.example.json` to `~/.config/openvibe/git-ci.json` if there is none, installs
`deploy/systemd-user/openvibe-git-ci.service` into the user manager and (with `--start`) enables it.

The workstation's shared podman store is on the offload disk (`/mnt/120gb`), which ran out of **inodes**, not bytes.
The runner therefore gets its own store under `~/.local/share/openvibe-git-ci/containers/storage` on the home
filesystem, passed to every podman call with `--root`/`--runroot` and with its own `containers.conf` and
`containers-storage.conf` in `~/.config/openvibe` (libpod's database names the same graph root). `install.sh` writes
both files when they are absent and pulls the image into that store. Nothing global is changed.

The token is made once, on the workstation:

```sh
node runner/token.js --out ~/.config/openvibe/git-ci.token   # prints the scrypt line, not the token
# put that line in deploy/ci/runner-token, commit, deploy, restart the runner
```

The service holds only the scrypt hash of the token (`deploy/ci/runner-token`, or `GIT_CI_RUNNER_TOKEN` in
`/etc/openvibe/git.env`). To rotate: make a new token, put the new line in the repository, deploy, restart the
runner. The old token stops working when the new line is live.

## Measured (2026-11-11 UTC)

Same commit per row; forge time is claim → verdict, GitHub time is `run_started_at` → `updated_at`. Both include
install and tests; GitHub's queue is not included.

| repository | head | forge | GitHub |
|---|---|---|---|
| OpenVibe.Shared | `58934cc` | **1m 35s** success | 10m 53s success (the same head also had a 12m 59s failure) |
| OpenVibe.Games | `4070e5f` | **3m 46s** success | 13m 56s success |
| OpenVibe.Network | `ea86dc2` | **11m 29s** success | 22m 52s success |
| OpenVibe.Chat | `85d60a8` | **20m 13s** success | 18m 30s success |
| OpenVibe.Live | `9e4c000` | **7m 56s** success | 10m 59s success |

Chat is the one slower forge run (20m 13s against 18m 30s): the old i7-4770K runs the 134-file suite serially, while
GitHub's runner is a newer 4-vCPU machine, and the forge run has no warm cache. The other four are faster, mostly
because there is no install cache on GitHub and no queue here.

## The service side

- `migrations/0008_ci_runs.sql` — `git_ci_repos` (enabled, commands, image, limits) and `git_ci_runs` (state, log,
  timings), with a partial unique index that keeps one live run per repository.
- `server/ci.js` — the member rule, enqueue and supersede, claim/heartbeat/log/finish, the reaper and the
  `forge/test` status.
- `server/ci-auth.js` — the runner token's scrypt hash and the constant-time check.
- `server/http/api.js` — `/api/v1/ci/*` (runner token) and `/api/v1/repos/:owner/:name/ci*` (public reads, owner
  manual runs).
- `server/views/ci.js`, `server/http/pages.js` — the CI tab, the run list and the log page.
- `runner/` — `index.js` (poll), `run.js` (clone, phases, verdict), `sandbox.js` (podman/bubblewrap),
  `proxy.js` (the install allowlist), `process.js` (the wall clock), `config.js`, `api.js`, `token.js`.
