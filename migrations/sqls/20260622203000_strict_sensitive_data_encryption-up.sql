SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email') > 0,
  'ALTER TABLE users MODIFY COLUMN email VARCHAR(150) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email_hash') = 0,
  'ALTER TABLE users ADD COLUMN email_hash CHAR(64) NULL AFTER username',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email_encrypted') = 0,
  'ALTER TABLE users ADD COLUMN email_encrypted TEXT NULL AFTER email_hash',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_email_hash') = 0,
  'CREATE INDEX idx_users_email_hash ON users (email_hash)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'encrypted_pii') = 0,
  'ALTER TABLE employees ADD COLUMN encrypted_pii LONGTEXT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS sensitive_employee_data (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  employee_id BIGINT NOT NULL,
  ssn VARCHAR(100) NULL,
  tax_id VARCHAR(100) NULL,
  bank_account_number VARCHAR(100) NULL,
  bank_routing_number VARCHAR(100) NULL,
  emergency_contact_phone VARCHAR(50) NULL,
  other_sensitive_info TEXT NULL,
  updated_by BIGINT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sensitive_employee_data_employee (employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND COLUMN_NAME = 'ssn_encrypted') = 0, 'ALTER TABLE sensitive_employee_data ADD COLUMN ssn_encrypted TEXT NULL AFTER ssn', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND COLUMN_NAME = 'ssn_hash') = 0, 'ALTER TABLE sensitive_employee_data ADD COLUMN ssn_hash CHAR(64) NULL AFTER ssn_encrypted', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND COLUMN_NAME = 'tax_id_encrypted') = 0, 'ALTER TABLE sensitive_employee_data ADD COLUMN tax_id_encrypted TEXT NULL AFTER tax_id', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND COLUMN_NAME = 'tax_id_hash') = 0, 'ALTER TABLE sensitive_employee_data ADD COLUMN tax_id_hash CHAR(64) NULL AFTER tax_id_encrypted', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND COLUMN_NAME = 'bank_account_number_encrypted') = 0, 'ALTER TABLE sensitive_employee_data ADD COLUMN bank_account_number_encrypted TEXT NULL AFTER bank_account_number', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND COLUMN_NAME = 'bank_account_number_hash') = 0, 'ALTER TABLE sensitive_employee_data ADD COLUMN bank_account_number_hash CHAR(64) NULL AFTER bank_account_number_encrypted', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND COLUMN_NAME = 'bank_routing_number_encrypted') = 0, 'ALTER TABLE sensitive_employee_data ADD COLUMN bank_routing_number_encrypted TEXT NULL AFTER bank_routing_number', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND COLUMN_NAME = 'bank_routing_number_hash') = 0, 'ALTER TABLE sensitive_employee_data ADD COLUMN bank_routing_number_hash CHAR(64) NULL AFTER bank_routing_number_encrypted', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND COLUMN_NAME = 'emergency_contact_phone_encrypted') = 0, 'ALTER TABLE sensitive_employee_data ADD COLUMN emergency_contact_phone_encrypted TEXT NULL AFTER emergency_contact_phone', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND COLUMN_NAME = 'emergency_contact_phone_hash') = 0, 'ALTER TABLE sensitive_employee_data ADD COLUMN emergency_contact_phone_hash CHAR(64) NULL AFTER emergency_contact_phone_encrypted', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND COLUMN_NAME = 'other_sensitive_info_encrypted') = 0, 'ALTER TABLE sensitive_employee_data ADD COLUMN other_sensitive_info_encrypted LONGTEXT NULL AFTER other_sensitive_info', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND INDEX_NAME = 'idx_sensitive_employee_data_ssn_hash') = 0, 'CREATE INDEX idx_sensitive_employee_data_ssn_hash ON sensitive_employee_data (ssn_hash)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND INDEX_NAME = 'idx_sensitive_employee_data_tax_hash') = 0, 'CREATE INDEX idx_sensitive_employee_data_tax_hash ON sensitive_employee_data (tax_id_hash)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensitive_employee_data' AND INDEX_NAME = 'idx_sensitive_employee_data_bank_hash') = 0, 'CREATE INDEX idx_sensitive_employee_data_bank_hash ON sensitive_employee_data (bank_account_number_hash)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_family_members') > 0 AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_family_members' AND COLUMN_NAME = 'pii_encrypted') = 0, 'ALTER TABLE employee_family_members ADD COLUMN pii_encrypted LONGTEXT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_family_members') > 0, 'ALTER TABLE employee_family_members MODIFY COLUMN relationship_type VARCHAR(100) NULL, MODIFY COLUMN extension_name VARCHAR(50) NULL, MODIFY COLUMN first_name VARCHAR(100) NULL, MODIFY COLUMN middle_name VARCHAR(100) NULL, MODIFY COLUMN last_name VARCHAR(100) NULL, MODIFY COLUMN date_of_birth VARCHAR(100) NULL, MODIFY COLUMN telephone_number VARCHAR(50) NULL, MODIFY COLUMN business_address TEXT NULL, MODIFY COLUMN occupation VARCHAR(150) NULL, MODIFY COLUMN employer_name VARCHAR(150) NULL, MODIFY COLUMN deceased BOOLEAN NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_work_experiences') > 0 AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_work_experiences' AND COLUMN_NAME = 'pii_encrypted') = 0, 'ALTER TABLE employee_work_experiences ADD COLUMN pii_encrypted LONGTEXT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_work_experiences') > 0, 'ALTER TABLE employee_work_experiences MODIFY COLUMN company_name VARCHAR(255) NULL, MODIFY COLUMN position_title VARCHAR(150) NULL, MODIFY COLUMN employment_type VARCHAR(100) NULL, MODIFY COLUMN date_from VARCHAR(100) NULL, MODIFY COLUMN date_to VARCHAR(100) NULL, MODIFY COLUMN supervisor_name VARCHAR(150) NULL, MODIFY COLUMN company_address TEXT NULL, MODIFY COLUMN reason_for_leaving TEXT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_certifications') > 0 AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_certifications' AND COLUMN_NAME = 'pii_encrypted') = 0, 'ALTER TABLE employee_certifications ADD COLUMN pii_encrypted LONGTEXT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_certifications') > 0, 'ALTER TABLE employee_certifications MODIFY COLUMN certification_name VARCHAR(255) NULL, MODIFY COLUMN issuing_organization VARCHAR(255) NULL, MODIFY COLUMN issue_date VARCHAR(100) NULL, MODIFY COLUMN expiry_date VARCHAR(100) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_trainings') > 0 AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_trainings' AND COLUMN_NAME = 'pii_encrypted') = 0, 'ALTER TABLE employee_trainings ADD COLUMN pii_encrypted LONGTEXT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_trainings') > 0, 'ALTER TABLE employee_trainings MODIFY COLUMN training_name VARCHAR(255) NULL, MODIFY COLUMN provider VARCHAR(255) NULL, MODIFY COLUMN date_from VARCHAR(100) NULL, MODIFY COLUMN date_to VARCHAR(100) NULL, MODIFY COLUMN training_hours VARCHAR(100) NULL, MODIFY COLUMN remarks TEXT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
