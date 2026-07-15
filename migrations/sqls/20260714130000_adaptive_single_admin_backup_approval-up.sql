-- The fixed one-System-Administrator workflow intentionally allows the same
-- authenticated administrator to verify and approve. MFA/evidence/idempotency/
-- integrity constraints remain enforced; only unconditional different-user
-- checks are removed.
ALTER TABLE backup_sets
  DROP CONSTRAINT chk_backup_sets_maker_checker;

ALTER TABLE restore_jobs
  DROP CONSTRAINT chk_restore_jobs_maker_checker;

ALTER TABLE module_rollback_requests
  DROP CONSTRAINT chk_module_rollback_maker_checker;
