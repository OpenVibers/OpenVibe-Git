-- phase: expand
-- Immutable npm versions for the four official OpenVibe libraries. The existing
-- forge runner credential may publish; reads and tarballs are public.
CREATE TABLE git_npm_versions (
    owner text NOT NULL,
    name text NOT NULL,
    version text NOT NULL,
    manifest jsonb NOT NULL,
    tarball bytea NOT NULL,
    integrity text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, name, version)
);
CREATE TABLE git_npm_tags (
    owner text NOT NULL,
    name text NOT NULL,
    tag text NOT NULL,
    version text NOT NULL,
    PRIMARY KEY (owner, name, tag),
    FOREIGN KEY (owner, name, version) REFERENCES git_npm_versions (owner, name, version)
);
