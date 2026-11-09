-- phase: expand
-- OpenVibe.Git (git.openvibe.codes), G1: repositories, their GitHub mirrors, stars and watches, clone tokens,
-- views and clones for insights, releases, the activity feed and the audit log.
--
-- Nothing here is a git object: the commits, trees and blobs live in the bare repositories on disk
-- (DATA_DIR/repos/<owner>/<name>.git). A clone token is stored only as a SHA-256 hash of 32 random bytes; a
-- push-mirror token is stored sealed (AES-256-GCM) and is never shown again.

CREATE TABLE git_repos (
    id                     text PRIMARY KEY,                 -- repo_<ulid>
    owner_username         text NOT NULL,                    -- lower-case OpenVibe username
    owner_subject          text,                             -- usr_…; NULL for the organisation account
    name                   text NOT NULL,                    -- lower-case, never ending in .git
    description            text NOT NULL DEFAULT '',
    visibility             text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
    default_branch         text NOT NULL DEFAULT 'main',
    topics                 jsonb NOT NULL DEFAULT '[]'::jsonb,
    language               text,
    languages              jsonb NOT NULL DEFAULT '{}'::jsonb,
    official               boolean NOT NULL DEFAULT false,
    github_full_name       text,                             -- OpenVibers/OpenVibe.Codes when it has a twin
    mirror_url             text,                             -- https://github.com/<owner>/<name>.git
    mirror_state           text NOT NULL DEFAULT 'ready' CHECK (mirror_state IN ('ready', 'syncing', 'error')),
    mirror_last_synced_at  timestamptz,
    mirror_error           text,
    push_mirror_url        text,
    push_mirror_token      text,                             -- sealed: v1.<iv>.<tag>.<ciphertext>, never logged
    push_mirror_state      text NOT NULL DEFAULT 'off' CHECK (push_mirror_state IN ('off', 'on', 'error')),
    fork_of                text,                             -- the repository this one was forked from
    created_by_subject     text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    pushed_at              timestamptz,
    UNIQUE (owner_username, name)
);
CREATE INDEX git_repos_public ON git_repos (visibility, pushed_at DESC);
CREATE INDEX git_repos_mirror ON git_repos (mirror_url) WHERE mirror_url IS NOT NULL;

CREATE TABLE git_stars (
    repo_id     text NOT NULL REFERENCES git_repos (id) ON DELETE CASCADE,
    subject     text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (repo_id, subject)
);
CREATE INDEX git_stars_subject ON git_stars (subject, created_at DESC);

CREATE TABLE git_watches (
    repo_id     text NOT NULL REFERENCES git_repos (id) ON DELETE CASCADE,
    subject     text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (repo_id, subject)
);

CREATE TABLE git_tokens (
    id           text PRIMARY KEY,                           -- tok_<ulid>
    subject      text NOT NULL,                              -- usr_… or svc:<name>
    actor_type   text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'service')),
    label        text,
    token_hash   text NOT NULL UNIQUE,                       -- hex SHA-256 of the token
    scopes       jsonb NOT NULL DEFAULT '[]'::jsonb,         -- ["git.read"] / ["git.read","git.write"]
    expires_at   timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at   timestamptz
);
CREATE INDEX git_tokens_subject ON git_tokens (subject, created_at DESC);

CREATE TABLE git_views (
    repo_id      text NOT NULL REFERENCES git_repos (id) ON DELETE CASCADE,
    day          date NOT NULL,
    visitor_hash text NOT NULL,                              -- sha256(ip + user agent + day), first 32 hex
    views        integer NOT NULL DEFAULT 1,
    PRIMARY KEY (repo_id, day, visitor_hash)
);
CREATE INDEX git_views_day ON git_views (repo_id, day);

CREATE TABLE git_clones (
    repo_id      text NOT NULL REFERENCES git_repos (id) ON DELETE CASCADE,
    day          date NOT NULL,
    subject_hash text NOT NULL,                              -- sha256(subject or address + day), first 32 hex
    count        integer NOT NULL DEFAULT 1,
    PRIMARY KEY (repo_id, day, subject_hash)
);
CREATE INDEX git_clones_day ON git_clones (repo_id, day);

CREATE TABLE git_releases (
    id             text PRIMARY KEY,                         -- rel_<ulid>
    repo_id        text NOT NULL REFERENCES git_repos (id) ON DELETE CASCADE,
    tag            text NOT NULL,
    name           text NOT NULL DEFAULT '',
    body           text NOT NULL DEFAULT '',
    author_subject text,
    published_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (repo_id, tag)
);

CREATE TABLE git_events (
    id             text PRIMARY KEY,                         -- evt_<ulid>
    repo_id        text REFERENCES git_repos (id) ON DELETE CASCADE,
    type           text NOT NULL CHECK (type IN ('push', 'create', 'release', 'star', 'fork', 'mirror')),
    actor_subject  text,
    actor_username text,
    detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
    at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX git_events_recent ON git_events (at DESC);

CREATE TABLE git_audit (
    id            bigserial PRIMARY KEY,
    at            timestamptz NOT NULL DEFAULT now(),
    actor_subject text,
    action        text NOT NULL,
    repo_id       text REFERENCES git_repos (id) ON DELETE SET NULL,
    detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
    address       text                                       -- the client address, never a token
);
CREATE INDEX git_audit_recent ON git_audit (at DESC);
