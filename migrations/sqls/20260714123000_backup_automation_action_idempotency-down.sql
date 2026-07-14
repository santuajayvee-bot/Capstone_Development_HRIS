DROP TABLE IF EXISTS backup_automation_action_requests;

ALTER TABLE backup_retention_policies
  DROP CONSTRAINT chk_backup_retention_request_fingerprint,
  DROP INDEX uq_backup_retention_idempotency,
  DROP COLUMN request_fingerprint,
  DROP COLUMN idempotency_key;
