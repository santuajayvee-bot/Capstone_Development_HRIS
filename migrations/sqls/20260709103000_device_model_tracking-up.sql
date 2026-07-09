SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trusted_devices' AND COLUMN_NAME = 'device_model');
SET @sql := IF(@col = 0, 'ALTER TABLE trusted_devices ADD COLUMN device_model VARCHAR(160) NULL AFTER device_type', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_sessions' AND COLUMN_NAME = 'device_model');
SET @sql := IF(@col = 0, 'ALTER TABLE device_sessions ADD COLUMN device_model VARCHAR(160) NULL AFTER device_type', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_audit_logs' AND COLUMN_NAME = 'device_model');
SET @sql := IF(@col = 0, 'ALTER TABLE device_audit_logs ADD COLUMN device_model VARCHAR(160) NULL AFTER operating_system', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'security_notifications' AND COLUMN_NAME = 'device_model');
SET @sql := IF(@col = 0, 'ALTER TABLE security_notifications ADD COLUMN device_model VARCHAR(160) NULL AFTER operating_system', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_approval_requests' AND COLUMN_NAME = 'device_model');
SET @sql := IF(@col = 0, 'ALTER TABLE device_approval_requests ADD COLUMN device_model VARCHAR(160) NULL AFTER device_type', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
