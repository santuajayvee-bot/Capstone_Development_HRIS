CREATE TABLE IF NOT EXISTS backup_step_up_challenges (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  challenge_reference VARCHAR(80) COLLATE utf8mb4_bin NOT NULL,
  idempotency_key VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  user_id INT NOT NULL,
  employee_id BIGINT NULL,
  purpose VARCHAR(80) NOT NULL,
  resource_type VARCHAR(40) NOT NULL,
  resource_id BIGINT NOT NULL,
  challenge_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mfa_method VARCHAR(30) NOT NULL,
  status ENUM('PENDING','VERIFIED','CONSUMED','EXPIRED','FAILED') NOT NULL DEFAULT 'PENDING',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 5,
  expires_at DATETIME NOT NULL,
  last_attempt_at DATETIME NULL,
  verified_at DATETIME NULL,
  consumed_at DATETIME NULL,
  failed_at DATETIME NULL,
  request_ip_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  verified_ip_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  user_agent_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT uq_backup_step_up_reference UNIQUE (challenge_reference),
  CONSTRAINT uq_backup_step_up_idempotency UNIQUE (idempotency_key),
  CONSTRAINT uq_backup_step_up_token_hash UNIQUE (challenge_token_hash),
  INDEX idx_backup_step_up_user_status (user_id, status, created_at),
  INDEX idx_backup_step_up_employee (employee_id, created_at),
  INDEX idx_backup_step_up_resource (resource_type, resource_id, status),
  INDEX idx_backup_step_up_expiry (status, expires_at),
  CONSTRAINT fk_backup_step_up_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_backup_step_up_employee
    FOREIGN KEY (employee_id) REFERENCES employees(Employee_ID)
    ON DELETE SET NULL,
  CONSTRAINT chk_backup_step_up_attempts
    CHECK (attempt_count <= max_attempts),
  CONSTRAINT chk_backup_step_up_required_values
    CHECK (
      CHAR_LENGTH(challenge_reference) > 0
      AND CHAR_LENGTH(idempotency_key) > 0
      AND CHAR_LENGTH(purpose) > 0
      AND CHAR_LENGTH(resource_type) > 0
      AND CHAR_LENGTH(challenge_token_hash) = 64
      AND CHAR_LENGTH(mfa_method) > 0
      AND expires_at > created_at
    ),
  CONSTRAINT chk_backup_step_up_verified_evidence
    CHECK (status <> 'VERIFIED' OR verified_at IS NOT NULL),
  CONSTRAINT chk_backup_step_up_consumed_evidence
    CHECK (
      status <> 'CONSUMED'
      OR (verified_at IS NOT NULL AND consumed_at IS NOT NULL AND consumed_at >= verified_at)
    ),
  CONSTRAINT chk_backup_step_up_failed_evidence
    CHECK (status <> 'FAILED' OR failed_at IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE backup_sets
  MODIFY COLUMN created_by INT NOT NULL,
  MODIFY COLUMN status ENUM('PENDING','RUNNING','COMPLETED','FAILED','VERIFIED','RESTORED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128) COLLATE utf8mb4_bin NULL AFTER id,
  ADD COLUMN IF NOT EXISTS approval_status ENUM('NOT_REQUIRED','PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'NOT_REQUIRED' AFTER status,
  ADD COLUMN IF NOT EXISTS approved_by INT NULL AFTER approval_status,
  ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL AFTER approved_by,
  ADD COLUMN IF NOT EXISTS rejected_by INT NULL AFTER approved_at,
  ADD COLUMN IF NOT EXISTS rejected_at DATETIME NULL AFTER rejected_by,
  ADD COLUMN IF NOT EXISTS step_up_challenge_id BIGINT NULL AFTER rejected_at,
  ADD COLUMN IF NOT EXISTS step_up_verified_at DATETIME NULL AFTER step_up_challenge_id,
  ADD COLUMN IF NOT EXISTS artifact_format VARCHAR(80) NULL AFTER included_modules,
  ADD COLUMN IF NOT EXISTS checksum_algorithm VARCHAR(16) NOT NULL DEFAULT 'SHA256' AFTER checksum,
  ADD COLUMN IF NOT EXISTS verified_checksum CHAR(64) NULL AFTER checksum_algorithm,
  ADD COLUMN IF NOT EXISTS verification_status ENUM('NOT_VERIFIED','VERIFYING','MATCH','MISMATCH','ERROR') NOT NULL DEFAULT 'NOT_VERIFIED' AFTER verified_checksum,
  ADD COLUMN IF NOT EXISTS integrity_status ENUM('NOT_CHECKED','CHECKING','PASSED','FAILED','ERROR') NOT NULL DEFAULT 'NOT_CHECKED' AFTER verification_status,
  ADD COLUMN IF NOT EXISTS verified_by INT NULL AFTER integrity_status,
  ADD COLUMN IF NOT EXISTS adapter_metadata_encrypted LONGTEXT NULL AFTER storage_location_encrypted,
  ADD COLUMN IF NOT EXISTS started_at DATETIME NULL AFTER created_at,
  ADD COLUMN IF NOT EXISTS completed_at DATETIME NULL AFTER started_at,
  ADD COLUMN IF NOT EXISTS failed_at DATETIME NULL AFTER completed_at,
  ADD COLUMN IF NOT EXISTS cancelled_at DATETIME NULL AFTER failed_at,
  ADD COLUMN IF NOT EXISTS failure_message_encrypted TEXT NULL AFTER cancelled_at,
  ADD COLUMN IF NOT EXISTS attempt_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER failure_message_encrypted,
  ADD COLUMN IF NOT EXISTS worker_lease_token_hash CHAR(64) NULL AFTER attempt_count,
  ADD COLUMN IF NOT EXISTS worker_lease_expires_at DATETIME NULL AFTER worker_lease_token_hash,
  ADD COLUMN IF NOT EXISTS updated_by INT NULL AFTER updated_at;

UPDATE backup_sets
   SET idempotency_key = CONCAT('legacy-backup-', LPAD(id, 20, '0'))
 WHERE idempotency_key IS NULL;

ALTER TABLE backup_sets
  MODIFY COLUMN idempotency_key VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  ADD CONSTRAINT uq_backup_sets_idempotency UNIQUE (idempotency_key),
  ADD INDEX idx_backup_sets_approval (approval_status, created_at),
  ADD INDEX idx_backup_sets_lease (status, worker_lease_expires_at),
  ADD INDEX idx_backup_sets_step_up (step_up_challenge_id),
  ADD INDEX idx_backup_sets_updated_by (updated_by),
  ADD INDEX idx_backup_sets_approved_by (approved_by),
  ADD INDEX idx_backup_sets_rejected_by (rejected_by),
  ADD INDEX idx_backup_sets_verified_by (verified_by),
  ADD CONSTRAINT fk_backup_sets_created_by
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_backup_sets_updated_by
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_backup_sets_approved_by
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_backup_sets_rejected_by
    FOREIGN KEY (rejected_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_backup_sets_verified_by
    FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_backup_sets_step_up
    FOREIGN KEY (step_up_challenge_id) REFERENCES backup_step_up_challenges(id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_backup_sets_idempotency
    CHECK (CHAR_LENGTH(idempotency_key) > 0),
  ADD CONSTRAINT chk_backup_sets_artifact_size
    CHECK (file_size IS NULL OR file_size >= 0),
  ADD CONSTRAINT chk_backup_sets_verified_artifact
    CHECK (
      status <> 'VERIFIED'
      OR (
        checksum IS NOT NULL
        AND verified_checksum IS NOT NULL
        AND verified_checksum = checksum
        AND storage_location_encrypted IS NOT NULL
        AND verification_status = 'MATCH'
        AND integrity_status = 'PASSED'
        AND verified_at IS NOT NULL
        AND verified_by IS NOT NULL
        AND step_up_challenge_id IS NOT NULL
        AND step_up_verified_at IS NOT NULL
      )
    );

ALTER TABLE module_recovery_points
  MODIFY COLUMN created_by INT NOT NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128) COLLATE utf8mb4_bin NULL AFTER id,
  ADD COLUMN IF NOT EXISTS recovery_reference VARCHAR(80) COLLATE utf8mb4_bin NULL AFTER idempotency_key,
  ADD COLUMN IF NOT EXISTS status ENUM('PENDING','CREATING','AVAILABLE','FAILED','EXPIRED','REVOKED') NOT NULL DEFAULT 'PENDING' AFTER rollback_available,
  ADD COLUMN IF NOT EXISTS artifact_checksum CHAR(64) NULL AFTER artifact_location_encrypted,
  ADD COLUMN IF NOT EXISTS checksum_algorithm VARCHAR(16) NOT NULL DEFAULT 'SHA256' AFTER artifact_checksum,
  ADD COLUMN IF NOT EXISTS artifact_size_bytes BIGINT NULL AFTER checksum_algorithm,
  ADD COLUMN IF NOT EXISTS verification_status ENUM('NOT_VERIFIED','VERIFYING','MATCH','MISMATCH','ERROR') NOT NULL DEFAULT 'NOT_VERIFIED' AFTER artifact_size_bytes,
  ADD COLUMN IF NOT EXISTS integrity_status ENUM('NOT_CHECKED','CHECKING','PASSED','FAILED','ERROR') NOT NULL DEFAULT 'NOT_CHECKED' AFTER verification_status,
  ADD COLUMN IF NOT EXISTS verified_at DATETIME NULL AFTER integrity_status,
  ADD COLUMN IF NOT EXISTS expires_at DATETIME NULL AFTER verified_at,
  ADD COLUMN IF NOT EXISTS updated_by INT NULL AFTER created_by,
  ADD COLUMN IF NOT EXISTS updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at;

UPDATE module_recovery_points
   SET idempotency_key = CONCAT('legacy-recovery-', LPAD(id, 20, '0'))
 WHERE idempotency_key IS NULL;

UPDATE module_recovery_points
   SET recovery_reference = CONCAT('RECOVERY-LEGACY-', LPAD(id, 20, '0'))
 WHERE recovery_reference IS NULL;

ALTER TABLE module_recovery_points
  MODIFY COLUMN idempotency_key VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  MODIFY COLUMN recovery_reference VARCHAR(80) COLLATE utf8mb4_bin NOT NULL,
  ADD CONSTRAINT uq_module_recovery_idempotency UNIQUE (idempotency_key),
  ADD CONSTRAINT uq_module_recovery_reference UNIQUE (recovery_reference),
  ADD INDEX idx_module_recovery_status (status, created_at),
  ADD INDEX idx_module_recovery_integrity (integrity_status, verified_at),
  ADD INDEX idx_module_recovery_created_by (created_by),
  ADD INDEX idx_module_recovery_updated_by (updated_by),
  ADD CONSTRAINT fk_module_recovery_backup_set
    FOREIGN KEY (backup_set_id) REFERENCES backup_sets(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_module_recovery_created_by
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_module_recovery_updated_by
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT chk_module_recovery_artifact_size
    CHECK (artifact_size_bytes IS NULL OR artifact_size_bytes >= 0),
  ADD CONSTRAINT chk_module_recovery_identifiers
    CHECK (CHAR_LENGTH(idempotency_key) > 0 AND CHAR_LENGTH(recovery_reference) > 0),
  ADD CONSTRAINT chk_module_recovery_available_evidence
    CHECK (
      status <> 'AVAILABLE'
      OR (
        backup_set_id IS NOT NULL
        AND artifact_location_encrypted IS NOT NULL
        AND artifact_checksum IS NOT NULL
        AND verification_status = 'MATCH'
        AND integrity_status = 'PASSED'
        AND verified_at IS NOT NULL
      )
    );

ALTER TABLE restore_jobs
  MODIFY COLUMN requested_by INT NOT NULL,
  MODIFY COLUMN approved_by INT NULL,
  MODIFY COLUMN status ENUM('PENDING','AWAITING_APPROVAL','APPROVED','REJECTED','DRY_RUN_IN_PROGRESS','DRY_RUN_PASSED','IN_PROGRESS','VERIFYING','COMPLETED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128) COLLATE utf8mb4_bin NULL AFTER id,
  ADD COLUMN IF NOT EXISTS approval_status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING' AFTER status,
  ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL AFTER approved_by,
  ADD COLUMN IF NOT EXISTS rejected_by INT NULL AFTER approved_at,
  ADD COLUMN IF NOT EXISTS rejected_at DATETIME NULL AFTER rejected_by,
  ADD COLUMN IF NOT EXISTS approval_notes_encrypted TEXT NULL AFTER rejected_at,
  ADD COLUMN IF NOT EXISTS step_up_challenge_id BIGINT NULL AFTER approval_notes_encrypted,
  ADD COLUMN IF NOT EXISTS step_up_verified_at DATETIME NULL AFTER step_up_challenge_id,
  ADD COLUMN IF NOT EXISTS dry_run_status ENUM('NOT_STARTED','RUNNING','PASSED','FAILED') NOT NULL DEFAULT 'NOT_STARTED' AFTER step_up_verified_at,
  ADD COLUMN IF NOT EXISTS dry_run_started_at DATETIME NULL AFTER dry_run_status,
  ADD COLUMN IF NOT EXISTS dry_run_completed_at DATETIME NULL AFTER dry_run_started_at,
  ADD COLUMN IF NOT EXISTS dry_run_target_encrypted TEXT NULL AFTER dry_run_completed_at,
  ADD COLUMN IF NOT EXISTS dry_run_result_encrypted LONGTEXT NULL AFTER dry_run_target_encrypted,
  ADD COLUMN IF NOT EXISTS integrity_status ENUM('NOT_CHECKED','CHECKING','PASSED','FAILED','ERROR') NOT NULL DEFAULT 'NOT_CHECKED' AFTER dry_run_result_encrypted,
  ADD COLUMN IF NOT EXISTS integrity_checked_at DATETIME NULL AFTER integrity_status,
  ADD COLUMN IF NOT EXISTS integrity_report_encrypted LONGTEXT NULL AFTER integrity_checked_at,
  ADD COLUMN IF NOT EXISTS expected_checksum CHAR(64) NULL AFTER integrity_report_encrypted,
  ADD COLUMN IF NOT EXISTS restored_checksum CHAR(64) NULL AFTER expected_checksum,
  ADD COLUMN IF NOT EXISTS restore_target_encrypted TEXT NULL AFTER restored_checksum,
  ADD COLUMN IF NOT EXISTS failed_at DATETIME NULL AFTER completed_at,
  ADD COLUMN IF NOT EXISTS cancelled_at DATETIME NULL AFTER failed_at,
  ADD COLUMN IF NOT EXISTS failure_message_encrypted TEXT NULL AFTER cancelled_at,
  ADD COLUMN IF NOT EXISTS attempt_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER failure_message_encrypted,
  ADD COLUMN IF NOT EXISTS worker_lease_token_hash CHAR(64) NULL AFTER attempt_count,
  ADD COLUMN IF NOT EXISTS worker_lease_expires_at DATETIME NULL AFTER worker_lease_token_hash,
  ADD COLUMN IF NOT EXISTS updated_by INT NULL AFTER updated_at;

UPDATE restore_jobs
   SET idempotency_key = CONCAT('legacy-restore-', LPAD(id, 20, '0')),
       approval_status = CASE WHEN approved_by IS NULL THEN 'PENDING' ELSE 'APPROVED' END,
       approved_at = CASE
         WHEN approved_by IS NULL THEN NULL
         ELSE COALESCE(approved_at, started_at, created_at)
       END
 WHERE idempotency_key IS NULL;

ALTER TABLE restore_jobs
  MODIFY COLUMN idempotency_key VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  ADD CONSTRAINT uq_restore_jobs_idempotency UNIQUE (idempotency_key),
  ADD INDEX idx_restore_jobs_approval (approval_status, created_at),
  ADD INDEX idx_restore_jobs_dry_run (dry_run_status, created_at),
  ADD INDEX idx_restore_jobs_integrity (integrity_status, created_at),
  ADD INDEX idx_restore_jobs_lease (status, worker_lease_expires_at),
  ADD INDEX idx_restore_jobs_step_up (step_up_challenge_id),
  ADD INDEX idx_restore_jobs_requested_by (requested_by),
  ADD INDEX idx_restore_jobs_approved_by (approved_by),
  ADD INDEX idx_restore_jobs_rejected_by (rejected_by),
  ADD INDEX idx_restore_jobs_updated_by (updated_by),
  ADD CONSTRAINT fk_restore_jobs_backup_set
    FOREIGN KEY (backup_set_id) REFERENCES backup_sets(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_restore_jobs_requested_by
    FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_restore_jobs_approved_by
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_restore_jobs_rejected_by
    FOREIGN KEY (rejected_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_restore_jobs_updated_by
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_restore_jobs_step_up
    FOREIGN KEY (step_up_challenge_id) REFERENCES backup_step_up_challenges(id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_restore_jobs_idempotency
    CHECK (CHAR_LENGTH(idempotency_key) > 0),
  ADD CONSTRAINT chk_restore_jobs_approval_evidence
    CHECK (
      approval_status <> 'APPROVED'
      OR (
        approved_by IS NOT NULL
        AND approved_at IS NOT NULL
        AND step_up_challenge_id IS NOT NULL
        AND step_up_verified_at IS NOT NULL
      )
    ),
  ADD CONSTRAINT chk_restore_jobs_completed_evidence
    CHECK (
      status <> 'COMPLETED'
      OR (
        approval_status = 'APPROVED'
        AND step_up_challenge_id IS NOT NULL
        AND step_up_verified_at IS NOT NULL
        AND dry_run_status = 'PASSED'
        AND dry_run_completed_at IS NOT NULL
        AND integrity_status = 'PASSED'
        AND integrity_checked_at IS NOT NULL
        AND expected_checksum IS NOT NULL
        AND restored_checksum = expected_checksum
        AND started_at IS NOT NULL
        AND completed_at IS NOT NULL
      )
    );

ALTER TABLE module_rollback_requests
  MODIFY COLUMN requested_by INT NOT NULL,
  MODIFY COLUMN approved_by INT NULL,
  MODIFY COLUMN status ENUM('PENDING','AWAITING_APPROVAL','APPROVED','REJECTED','IN_PROGRESS','VERIFYING','COMPLETED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128) COLLATE utf8mb4_bin NULL AFTER id,
  ADD COLUMN IF NOT EXISTS recovery_point_id BIGINT NULL AFTER idempotency_key,
  ADD COLUMN IF NOT EXISTS approval_status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING' AFTER status,
  ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL AFTER approved_by,
  ADD COLUMN IF NOT EXISTS rejected_by INT NULL AFTER approved_at,
  ADD COLUMN IF NOT EXISTS rejected_at DATETIME NULL AFTER rejected_by,
  ADD COLUMN IF NOT EXISTS approval_notes_encrypted TEXT NULL AFTER rejected_at,
  ADD COLUMN IF NOT EXISTS step_up_challenge_id BIGINT NULL AFTER approval_notes_encrypted,
  ADD COLUMN IF NOT EXISTS step_up_verified_at DATETIME NULL AFTER step_up_challenge_id,
  ADD COLUMN IF NOT EXISTS artifact_checksum CHAR(64) NULL AFTER artifact_location_encrypted,
  ADD COLUMN IF NOT EXISTS checksum_algorithm VARCHAR(16) NOT NULL DEFAULT 'SHA256' AFTER artifact_checksum,
  ADD COLUMN IF NOT EXISTS verification_status ENUM('NOT_VERIFIED','VERIFYING','MATCH','MISMATCH','ERROR') NOT NULL DEFAULT 'NOT_VERIFIED' AFTER checksum_algorithm,
  ADD COLUMN IF NOT EXISTS integrity_status ENUM('NOT_CHECKED','CHECKING','PASSED','FAILED','ERROR') NOT NULL DEFAULT 'NOT_CHECKED' AFTER verification_status,
  ADD COLUMN IF NOT EXISTS integrity_checked_at DATETIME NULL AFTER integrity_status,
  ADD COLUMN IF NOT EXISTS integrity_report_encrypted LONGTEXT NULL AFTER integrity_checked_at,
  ADD COLUMN IF NOT EXISTS started_at DATETIME NULL AFTER created_at,
  ADD COLUMN IF NOT EXISTS updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER started_at,
  ADD COLUMN IF NOT EXISTS failed_at DATETIME NULL AFTER completed_at,
  ADD COLUMN IF NOT EXISTS cancelled_at DATETIME NULL AFTER failed_at,
  ADD COLUMN IF NOT EXISTS failure_message_encrypted TEXT NULL AFTER cancelled_at,
  ADD COLUMN IF NOT EXISTS attempt_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER failure_message_encrypted,
  ADD COLUMN IF NOT EXISTS worker_lease_token_hash CHAR(64) NULL AFTER attempt_count,
  ADD COLUMN IF NOT EXISTS worker_lease_expires_at DATETIME NULL AFTER worker_lease_token_hash,
  ADD COLUMN IF NOT EXISTS updated_by INT NULL AFTER updated_at;

UPDATE module_rollback_requests
   SET idempotency_key = CONCAT('legacy-rollback-', LPAD(id, 20, '0')),
       approval_status = CASE WHEN approved_by IS NULL THEN 'PENDING' ELSE 'APPROVED' END,
       approved_at = CASE
         WHEN approved_by IS NULL THEN NULL
         ELSE COALESCE(approved_at, created_at)
       END
 WHERE idempotency_key IS NULL;

ALTER TABLE module_rollback_requests
  MODIFY COLUMN idempotency_key VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  ADD CONSTRAINT uq_module_rollback_idempotency UNIQUE (idempotency_key),
  ADD INDEX idx_module_rollback_recovery (recovery_point_id),
  ADD INDEX idx_module_rollback_approval (approval_status, created_at),
  ADD INDEX idx_module_rollback_integrity (integrity_status, created_at),
  ADD INDEX idx_module_rollback_lease (status, worker_lease_expires_at),
  ADD INDEX idx_module_rollback_step_up (step_up_challenge_id),
  ADD INDEX idx_module_rollback_approved_by (approved_by),
  ADD INDEX idx_module_rollback_rejected_by (rejected_by),
  ADD INDEX idx_module_rollback_updated_by (updated_by),
  ADD CONSTRAINT fk_module_rollback_recovery
    FOREIGN KEY (recovery_point_id) REFERENCES module_recovery_points(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_module_rollback_requested_by
    FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_module_rollback_approved_by
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_module_rollback_rejected_by
    FOREIGN KEY (rejected_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_module_rollback_updated_by
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_module_rollback_step_up
    FOREIGN KEY (step_up_challenge_id) REFERENCES backup_step_up_challenges(id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_module_rollback_idempotency
    CHECK (CHAR_LENGTH(idempotency_key) > 0),
  ADD CONSTRAINT chk_module_rollback_versions
    CHECK (current_version IS NULL OR target_version IS NULL OR current_version <> target_version),
  ADD CONSTRAINT chk_module_rollback_approval_evidence
    CHECK (
      approval_status <> 'APPROVED'
      OR (
        approved_by IS NOT NULL
        AND approved_at IS NOT NULL
        AND step_up_challenge_id IS NOT NULL
        AND step_up_verified_at IS NOT NULL
      )
    ),
  ADD CONSTRAINT chk_module_rollback_completed_evidence
    CHECK (
      status <> 'COMPLETED'
      OR (
        recovery_point_id IS NOT NULL
        AND approval_status = 'APPROVED'
        AND step_up_challenge_id IS NOT NULL
        AND step_up_verified_at IS NOT NULL
        AND artifact_location_encrypted IS NOT NULL
        AND artifact_checksum IS NOT NULL
        AND verification_status = 'MATCH'
        AND integrity_status = 'PASSED'
        AND integrity_checked_at IS NOT NULL
        AND started_at IS NOT NULL
        AND completed_at IS NOT NULL
      )
    );
