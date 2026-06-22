ALTER TABLE employees DROP INDEX idx_employees_status_department;

ALTER TABLE employees
  DROP COLUMN offboarding_remarks,
  DROP COLUMN separation_reason,
  DROP COLUMN separation_date;

UPDATE employees
   SET status = 'Inactive'
 WHERE status IN ('Resigned','Terminated','End of Contract','Suspended');

ALTER TABLE employees
  MODIFY COLUMN status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active';
