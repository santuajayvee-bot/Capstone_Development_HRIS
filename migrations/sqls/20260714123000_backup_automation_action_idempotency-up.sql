CREATE TABLE IF NOT EXISTS backup_automation_action_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  idempotency_key VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  request_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_type ENUM('SCHEDULE_RUN','RETENTION_UPDATE','RETENTION_RUN','DRILL_RUN') NOT NULL,
  resource_type VARCHAR(60) NOT NULL,
  resource_id BIGINT NOT NULL,
  status ENUM('IN_PROGRESS','COMPLETED','FAILED') NOT NULL DEFAULT 'IN_PROGRESS',
  operation_time DATETIME(6) NOT NULL,
  result_json LONGTEXT NULL,
  failure_code VARCHAR(80) NULL,
  requested_by INT NOT NULL,
  step_up_challenge_id BIGINT NOT NULL,
  completed_at DATETIME NULL,
  failed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT uq_backup_automation_action_idempotency UNIQUE (idempotency_key),
  INDEX idx_backup_automation_action_resource (resource_type, resource_id, created_at),
  INDEX idx_backup_automation_action_status (status, updated_at),
  INDEX idx_backup_automation_action_actor (requested_by, created_at),
  INDEX idx_backup_automation_action_challenge (step_up_challenge_id),
  CONSTRAINT fk_backup_automation_action_actor
    FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_backup_automation_action_challenge
    FOREIGN KEY (step_up_challenge_id) REFERENCES backup_step_up_challenges(id) ON DELETE RESTRICT,
  CONSTRAINT chk_backup_automation_action_identifiers
    CHECK (
      CHAR_LENGTH(idempotency_key) > 0
      AND CHAR_LENGTH(request_fingerprint) = 64
      AND CHAR_LENGTH(resource_type) > 0
    ),
  CONSTRAINT chk_backup_automation_action_completed
    CHECK (
      status <> 'COMPLETED'
      OR (result_json IS NOT NULL AND completed_at IS NOT NULL AND failed_at IS NULL)
    ),
  CONSTRAINT chk_backup_automation_action_failed
    CHECK (
      status <> 'FAILED'
      OR (failure_code IS NOT NULL AND failed_at IS NOT NULL AND completed_at IS NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE backup_retention_policies
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128) COLLATE utf8mb4_bin NULL AFTER policy_reference,
  ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER idempotency_key,
  ADD UNIQUE INDEX uq_backup_retention_idempotency (idempotency_key),
  ADD CONSTRAINT chk_backup_retention_request_fingerprint
    CHECK (request_fingerprint IS NULL OR CHAR_LENGTH(request_fingerprint) = 64);
