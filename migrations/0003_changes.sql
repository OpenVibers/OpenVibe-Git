-- phase: expand
-- G2 review metadata; git objects remain on disk. Community deliveries use an outbox.
ALTER TABLE git_repos ADD COLUMN review_model text;
CREATE TABLE git_changes (
 id text PRIMARY KEY, number bigserial UNIQUE, repo_id text NOT NULL REFERENCES git_repos(id),
 source_repo_id text NOT NULL REFERENCES git_repos(id), base_ref text NOT NULL, head_ref text NOT NULL,
 title text NOT NULL, body text NOT NULL DEFAULT '', author text NOT NULL,
 state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','merged')),
 head_sha text NOT NULL, diff_base_sha text, merge_sha text, thread_id text,
 created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz, branch_deleted_at timestamptz
);
CREATE INDEX git_changes_repo ON git_changes(repo_id, number DESC);
CREATE TABLE git_change_comments (
 id text PRIMARY KEY, change_id text NOT NULL REFERENCES git_changes(id), author text NOT NULL,
 head_sha text NOT NULL, path text NOT NULL, line integer NOT NULL, side text NOT NULL CHECK(side IN ('old','new')),
 message text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE git_change_reviews (
 change_id text NOT NULL REFERENCES git_changes(id), author text NOT NULL, head_sha text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(change_id,author,head_sha)
);
CREATE TABLE git_change_summaries (
 change_id text NOT NULL REFERENCES git_changes(id), head_sha text NOT NULL, model text NOT NULL,
 result jsonb NOT NULL, PRIMARY KEY(change_id,head_sha,model)
);
CREATE TABLE git_issues (
 id text PRIMARY KEY, number bigserial UNIQUE, repo_id text NOT NULL REFERENCES git_repos(id),
 title text NOT NULL, body text NOT NULL, author text NOT NULL, labels jsonb NOT NULL DEFAULT '[]',
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')), thread_id text,
 created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz
);
CREATE TABLE git_review_outbox (
 id text PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL,
 attempts integer NOT NULL DEFAULT 0, delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
