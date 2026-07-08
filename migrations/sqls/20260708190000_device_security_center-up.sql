CREATE TABLE IF NOT EXISTS security_notifications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  notification_type VARCHAR(80) NOT NULL,
  title VARCHAR(180) NOT NULL,
  message TEXT NOT NULL,
  risk_level ENUM('Low','Medium','High') NOT NULL DEFAULT 'Low',
  device_id BIGINT NULL,
  device_hash CHAR(64) NULL,
  approval_request_id BIGINT NULL,
  ip_address VARCHAR(45) NULL,
  location VARCHAR(160) NULL,
  browser VARCHAR(100) NULL,
  operating_system VARCHAR(120) NULL,
  login_status VARCHAR(40) NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at DATETIME NULL,
  delivery_status VARCHAR(40) NOT NULL DEFAULT 'In-App',
  email_status VARCHAR(40) NULL,
  metadata JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_security_notifications_user_read (user_id, is_read, created_at),
  INDEX idx_security_notifications_risk (risk_level, created_at),
  INDEX idx_security_notifications_device_hash (device_hash),
  CONSTRAINT fk_security_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS device_approval_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  device_hash CHAR(64) NOT NULL,
  device_name VARCHAR(120) NOT NULL,
  browser VARCHAR(100) NULL,
  operating_system VARCHAR(120) NULL,
  device_type VARCHAR(20) NULL,
  ip_address VARCHAR(45) NULL,
  location VARCHAR(160) NULL,
  risk_level ENUM('Low','Medium','High') NOT NULL DEFAULT 'Medium',
  login_status VARCHAR(40) NOT NULL DEFAULT 'Pending Approval',
  status ENUM('Pending','Approved','Ignored','Secured','Expired') NOT NULL DEFAULT 'Pending',
  requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at DATETIME NULL,
  approved_by INT NULL,
  expires_at DATETIME NULL,
  metadata JSON NULL,
  INDEX idx_device_approval_user_status (user_id, status, requested_at),
  INDEX idx_device_approval_hash (device_hash),
  CONSTRAINT fk_device_approval_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_device_approval_approved_by FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trusted_devices' AND COLUMN_NAME = 'nickname');
SET @sql := IF(@col = 0, 'ALTER TABLE trusted_devices ADD COLUMN nickname VARCHAR(120) NULL AFTER device_name', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trusted_devices' AND COLUMN_NAME = 'first_registered_ip');
SET @sql := IF(@col = 0, 'ALTER TABLE trusted_devices ADD COLUMN first_registered_ip VARCHAR(45) NULL AFTER ip_address', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trusted_devices' AND COLUMN_NAME = 'last_location');
SET @sql := IF(@col = 0, 'ALTER TABLE trusted_devices ADD COLUMN last_location VARCHAR(160) NULL AFTER first_registered_ip', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_sessions' AND COLUMN_NAME = 'user_session_id');
SET @sql := IF(@col = 0, 'ALTER TABLE device_sessions ADD COLUMN user_session_id BIGINT NULL AFTER device_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_sessions' AND COLUMN_NAME = 'jwt_id');
SET @sql := IF(@col = 0, 'ALTER TABLE device_sessions ADD COLUMN jwt_id VARCHAR(255) NULL AFTER user_session_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_sessions' AND COLUMN_NAME = 'last_activity');
SET @sql := IF(@col = 0, 'ALTER TABLE device_sessions ADD COLUMN last_activity DATETIME NULL AFTER login_at', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_sessions' AND COLUMN_NAME = 'risk_level');
SET @sql := IF(@col = 0, 'ALTER TABLE device_sessions ADD COLUMN risk_level VARCHAR(20) NULL AFTER login_method', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_audit_logs' AND COLUMN_NAME = 'device_name');
SET @sql := IF(@col = 0, 'ALTER TABLE device_audit_logs ADD COLUMN device_name VARCHAR(120) NULL AFTER device_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_audit_logs' AND COLUMN_NAME = 'browser');
SET @sql := IF(@col = 0, 'ALTER TABLE device_audit_logs ADD COLUMN browser VARCHAR(100) NULL AFTER device_name', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_audit_logs' AND COLUMN_NAME = 'operating_system');
SET @sql := IF(@col = 0, 'ALTER TABLE device_audit_logs ADD COLUMN operating_system VARCHAR(120) NULL AFTER browser', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_audit_logs' AND COLUMN_NAME = 'location');
SET @sql := IF(@col = 0, 'ALTER TABLE device_audit_logs ADD COLUMN location VARCHAR(160) NULL AFTER ip_address', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_audit_logs' AND COLUMN_NAME = 'login_status');
SET @sql := IF(@col = 0, 'ALTER TABLE device_audit_logs ADD COLUMN login_status VARCHAR(40) NULL AFTER location', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_audit_logs' AND COLUMN_NAME = 'risk_level');
SET @sql := IF(@col = 0, 'ALTER TABLE device_audit_logs ADD COLUMN risk_level VARCHAR(20) NOT NULL DEFAULT ''Low'' AFTER login_status', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_audit_logs' AND INDEX_NAME = 'idx_device_audit_user_risk_time');
SET @sql := IF(@idx = 0, 'CREATE INDEX idx_device_audit_user_risk_time ON device_audit_logs (user_id, risk_level, timestamp)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_sessions' AND INDEX_NAME = 'idx_device_sessions_jwt');
SET @sql := IF(@idx = 0, 'CREATE INDEX idx_device_sessions_jwt ON device_sessions (jwt_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
