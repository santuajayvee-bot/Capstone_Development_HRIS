ALTER TABLE payroll_deduction_settings
  DROP COLUMN IF EXISTS fixed_divisor,
  DROP COLUMN IF EXISTS proration_mode;
