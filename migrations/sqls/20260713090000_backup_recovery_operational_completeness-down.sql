ALTER TABLE module_rollback_requests
  DROP CONSTRAINT chk_module_rollback_request_fingerprint,
  DROP COLUMN IF EXISTS request_fingerprint;

ALTER TABLE restore_jobs
  DROP CONSTRAINT chk_restore_jobs_request_fingerprint,
  DROP COLUMN IF EXISTS request_fingerprint;

ALTER TABLE backup_sets
  DROP CONSTRAINT chk_backup_sets_request_fingerprint,
  DROP COLUMN IF EXISTS request_fingerprint;

