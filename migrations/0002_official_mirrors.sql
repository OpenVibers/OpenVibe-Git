-- phase: expand
-- The official mirrors seed's own state (server/official.js): when it last finished and what it found.
-- The job is due-based: a row read at each tick decides whether it runs, so a deploy does not reset the
-- interval the way an in-process timer would.

CREATE TABLE git_official_state (
    id          text PRIMARY KEY,                    -- official-mirrors
    last_run_at timestamptz,
    last_result jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { listed, created, existing, failed, ok, error }
    updated_at  timestamptz NOT NULL DEFAULT now()
);
