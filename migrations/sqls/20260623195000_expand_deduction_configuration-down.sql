-- DOWN migration: remove expanded deduction configuration fields.

UPDATE employee_deduction_accounts SET status = 'Paid' WHERE status = 'Fully Paid';
UPDATE employee_deduction_accounts SET status = 'Paused' WHERE status = 'Suspended';

ALTER TABLE payroll_audit_trail
  DROP COLUMN IF EXISTS result,
  DROP COLUMN IF EXISTS ip_address,
  DROP COLUMN IF EXISTS user_role;

ALTER TABLE employee_deduction_accounts
  DROP COLUMN IF EXISTS insufficient_net_pay_rule,
  DROP COLUMN IF EXISTS max_deduction_percent_net_pay,
  DROP COLUMN IF EXISTS deduction_frequency,
  DROP COLUMN IF EXISTS number_of_pay_periods,
  MODIFY COLUMN status ENUM('Active','Paused','Paid','Cancelled') NOT NULL DEFAULT 'Active';

DROP TABLE IF EXISTS payroll_deduction_brackets;

ALTER TABLE payroll_deduction_settings
  DROP COLUMN IF EXISTS fixed_attendance_deduction_amount,
  DROP COLUMN IF EXISTS deduction_base_rate,
  DROP COLUMN IF EXISTS undertime_deduction_multiplier,
  DROP COLUMN IF EXISTS undertime_grace_period_minutes,
  DROP COLUMN IF EXISTS undertime_deduction_enabled,
  DROP COLUMN IF EXISTS late_deduction_multiplier,
  DROP COLUMN IF EXISTS late_grace_period_minutes,
  DROP COLUMN IF EXISTS late_deduction_enabled,
  DROP COLUMN IF EXISTS selected_payroll_type,
  DROP COLUMN IF EXISTS selected_department_id,
  DROP COLUMN IF EXISTS selected_employment_type,
  DROP COLUMN IF EXISTS selected_employee_id,
  DROP COLUMN IF EXISTS applicability_scope,
  DROP COLUMN IF EXISTS priority_order,
  DROP COLUMN IF EXISTS maximum_contribution_cap,
  DROP COLUMN IF EXISTS maximum_salary_ceiling,
  DROP COLUMN IF EXISTS minimum_salary_base,
  DROP COLUMN IF EXISTS total_contribution_rate,
  DROP COLUMN IF EXISTS employer_share_rate,
  DROP COLUMN IF EXISTS employee_share_rate,
  MODIFY COLUMN apply_schedule ENUM('Every Payroll','1st Week','2nd Week','3rd Week','4th Week','5th Week') NOT NULL DEFAULT 'Every Payroll',
  MODIFY COLUMN computation_type ENUM('Fixed Amount','Percentage','Manual Amount') NOT NULL DEFAULT 'Manual Amount';
