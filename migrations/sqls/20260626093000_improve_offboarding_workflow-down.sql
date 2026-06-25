UPDATE employee_offboarding_case
   SET status = CASE
     WHEN status IN ('For Offboarding','Clearance Pending','Payroll Review','Final Approval') THEN 'In Progress'
     WHEN status IN ('Offboarded','Inactive') THEN 'Completed'
     ELSE status
   END;

UPDATE employee_offboarding_case
   SET offboarding_type = 'Termination'
 WHERE offboarding_type = 'Redundancy';

DROP TABLE IF EXISTS employee_offboarding_clearance_item;

ALTER TABLE employees
  DROP COLUMN IF EXISTS offboarding_clearance_result;

ALTER TABLE employee_offboarding_case
  DROP COLUMN IF EXISTS pending_benefits,
  DROP COLUMN IF EXISTS final_allowances,
  DROP COLUMN IF EXISTS final_deductions,
  DROP COLUMN IF EXISTS unpaid_salary,
  DROP COLUMN IF EXISTS final_attendance_cutoff,
  MODIFY COLUMN offboarding_type ENUM('Resignation','Termination','End of Contract','Retirement','AWOL') NOT NULL,
  MODIFY COLUMN status ENUM('Pending','In Progress','Approved','Completed','Cancelled') NOT NULL DEFAULT 'Pending';
