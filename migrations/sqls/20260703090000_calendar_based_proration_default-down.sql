ALTER TABLE payroll_deduction_settings
  MODIFY COLUMN IF EXISTS proration_mode
    ENUM('Fixed Divisor','Calendar-Based Payroll Date Range')
    NOT NULL DEFAULT 'Fixed Divisor';
