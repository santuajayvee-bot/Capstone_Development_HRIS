SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_trainings' AND COLUMN_NAME = 'pii_encrypted') > 0, 'ALTER TABLE employee_trainings DROP COLUMN pii_encrypted', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_certifications' AND COLUMN_NAME = 'pii_encrypted') > 0, 'ALTER TABLE employee_certifications DROP COLUMN pii_encrypted', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_work_experiences' AND COLUMN_NAME = 'pii_encrypted') > 0, 'ALTER TABLE employee_work_experiences DROP COLUMN pii_encrypted', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_family_members' AND COLUMN_NAME = 'pii_encrypted') > 0, 'ALTER TABLE employee_family_members DROP COLUMN pii_encrypted', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND INDEX_NAME = 'idx_sensitive_employee_data_bank_hash') > 0, 'DROP INDEX idx_sensitive_employee_data_bank_hash ON sensitive_employee_data', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND INDEX_NAME = 'idx_sensitive_employee_data_tax_hash') > 0, 'DROP INDEX idx_sensitive_employee_data_tax_hash ON sensitive_employee_data', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND INDEX_NAME = 'idx_sensitive_employee_data_ssn_hash') > 0, 'DROP INDEX idx_sensitive_employee_data_ssn_hash ON sensitive_employee_data', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND COLUMN_NAME = 'ssn_encrypted') > 0, 'ALTER TABLE sensitive_employee_data DROP COLUMN other_sensitive_info_encrypted, DROP COLUMN emergency_contact_phone_hash, DROP COLUMN emergency_contact_phone_encrypted, DROP COLUMN bank_routing_number_hash, DROP COLUMN bank_routing_number_encrypted, DROP COLUMN bank_account_number_hash, DROP COLUMN bank_account_number_encrypted, DROP COLUMN tax_id_hash, DROP COLUMN tax_id_encrypted, DROP COLUMN ssn_hash, DROP COLUMN ssn_encrypted', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'encrypted_pii') > 0, 'ALTER TABLE employees DROP COLUMN encrypted_pii', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_email_hash') > 0, 'DROP INDEX idx_users_email_hash ON users', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email_encrypted') > 0, 'ALTER TABLE users DROP COLUMN email_encrypted, DROP COLUMN email_hash', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
