ALTER TABLE payroll_deduction_settings
  ADD COLUMN IF NOT EXISTS proration_mode ENUM('Fixed Divisor','Calendar-Based Payroll Date Range') NOT NULL DEFAULT 'Fixed Divisor' AFTER apply_schedule,
  ADD COLUMN IF NOT EXISTS fixed_divisor DECIMAL(10,2) NULL AFTER proration_mode;

UPDATE payroll_deduction_settings
   SET fixed_divisor = CASE
     WHEN apply_schedule = 'Monthly' THEN 1
     WHEN apply_schedule IN ('Semi-Monthly','First Payroll of Month','Last Payroll of Month') THEN 2
     WHEN fixed_divisor IS NULL THEN 4
     ELSE fixed_divisor
   END
 WHERE fixed_divisor IS NULL;
