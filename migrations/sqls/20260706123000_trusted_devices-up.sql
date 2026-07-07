CREATE TABLE IF NOT EXISTS trusted_devices (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  device_name VARCHAR(120) NOT NULL,
  device_hash CHAR(64) NOT NULL,
  browser VARCHAR(100) NULL,
  operating_system VARCHAR(120) NULL,
  device_type ENUM('Desktop','Mobile','Tablet') NOT NULL DEFAULT 'Desktop',
  ip_address VARCHAR(45) NULL,
  last_used DATETIME NULL,
  registered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_trusted BOOLEAN NOT NULL DEFAULT TRUE,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_trusted_devices_user_hash (user_id, device_hash),
  INDEX idx_trusted_devices_user_status (user_id, is_trusted, revoked_at),
  INDEX idx_trusted_devices_last_used (last_used)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
