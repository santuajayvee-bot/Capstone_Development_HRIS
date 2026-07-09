CREATE TABLE IF NOT EXISTS backup_sets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  backup_reference VARCHAR(80) NOT NULL UNIQUE,
  backup_name VARCHAR(160) NOT NULL,
  backup_type ENUM('DATABASE','FILES','CONFIGURATION','MODULE_STATE','DEPLOYMENT_VERSION','FULL_BACKUP') NOT NULL DEFAULT 'DATABASE',
  storage_provider ENUM('LOCAL','S3','RDS_SNAPSHOT','MANUAL') NOT NULL DEFAULT 'MANUAL',
  storage_location_encrypted TEXT NULL,
  status ENUM('PENDING','RUNNING','COMPLETED','FAILED','VERIFIED','RESTORED') NOT NULL DEFAULT 'PENDING',
  included_modules TEXT NULL,
  checksum CHAR(64) NULL,
  file_size BIGINT NULL,
  created_by BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  verified_at DATETIME NULL,
  restored_at DATETIME NULL,
  remarks_encrypted TEXT NULL,
  INDEX idx_backup_sets_type_status (backup_type, status, created_at),
  INDEX idx_backup_sets_status_created (status, created_at),
  INDEX idx_backup_sets_created_by (created_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS module_recovery_points (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  module_key VARCHAR(80) NOT NULL,
  module_name VARCHAR(160) NOT NULL,
  current_version VARCHAR(80) NULL,
  stable_version VARCHAR(80) NULL,
  deployment_commit VARCHAR(80) NULL,
  artifact_location_encrypted TEXT NULL,
  storage_provider ENUM('LOCAL','S3','RDS_SNAPSHOT','MANUAL') NOT NULL DEFAULT 'MANUAL',
  health_status_at_backup ENUM('ONLINE','WARNING','OFFLINE','MAINTENANCE','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  backup_set_id BIGINT NULL,
  rollback_available BOOLEAN NOT NULL DEFAULT FALSE,
  created_by BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  remarks_encrypted TEXT NULL,
  INDEX idx_module_recovery_module_time (module_key, created_at),
  INDEX idx_module_recovery_backup_set (backup_set_id),
  INDEX idx_module_recovery_rollback (rollback_available, module_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS restore_jobs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  backup_set_id BIGINT NOT NULL,
  restore_type ENUM('DATABASE','FILES','CONFIGURATION','MODULE_STATE','FULL_BACKUP') NOT NULL DEFAULT 'DATABASE',
  affected_module VARCHAR(80) NULL,
  status ENUM('PENDING','IN_PROGRESS','COMPLETED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  requested_by BIGINT NOT NULL,
  approved_by BIGINT NULL,
  started_at DATETIME NULL,
  completed_at DATETIME NULL,
  reason_encrypted TEXT NULL,
  result_message_encrypted TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_restore_jobs_backup_set (backup_set_id),
  INDEX idx_restore_jobs_status_created (status, created_at),
  INDEX idx_restore_jobs_module (affected_module, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS module_rollback_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  affected_module VARCHAR(80) NOT NULL,
  current_version VARCHAR(80) NULL,
  target_version VARCHAR(80) NULL,
  artifact_location_encrypted TEXT NULL,
  reason_encrypted TEXT NULL,
  status ENUM('PENDING','APPROVED','IN_PROGRESS','COMPLETED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  requested_by BIGINT NOT NULL,
  approved_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  result_message_encrypted TEXT NULL,
  INDEX idx_module_rollback_status_created (status, created_at),
  INDEX idx_module_rollback_module (affected_module, created_at),
  INDEX idx_module_rollback_requested_by (requested_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
