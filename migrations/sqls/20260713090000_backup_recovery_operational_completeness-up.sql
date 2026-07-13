ALTER TABLE backup_sets
  ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER idempotency_key;

UPDATE backup_sets
   SET request_fingerprint = SHA2(CONCAT('legacy-backup|', id), 256)
 WHERE request_fingerprint IS NULL;

ALTER TABLE backup_sets
  MODIFY COLUMN request_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ADD CONSTRAINT chk_backup_sets_request_fingerprint
    CHECK (CHAR_LENGTH(request_fingerprint) = 64);

ALTER TABLE restore_jobs
  ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER idempotency_key;

UPDATE restore_jobs
   SET request_fingerprint = SHA2(CONCAT('legacy-restore|', id), 256)
 WHERE request_fingerprint IS NULL;

ALTER TABLE restore_jobs
  MODIFY COLUMN request_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ADD CONSTRAINT chk_restore_jobs_request_fingerprint
    CHECK (CHAR_LENGTH(request_fingerprint) = 64);

ALTER TABLE module_rollback_requests
  ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER idempotency_key;

UPDATE module_rollback_requests
   SET request_fingerprint = SHA2(CONCAT('legacy-rollback|', id), 256)
 WHERE request_fingerprint IS NULL;

ALTER TABLE module_rollback_requests
  MODIFY COLUMN request_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ADD CONSTRAINT chk_module_rollback_request_fingerprint
    CHECK (CHAR_LENGTH(request_fingerprint) = 64);

