-- phase: expand
-- A mirror's card can be made without GitHub's REST metadata: the clone needs no quota, so when the API answers
-- 403/429 the mirror is created and marked 'pending'; a later official-mirrors run fills the description, topics
-- and default branch when the quota is back. 'ready' is every mirror whose metadata was read.

ALTER TABLE git_repos ADD COLUMN mirror_meta_state text NOT NULL DEFAULT 'ready'
    CHECK (mirror_meta_state IN ('ready', 'pending'));
