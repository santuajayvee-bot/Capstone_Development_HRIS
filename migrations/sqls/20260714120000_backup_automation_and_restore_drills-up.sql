CREATE TABLE IF NOT EXISTS backup_retention_policies (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  policy_reference VARCHAR(80) COLLATE utf8mb4_bin NOT NULL,
  policy_name VARCHAR(160) NOT NULL,
  backup_type ENUM('DATABASE','FILES','CONFIGURATION','MODULE_STATE','DEPLOYMENT_VERSION','FULL_BACKUP') NULL,
  storage_provider ENUM('LOCAL','S3','RDS_SNAPSHOT') NULL,
  keep_last INT UNSIGNED NOT NULL DEFAULT 10,
  max_age_days INT UNSIGNED NOT NULL DEFAULT 30,
  delete_expired_artifacts BOOLEAN NOT NULL DEFAULT TRUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INT NOT NULL,
  updated_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT uq_backup_retention_policy_reference UNIQUE (policy_reference),
  INDEX idx_backup_retention_scope (enabled, backup_type, storage_provider),
  INDEX idx_backup_retention_created_by (created_by),
  INDEX idx_backup_retention_updated_by (updated_by),
  CONSTRAINT fk_backup_retention_created_by
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_backup_retention_updated_by
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_backup_retention_identifiers
    CHECK (CHAR_LENGTH(policy_reference) > 0 AND CHAR_LENGTH(policy_name) > 0),
  CONSTRAINT chk_backup_retention_limits
    CHECK (keep_last >= 1 AND max_age_days >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS backup_schedules (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  schedule_reference VARCHAR(80) COLLATE utf8mb4_bin NOT NULL,
  idempotency_key VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  request_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(160) NOT NULL,
  backup_type ENUM('DATABASE','FILES','CONFIGURATION','MODULE_STATE','DEPLOYMENT_VERSION','FULL_BACKUP') NOT NULL,
  storage_provider ENUM('LOCAL','S3','RDS_SNAPSHOT') NOT NULL,
  included_modules LONGTEXT NULL,
  frequency ENUM('HOURLY','DAILY','WEEKLY','MONTHLY') NOT NULL,
  run_time TIME NULL,
  day_of_week TINYINT UNSIGNED NULL COMMENT 'ISO weekday: 1=Monday through 7=Sunday',
  day_of_month TINYINT UNSIGNED NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Manila',
  next_run_at DATETIME NULL,
  last_run_at DATETIME NULL,
  last_status ENUM('NEVER','QUEUED','RUNNING','SUCCESS','FAILED','SKIPPED') NOT NULL DEFAULT 'NEVER',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  retention_policy_id BIGINT NULL,
  created_by INT NOT NULL,
  updated_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT uq_backup_schedule_reference UNIQUE (schedule_reference),
  CONSTRAINT uq_backup_schedule_idempotency UNIQUE (idempotency_key),
  INDEX idx_backup_schedule_due (enabled, next_run_at),
  INDEX idx_backup_schedule_scope (backup_type, storage_provider, enabled),
  INDEX idx_backup_schedule_retention (retention_policy_id),
  INDEX idx_backup_schedule_created_by (created_by),
  INDEX idx_backup_schedule_updated_by (updated_by),
  CONSTRAINT fk_backup_schedule_retention
    FOREIGN KEY (retention_policy_id) REFERENCES backup_retention_policies(id) ON DELETE SET NULL,
  CONSTRAINT fk_backup_schedule_created_by
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_backup_schedule_updated_by
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_backup_schedule_identifiers
    CHECK (
      CHAR_LENGTH(schedule_reference) > 0
      AND CHAR_LENGTH(idempotency_key) > 0
      AND CHAR_LENGTH(request_fingerprint) = 64
      AND CHAR_LENGTH(name) > 0
      AND CHAR_LENGTH(timezone) > 0
    ),
  CONSTRAINT chk_backup_schedule_modules_json
    CHECK (included_modules IS NULL OR JSON_VALID(included_modules)),
  CONSTRAINT chk_backup_schedule_day_of_week
    CHECK (
      (frequency = 'WEEKLY' AND day_of_week BETWEEN 1 AND 7)
      OR (frequency <> 'WEEKLY' AND day_of_week IS NULL)
    ),
  CONSTRAINT chk_backup_schedule_day_of_month
    CHECK (
      (frequency = 'MONTHLY' AND day_of_month BETWEEN 1 AND 31)
      OR (frequency <> 'MONTHLY' AND day_of_month IS NULL)
    ),
  CONSTRAINT chk_backup_schedule_enabled_timing
    CHECK (
      enabled = FALSE
      OR (
        next_run_at IS NOT NULL
        AND (frequency = 'HOURLY' OR run_time IS NOT NULL)
      )
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS backup_action_notifications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  dedupe_key VARCHAR(160) COLLATE utf8mb4_bin NOT NULL,
  recipient_user_id INT NOT NULL,
  category VARCHAR(80) NOT NULL,
  resource_type VARCHAR(60) NOT NULL,
  resource_id BIGINT NOT NULL,
  action_required BOOLEAN NOT NULL DEFAULT TRUE,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  status ENUM('UNREAD','READ','RESOLVED') NOT NULL DEFAULT 'UNREAD',
  read_at DATETIME NULL,
  resolved_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT uq_backup_action_notification_dedupe UNIQUE (dedupe_key),
  INDEX idx_backup_notification_inbox (recipient_user_id, status, action_required, created_at),
  INDEX idx_backup_notification_resource (resource_type, resource_id, status),
  CONSTRAINT fk_backup_notification_recipient
    FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_backup_notification_identifiers
    CHECK (
      CHAR_LENGTH(dedupe_key) > 0
      AND CHAR_LENGTH(category) > 0
      AND CHAR_LENGTH(resource_type) > 0
      AND CHAR_LENGTH(title) > 0
      AND CHAR_LENGTH(message) > 0
    ),
  CONSTRAINT chk_backup_notification_status_evidence
    CHECK (
      (status = 'UNREAD' AND read_at IS NULL AND resolved_at IS NULL)
      OR (status = 'READ' AND read_at IS NOT NULL AND resolved_at IS NULL)
      OR (status = 'RESOLVED' AND read_at IS NOT NULL AND resolved_at IS NOT NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS backup_restore_drill_schedules (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  schedule_reference VARCHAR(80) COLLATE utf8mb4_bin NOT NULL,
  idempotency_key VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  request_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(160) NOT NULL,
  selection_strategy ENUM('LATEST_VERIFIED') NOT NULL DEFAULT 'LATEST_VERIFIED',
  backup_type_filter ENUM('DATABASE','FILES','CONFIGURATION','MODULE_STATE','DEPLOYMENT_VERSION','FULL_BACKUP') NULL,
  storage_provider_filter ENUM('LOCAL','S3','RDS_SNAPSHOT') NULL,
  module_key_filter VARCHAR(80) NULL,
  frequency ENUM('HOURLY','DAILY','WEEKLY','MONTHLY') NOT NULL,
  run_time TIME NULL,
  day_of_week TINYINT UNSIGNED NULL COMMENT 'ISO weekday: 1=Monday through 7=Sunday',
  day_of_month TINYINT UNSIGNED NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Manila',
  next_run_at DATETIME NULL,
  last_run_at DATETIME NULL,
  last_status ENUM('NEVER','QUEUED','RUNNING','PASSED','FAILED','SKIPPED') NOT NULL DEFAULT 'NEVER',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INT NOT NULL,
  updated_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT uq_backup_drill_schedule_reference UNIQUE (schedule_reference),
  CONSTRAINT uq_backup_drill_schedule_idempotency UNIQUE (idempotency_key),
  INDEX idx_backup_drill_schedule_due (enabled, next_run_at),
  INDEX idx_backup_drill_schedule_selection (backup_type_filter, storage_provider_filter, enabled),
  INDEX idx_backup_drill_schedule_created_by (created_by),
  INDEX idx_backup_drill_schedule_updated_by (updated_by),
  CONSTRAINT fk_backup_drill_schedule_created_by
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_backup_drill_schedule_updated_by
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_backup_drill_schedule_identifiers
    CHECK (
      CHAR_LENGTH(schedule_reference) > 0
      AND CHAR_LENGTH(idempotency_key) > 0
      AND CHAR_LENGTH(request_fingerprint) = 64
      AND CHAR_LENGTH(name) > 0
      AND CHAR_LENGTH(timezone) > 0
    ),
  CONSTRAINT chk_backup_drill_schedule_day_of_week
    CHECK (
      (frequency = 'WEEKLY' AND day_of_week BETWEEN 1 AND 7)
      OR (frequency <> 'WEEKLY' AND day_of_week IS NULL)
    ),
  CONSTRAINT chk_backup_drill_schedule_day_of_month
    CHECK (
      (frequency = 'MONTHLY' AND day_of_month BETWEEN 1 AND 31)
      OR (frequency <> 'MONTHLY' AND day_of_month IS NULL)
    ),
  CONSTRAINT chk_backup_drill_schedule_enabled_timing
    CHECK (
      enabled = FALSE
      OR (
        next_run_at IS NOT NULL
        AND (frequency = 'HOURLY' OR run_time IS NOT NULL)
      )
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS backup_restore_drill_runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_reference VARCHAR(80) COLLATE utf8mb4_bin NOT NULL,
  idempotency_key VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  schedule_id BIGINT NOT NULL,
  backup_set_id BIGINT NULL,
  status ENUM('QUEUED','RUNNING','PASSED','FAILED','SKIPPED') NOT NULL DEFAULT 'QUEUED',
  integrity_status ENUM('NOT_CHECKED','CHECKING','PASSED','FAILED','ERROR') NOT NULL DEFAULT 'NOT_CHECKED',
  integrity_checked_at DATETIME NULL,
  result_message_encrypted LONGTEXT NULL,
  failure_message_encrypted TEXT NULL,
  started_at DATETIME NULL,
  completed_at DATETIME NULL,
  created_by INT NULL,
  updated_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT uq_backup_drill_run_reference UNIQUE (run_reference),
  CONSTRAINT uq_backup_drill_run_idempotency UNIQUE (idempotency_key),
  INDEX idx_backup_drill_run_schedule (schedule_id, created_at),
  INDEX idx_backup_drill_run_backup_set (backup_set_id, created_at),
  INDEX idx_backup_drill_run_status (status, created_at),
  INDEX idx_backup_drill_run_created_by (created_by),
  INDEX idx_backup_drill_run_updated_by (updated_by),
  CONSTRAINT fk_backup_drill_run_schedule
    FOREIGN KEY (schedule_id) REFERENCES backup_restore_drill_schedules(id) ON DELETE RESTRICT,
  CONSTRAINT fk_backup_drill_run_backup_set
    FOREIGN KEY (backup_set_id) REFERENCES backup_sets(id) ON DELETE RESTRICT,
  CONSTRAINT fk_backup_drill_run_created_by
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_backup_drill_run_updated_by
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_backup_drill_run_identifiers
    CHECK (CHAR_LENGTH(run_reference) > 0 AND CHAR_LENGTH(idempotency_key) > 0),
  CONSTRAINT chk_backup_drill_run_started_evidence
    CHECK (status NOT IN ('RUNNING','PASSED','FAILED','SKIPPED') OR started_at IS NOT NULL),
  CONSTRAINT chk_backup_drill_run_terminal_evidence
    CHECK (status NOT IN ('PASSED','FAILED','SKIPPED') OR completed_at IS NOT NULL),
  CONSTRAINT chk_backup_drill_run_passed_evidence
    CHECK (
      status <> 'PASSED'
      OR (
        backup_set_id IS NOT NULL
        AND integrity_status = 'PASSED'
        AND integrity_checked_at IS NOT NULL
        AND result_message_encrypted IS NOT NULL
      )
    ),
  CONSTRAINT chk_backup_drill_run_failed_evidence
    CHECK (status <> 'FAILED' OR failure_message_encrypted IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE backup_sets
  ADD COLUMN IF NOT EXISTS schedule_id BIGINT NULL AFTER request_fingerprint,
  ADD COLUMN IF NOT EXISTS expires_at DATETIME NULL AFTER verified_at,
  ADD COLUMN IF NOT EXISTS retention_status ENUM('ACTIVE','EXPIRED','DELETED') NOT NULL DEFAULT 'ACTIVE' AFTER expires_at,
  ADD COLUMN IF NOT EXISTS artifact_deleted_at DATETIME NULL AFTER retention_status,
  ADD INDEX idx_backup_sets_schedule (schedule_id, created_at),
  ADD INDEX idx_backup_sets_retention (retention_status, expires_at, storage_provider),
  ADD CONSTRAINT fk_backup_sets_schedule
    FOREIGN KEY (schedule_id) REFERENCES backup_schedules(id) ON DELETE SET NULL,
  ADD CONSTRAINT chk_backup_sets_expiry
    CHECK (expires_at IS NULL OR expires_at >= created_at),
  ADD CONSTRAINT chk_backup_sets_retention_evidence
    CHECK (
      (retention_status = 'DELETED' AND artifact_deleted_at IS NOT NULL)
      OR (retention_status <> 'DELETED' AND artifact_deleted_at IS NULL)
    );
