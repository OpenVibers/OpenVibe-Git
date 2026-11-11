-- phase: expand
-- Forge CI: which repositories the workstation runner tests, and one row per run it did.
--
-- A repository is enabled with a command pair (install, with the network proxy; test, with no network at all),
-- an image and a time limit. The runner registers them over its own token. One run per repository is live at a
-- time: a newer push supersedes the queued or running one (the runner sees it on its heartbeat and stops).
-- The log is bounded; the run's verdict is copied into git_commit_statuses as "forge/test".

CREATE TABLE git_ci_repos (
    repo_id        text PRIMARY KEY REFERENCES git_repos (id) ON DELETE CASCADE,
    enabled        boolean NOT NULL DEFAULT true,
    install_command text NOT NULL DEFAULT 'npm ci --no-audit --no-fund',
    test_command   text NOT NULL DEFAULT 'npm test',
    image          text NOT NULL DEFAULT 'docker.io/library/node:22-bookworm',
    timeout_seconds integer NOT NULL DEFAULT 1800,
    cpus           integer NOT NULL DEFAULT 4,
    memory_mb      integer NOT NULL DEFAULT 6144,
    registered_by  text,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (timeout_seconds BETWEEN 30 AND 3600),
    CHECK (cpus BETWEEN 1 AND 8),
    CHECK (memory_mb BETWEEN 512 AND 12288),
    CHECK (char_length(install_command) BETWEEN 1 AND 2000),
    CHECK (char_length(test_command) BETWEEN 1 AND 2000),
    CHECK (char_length(image) BETWEEN 1 AND 200)
);

CREATE TABLE git_ci_runs (
    id             text PRIMARY KEY,                             -- cir_<ulid>
    repo_id        text NOT NULL REFERENCES git_repos (id) ON DELETE CASCADE,
    sha            text NOT NULL,
    branch         text NOT NULL,
    pusher         text,                                        -- the push event's pusher, or "runner" for a manual run
    source         text NOT NULL DEFAULT 'github',               -- github | forge | manual
    state          text NOT NULL CHECK (state IN ('queued', 'running', 'success', 'failure', 'error', 'timed_out', 'superseded')),
    description    text NOT NULL DEFAULT '',
    exit_code      integer,
    log            text NOT NULL DEFAULT '',
    log_bytes      integer NOT NULL DEFAULT 0,
    runner         text,
    started_at     timestamptz,
    finished_at    timestamptz,
    duration_ms    integer,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    CHECK (char_length(branch) BETWEEN 1 AND 255),
    CHECK (char_length(description) <= 1024),
    CHECK (char_length(log) <= 4194304)
);

CREATE INDEX git_ci_runs_repo_created ON git_ci_runs (repo_id, created_at DESC);
CREATE INDEX git_ci_runs_state_created ON git_ci_runs (state, created_at);
-- At most one queued or running run per repository; a new push supersedes the old one before this is inserted.
CREATE UNIQUE INDEX git_ci_runs_one_live ON git_ci_runs (repo_id) WHERE state IN ('queued', 'running');
