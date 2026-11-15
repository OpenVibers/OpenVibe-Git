-- phase: expand
-- GitHub, linked once (plan §AD.10 step 3): a person keeps one GitHub token here instead of one per repository. A push
-- mirror with no token of its own pushes with its owner's linked token (server/mirror.js). The token is sealed at rest
-- like a repository's (server/crypto.js, AES-256-GCM, the key from GIT_SECRET_KEY), never logged and never shown; the
-- login is what GitHub answered for it, so the page can say which account is linked.
CREATE TABLE git_github_links (
    subject     text PRIMARY KEY,                     -- usr_… (OpenVibe.Network)
    login       text NOT NULL,                        -- the GitHub account the token belongs to
    token       text NOT NULL,                        -- sealed
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
