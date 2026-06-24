-- UP migration: expand payroll deduction policies, brackets, and loan controls.

ALTER TABLE payroll_deduction_settings
  MODIFY COLUMN computation_type ENUM('Fixed Amount','Percentage','Manual Amount','Table Lookup / Matrix Bracket','Loan Amortization','Attendance-Based') NOT NULL DEFAULT 'Manual Amount',
  MODIFY COLUMN apply_schedule ENUM('Every Payroll','1st Week','2nd Week','3rd Week','4th Week','5th Week','Weekly','Semi-Monthly','Monthly','First Payroll of Month','Last Payroll of Month') NOT NULL DEFAULT 'Every Payroll';

ALTER TABLE payroll_deduction_settings
  ADD COLUMN IF NOT EXISTS employee_share_rate DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER rate_or_amount,
  ADD COLUMN IF NOT EXISTS employer_share_rate DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER employee_share_rate,
  ADD COLUMN IF NOT EXISTS total_contribution_rate DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER employer_share_rate,
  ADD COLUMN IF NOT EXISTS minimum_salary_base DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER total_contribution_rate,
  ADD COLUMN IF NOT EXISTS maximum_salary_ceiling DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER minimum_salary_base,
  ADD COLUMN IF NOT EXISTS maximum_contribution_cap DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER maximum_salary_ceiling,
  ADD COLUMN IF NOT EXISTS priority_order INT NOT NULL DEFAULT 5 AFTER apply_schedule,
  ADD COLUMN IF NOT EXISTS applicability_scope ENUM('All Employees','Selected Employee','Selected Employment Type','Selected Department','Selected Payroll Type') NOT NULL DEFAULT 'All Employees' AFTER priority_order,
  ADD COLUMN IF NOT EXISTS selected_employee_id BIGINT NULL AFTER applicability_scope,
  ADD COLUMN IF NOT EXISTS selected_employment_type VARCHAR(80) NULL AFTER selected_employee_id,
  ADD COLUMN IF NOT EXISTS selected_department_id BIGINT NULL AFTER selected_employment_type,
  ADD COLUMN IF NOT EXISTS selected_payroll_type VARCHAR(80) NULL AFTER selected_department_id,
  ADD COLUMN IF NOT EXISTS late_deduction_enabled BOOLEAN NOT NULL DEFAULT FALSE AFTER selected_payroll_type,
  ADD COLUMN IF NOT EXISTS late_grace_period_minutes INT NOT NULL DEFAULT 0 AFTER late_deduction_enabled,
  ADD COLUMN IF NOT EXISTS late_deduction_multiplier DECIMAL(10,2) NOT NULL DEFAULT 1.00 AFTER late_grace_period_minutes,
  ADD COLUMN IF NOT EXISTS undertime_deduction_enabled BOOLEAN NOT NULL DEFAULT FALSE AFTER late_deduction_multiplier,
  ADD COLUMN IF NOT EXISTS undertime_grace_period_minutes INT NOT NULL DEFAULT 0 AFTER undertime_deduction_enabled,
  ADD COLUMN IF NOT EXISTS undertime_deduction_multiplier DECIMAL(10,2) NOT NULL DEFAULT 1.00 AFTER undertime_grace_period_minutes,
  ADD COLUMN IF NOT EXISTS deduction_base_rate ENUM('Employee Hourly Rate','Daily Rate Converted to Hourly','Fixed Amount') NOT NULL DEFAULT 'Employee Hourly Rate' AFTER undertime_deduction_multiplier,
  ADD COLUMN IF NOT EXISTS fixed_attendance_deduction_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER deduction_base_rate;

CREATE TABLE IF NOT EXISTS payroll_deduction_brackets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  deduction_setting_id BIGINT NOT NULL,
  salary_range_from DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  salary_range_to DECIMAL(10,2) NULL,
  employee_share DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  employer_share DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  base_tax DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  percentage_over_excess DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  effective_date DATE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NULL,
  updated_by BIGINT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_deduction_bracket_setting (deduction_setting_id),
  INDEX idx_deduction_bracket_range (salary_range_from, salary_range_to),
  INDEX idx_deduction_bracket_active (is_active, effective_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE employee_deduction_accounts
  MODIFY COLUMN status ENUM('Active','Suspended','Fully Paid','Cancelled','Paused','Paid') NOT NULL DEFAULT 'Active';

ALTER TABLE employee_deduction_accounts
  ADD COLUMN IF NOT EXISTS number_of_pay_periods INT NULL AFTER installment_amount,
  ADD COLUMN IF NOT EXISTS deduction_frequency ENUM('Every Payroll','Weekly','Semi-Monthly','Monthly','First Payroll of Month','Last Payroll of Month') NOT NULL DEFAULT 'Every Payroll' AFTER end_date,
  ADD COLUMN IF NOT EXISTS max_deduction_percent_net_pay DECIMAL(10,2) NOT NULL DEFAULT 100.00 AFTER deduction_frequency,
  ADD COLUMN IF NOT EXISTS insufficient_net_pay_rule ENUM('Deduct Partial Amount','Skip Deduction for This Period') NOT NULL DEFAULT 'Deduct Partial Amount' AFTER max_deduction_percent_net_pay;

ALTER TABLE payroll_audit_trail
  ADD COLUMN IF NOT EXISTS user_role VARCHAR(80) NULL AFTER user_id,
  ADD COLUMN IF NOT EXISTS ip_address VARCHAR(64) NULL AFTER metadata,
  ADD COLUMN IF NOT EXISTS result ENUM('success','denied','failed') NOT NULL DEFAULT 'success' AFTER ip_address;

UPDATE employee_deduction_accounts SET status = 'Fully Paid' WHERE status = 'Paid';
UPDATE employee_deduction_accounts SET status = 'Suspended' WHERE status = 'Paused';
