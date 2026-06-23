UPDATE employees
   SET lifecycle_status = 'Active'
 WHERE lifecycle_status IN ('Pending Onboarding','Pending Training','On Hold');

ALTER TABLE employees
  MODIFY COLUMN lifecycle_status ENUM('Active','For Onboarding','Under Screening','In Training','Rejected','Transferred') NOT NULL DEFAULT 'Active';

UPDATE employees
   SET status = 'Inactive'
 WHERE status IN ('Retired','Offboarded','Rehired');

ALTER TABLE employees
  MODIFY COLUMN status ENUM('Active','Inactive','Resigned','Terminated','End of Contract','Suspended') NOT NULL DEFAULT 'Active';

SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'token_version') > 0,
  'ALTER TABLE users DROP COLUMN token_version',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

DROP TABLE IF EXISTS employee_reonboarding_case;

DROP TABLE IF EXISTS employee_offboarding_case;

DROP TABLE IF EXISTS employee_lifecycle_event;
