-- Re-enable the historical unconditional different-user policy.
-- This intentionally fails safely if same-admin evidence was created while
-- the fixed single-admin workflow was active, rather than discarding evidence.
ALTER TABLE backup_sets
  ADD CONSTRAINT chk_backup_sets_maker_checker
    CHECK (
      (approved_by IS NULL OR approved_by <> created_by)
      AND (verified_by IS NULL OR verified_by <> created_by)
    );

ALTER TABLE restore_jobs
  ADD CONSTRAINT chk_restore_jobs_maker_checker
    CHECK (approved_by IS NULL OR approved_by <> requested_by);

ALTER TABLE module_rollback_requests
  ADD CONSTRAINT chk_module_rollback_maker_checker
    CHECK (approved_by IS NULL OR approved_by <> requested_by);
