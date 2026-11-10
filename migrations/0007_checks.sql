-- phase: expand
-- Commit statuses (checks): what CI says about a commit, who requires it, and what the GitHub intake copied.
--
-- A status is one CI verdict on one commit: {context, state, description, target_url}. History is kept (one row
-- per report); reads take the latest row per context. A repository names the contexts that must be green before
-- a change merges (required_checks, empty by default, so nothing changes until one is set). The intake remembers
-- the heads it already copied per repository, so it only asks GitHub about heads that moved.

CREATE TABLE git_commit_statuses (
    id              text PRIMARY KEY,                            -- cst_<ulid>
    repo_id         text NOT NULL REFERENCES git_repos (id) ON DELETE CASCADE,
    sha             text NOT NULL,                               -- the full commit id, lower-case hex
    context         text NOT NULL,                               -- e.g. "test", "security/secrets"
    state           text NOT NULL CHECK (state IN ('pending', 'success', 'failure', 'error')),
    description     text NOT NULL DEFAULT '',
    target_url      text NOT NULL DEFAULT '',
    creator_subject text,                                        -- svc:<service> or usr_… that reported it
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    CHECK (char_length(context) BETWEEN 1 AND 255),
    CHECK (char_length(description) <= 1024),
    CHECK (char_length(target_url) <= 2048)
);
CREATE INDEX git_commit_statuses_repo_sha ON git_commit_statuses (repo_id, sha, created_at DESC);

ALTER TABLE git_repos ADD COLUMN required_checks jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE git_checks_sync (
    repo_id      text PRIMARY KEY REFERENCES git_repos (id) ON DELETE CASCADE,
    last_run_at  timestamptz,
    heads        jsonb NOT NULL DEFAULT '{}'::jsonb,            -- {"main": "<sha>", "pr/12": "<sha>"}
    last_result  jsonb,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
