-- phase: expand
-- G3: Link's outbound relay. A "clone to my computer" request lives two minutes and carries only the state the page
-- shows; the clone URL's read token is kept in the process, never here. A published machine lists the repositories
-- under the root the person chose in Link, read-only; its token is stored only as a SHA-256 hash. Nothing here is a
-- write path to the machine.

CREATE TABLE git_clone_requests (
    id          text PRIMARY KEY,                            -- clr_<ULID>
    subject     text NOT NULL,                               -- usr_…: who may read the page's copy
    repo_id     text NOT NULL REFERENCES git_repos (id) ON DELETE CASCADE,
    repo_full   text NOT NULL,                               -- owner/name at the time of the request
    state       text NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'approved', 'cloning', 'done', 'refused', 'failed', 'expired')),
    token_hash  text NOT NULL,                               -- hex SHA-256 of the one-time Link token
    progress    jsonb,                                       -- {percent, line} while cloning
    path        text,                                        -- where Link put it, on done
    reason      text,                                        -- why it was refused or failed
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX git_clone_requests_subject ON git_clone_requests (subject, created_at DESC);

CREATE TABLE git_machines (
    id             text PRIMARY KEY,                         -- mch_<ULID>
    subject        text NOT NULL,                            -- the person who connected it
    owner_username text NOT NULL,                            -- the namespace on the page
    name           text NOT NULL,
    os             text,
    token_hash     text NOT NULL UNIQUE,
    repos          jsonb NOT NULL DEFAULT '[]'::jsonb,       -- [{name, branch, head, head_subject, updated_at}]
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz,
    offline_since  timestamptz
);
CREATE INDEX git_machines_subject ON git_machines (subject, created_at DESC);
