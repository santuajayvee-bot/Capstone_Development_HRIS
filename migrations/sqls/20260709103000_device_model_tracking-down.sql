SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_approval_requests' AND COLUMN_NAME = 'device_model');
SET @sql := IF(@col > 0, 'ALTER TABLE device_approval_requests DROP COLUMN device_model', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'security_notifications' AND COLUMN_NAME = 'device_model');
SET @sql := IF(@col > 0, 'ALTER TABLE security_notifications DROP COLUMN device_model', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_audit_logs' AND COLUMN_NAME = 'device_model');
SET @sql := IF(@col > 0, 'ALTER TABLE device_audit_logs DROP COLUMN device_model', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_sessions' AND COLUMN_NAME = 'device_model');
SET @sql := IF(@col > 0, 'ALTER TABLE device_sessions DROP COLUMN device_model', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trusted_devices' AND COLUMN_NAME = 'device_model');
SET @sql := IF(@col > 0, 'ALTER TABLE trusted_devices DROP COLUMN device_model', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
