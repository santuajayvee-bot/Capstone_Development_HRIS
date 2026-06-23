ALTER TABLE employees
  MODIFY COLUMN status ENUM('Active','Inactive','Resigned','Terminated','End of Contract','Suspended') NOT NULL DEFAULT 'Active';

ALTER TABLE employees
  ADD COLUMN separation_date DATE NULL AFTER status,
  ADD COLUMN separation_reason VARCHAR(120) NULL AFTER separation_date,
  ADD COLUMN offboarding_remarks VARCHAR(500) NULL AFTER separation_reason;

CREATE INDEX idx_employees_status_department
  ON employees (status, department_id);
