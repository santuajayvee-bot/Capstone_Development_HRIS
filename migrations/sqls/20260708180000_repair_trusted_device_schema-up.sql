-- These base tables are prerequisites of the device security center migration.
-- CREATE TABLE IF NOT EXISTS safely adopts tables that may have been created by
-- an earlier application startup while repairing databases where they are absent.
CREATE TABLE IF NOT EXISTS device_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  device_id BIGINT NULL,
  login_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  logout_at DATETIME NULL,
  session_status VARCHAR(20) NOT NULL DEFAULT 'Active',
  login_method VARCHAR(40) NULL,
  ip_address VARCHAR(45) NULL,
  location VARCHAR(160) NULL,
  browser VARCHAR(100) NULL,
  operating_system VARCHAR(120) NULL,
  device_type VARCHAR(20) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_device_sessions_user_status (user_id, session_status, login_at),
  INDEX idx_device_sessions_device (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS device_audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  device_id BIGINT NULL,
  action VARCHAR(80) NOT NULL,
  timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address VARCHAR(45) NULL,
  details TEXT NULL,
  INDEX idx_device_audit_logs_user (user_id, timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
