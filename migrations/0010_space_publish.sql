-- phase: expand
-- Publishing on OpenVibe.Space (plan §AD.10 step 2, 2026-11-15): a repository's branch and folder deployed to one of
-- its owner's Space sites on every push, as that person (server/space-publish.js). Git holds no Space credential: it
-- asks Network for its own service token (space.deploy.create) and names the owner in X-OV-Subject; Space checks the
-- site is theirs and its source is this repository and branch. The last_* columns are what the repository page shows.
CREATE TABLE git_space_publish (
    repo_id         text PRIMARY KEY REFERENCES git_repos (id) ON DELETE CASCADE,
    site_id         text NOT NULL,                    -- sit_… (OpenVibe.Space)
    branch          text NOT NULL,
    folder          text NOT NULL DEFAULT '',         -- '' = the whole repository
    set_by          text,                             -- usr_… who chose it (the owner)
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    last_sha        text,
    last_state      text,                             -- deployed | failed | off
    last_detail     text,
    last_deploy_id  text,                             -- dpl_… on Space
    last_url        text,
    last_at         timestamptz
);
