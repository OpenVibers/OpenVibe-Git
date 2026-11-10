-- phase: expand
-- G3, step 3: a "clone to my computer" request can be addressed to one of the person's own Link computers, so the
-- page knows where the request went and the computer's own approval is the only way it starts. Two steps come
-- before the clone: queued (on its way over the machine's watch) and waiting (the computer has it and is asking).

ALTER TABLE git_clone_requests ADD COLUMN machine_id text;
ALTER TABLE git_clone_requests DROP CONSTRAINT IF EXISTS git_clone_requests_state_check;
ALTER TABLE git_clone_requests ADD CONSTRAINT git_clone_requests_state_check
    CHECK (state IN ('queued', 'waiting', 'pending', 'approved', 'cloning', 'done', 'refused', 'failed', 'expired'));
CREATE INDEX git_clone_requests_machine ON git_clone_requests (machine_id) WHERE machine_id IS NOT NULL;
