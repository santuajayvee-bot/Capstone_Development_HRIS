ALTER TABLE employees DROP INDEX IF EXISTS idx_employees_status_department;

ALTER TABLE employees
  DROP COLUMN IF EXISTS offboarding_remarks,
  DROP COLUMN IF EXISTS separation_reason,
  DROP COLUMN IF EXISTS separation_date;

UPDATE employees
   SET status = 'Inactive'
 WHERE status IN ('Resigned','Terminated','End of Contract','Suspended');

ALTER TABLE employees
  MODIFY COLUMN status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active';
