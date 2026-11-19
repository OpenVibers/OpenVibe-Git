-- phase: expand
-- Forge CI: the tree each run tested (2026-11-19). A push whose files are exactly those of a run that already passed
-- (a pull request merged onto an unmoved main, a branch made from a tested commit) is answered from that run instead of
-- testing the same files again. Runs made before this have no tree and are simply never matched.
ALTER TABLE git_ci_runs ADD COLUMN tree text;
ALTER TABLE git_ci_runs ADD CONSTRAINT git_ci_runs_tree_hex CHECK (tree IS NULL OR tree ~ '^[0-9a-f]{40}([0-9a-f]{24})?$');
CREATE INDEX git_ci_runs_repo_tree_passed ON git_ci_runs (repo_id, tree) WHERE state = 'success' AND tree IS NOT NULL;
