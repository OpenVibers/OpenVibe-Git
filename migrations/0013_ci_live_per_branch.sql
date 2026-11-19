-- phase: expand
-- Forge CI: one live run per branch, not per repository (2026-11-19). With every repository on the shared node's
-- runner, two open pull requests in one repository (a pin bump and a fix) superseded each other's runs, so only the
-- later push ever got a verdict. A newer push still supersedes the queued or running run of its own branch.
-- Relaxing the index is safe for the previous release: it supersedes per repository before inserting, which never
-- leaves two live runs on one branch.
DROP INDEX IF EXISTS git_ci_runs_one_live;
CREATE UNIQUE INDEX git_ci_runs_one_live_branch ON git_ci_runs (repo_id, branch) WHERE state IN ('queued', 'running');
