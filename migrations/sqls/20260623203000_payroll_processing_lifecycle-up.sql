-- UP migration: payroll processing lifecycle for batch review, approval, release, and locking.

UPDATE salary_calculations
   SET status = 'Draft'
 WHERE status IS NULL OR status = '';

ALTER TABLE salary_calculations
  MODIFY COLUMN status ENUM('Draft','Calculated','For Review','For Approval','Submitted','Approved','Finalized','Paid','Released','Locked','Superseded','Cancelled') DEFAULT 'For Review';

UPDATE salary_calculations
   SET status = 'For Review'
 WHERE status = 'Draft'
   AND source_type IS NOT NULL;

ALTER TABLE payroll_runs
  MODIFY COLUMN status ENUM('Draft','For Review','For Approval','Generated','Pending Review','Approved','Released','Locked','Cancelled') DEFAULT 'Draft';

ALTER TABLE payslips
  MODIFY COLUMN status ENUM('Draft','For Review','For Approval','Approved','Released','Locked','Disbursed','Cancelled') DEFAULT 'For Review';

ALTER TABLE piece_rate_outputs
  ADD COLUMN IF NOT EXISTS remarks VARCHAR(255) NULL AFTER split_rule,
  ADD COLUMN IF NOT EXISTS payroll_run_id INT NULL AFTER status,
  ADD COLUMN IF NOT EXISTS submitted_by BIGINT NULL AFTER payroll_run_id,
  ADD COLUMN IF NOT EXISTS submitted_at DATETIME NULL AFTER submitted_by,
  ADD COLUMN IF NOT EXISTS verified_by BIGINT NULL AFTER submitted_at,
  ADD COLUMN IF NOT EXISTS verified_at DATETIME NULL AFTER verified_by,
  ADD COLUMN IF NOT EXISTS paid_at DATETIME NULL AFTER approved_at,
  ADD COLUMN IF NOT EXISTS updated_by BIGINT NULL AFTER paid_at;

CREATE TABLE IF NOT EXISTS payroll_policy_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(80) NOT NULL UNIQUE,
  setting_value VARCHAR(255) NOT NULL,
  setting_group VARCHAR(40) NOT NULL DEFAULT 'General',
  description VARCHAR(255) NULL,
  updated_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

UPDATE salary_calculations
   SET status = 'For Approval'
 WHERE status = 'Submitted';

UPDATE payslips
   SET status = 'For Approval'
 WHERE status IN ('Submitted');

UPDATE payroll_runs
   SET status = 'For Review'
 WHERE status IN ('Generated','Pending Review');

INSERT INTO payroll_policy_settings (setting_key, setting_value, setting_group, description)
SELECT 'per_piece_apply_late_deduction', 'false', 'Piece and Trip Rules', 'Apply late deduction to per-piece payroll only when explicitly enabled.'
WHERE NOT EXISTS (SELECT 1 FROM payroll_policy_settings WHERE setting_key = 'per_piece_apply_late_deduction');

INSERT INTO payroll_policy_settings (setting_key, setting_value, setting_group, description)
SELECT 'per_piece_apply_undertime_deduction', 'false', 'Piece and Trip Rules', 'Apply undertime deduction to per-piece payroll only when explicitly enabled.'
WHERE NOT EXISTS (SELECT 1 FROM payroll_policy_settings WHERE setting_key = 'per_piece_apply_undertime_deduction');

INSERT INTO payroll_policy_settings (setting_key, setting_value, setting_group, description)
SELECT 'per_trip_apply_late_deduction', 'false', 'Piece and Trip Rules', 'Apply late deduction to per-trip payroll only when explicitly enabled.'
WHERE NOT EXISTS (SELECT 1 FROM payroll_policy_settings WHERE setting_key = 'per_trip_apply_late_deduction');

INSERT INTO payroll_policy_settings (setting_key, setting_value, setting_group, description)
SELECT 'per_trip_apply_undertime_deduction', 'false', 'Piece and Trip Rules', 'Apply undertime deduction to per-trip payroll only when explicitly enabled.'
WHERE NOT EXISTS (SELECT 1 FROM payroll_policy_settings WHERE setting_key = 'per_trip_apply_undertime_deduction');
