-- DOWN migration: restore pre-review payroll lifecycle statuses.

UPDATE salary_calculations
   SET status = 'Submitted'
 WHERE status IN ('For Review','For Approval','Locked');

UPDATE payslips
   SET status = 'Approved'
 WHERE status IN ('For Review','For Approval','Locked');

UPDATE payroll_runs
   SET status = 'Generated'
 WHERE status IN ('For Review','For Approval','Locked');

ALTER TABLE payslips
  MODIFY COLUMN status ENUM('Pending','Approved','Disbursed','Cancelled') DEFAULT 'Pending';

ALTER TABLE payroll_runs
  MODIFY COLUMN status ENUM('Draft','Generated','Approved','Released','Cancelled') DEFAULT 'Draft';

ALTER TABLE salary_calculations
  MODIFY COLUMN status ENUM('Draft','Submitted','Approved','Finalized','Paid','Released','Superseded','Cancelled') DEFAULT 'Submitted';

ALTER TABLE piece_rate_outputs
  DROP COLUMN IF EXISTS updated_by,
  DROP COLUMN IF EXISTS paid_at,
  DROP COLUMN IF EXISTS verified_at,
  DROP COLUMN IF EXISTS verified_by,
  DROP COLUMN IF EXISTS submitted_at,
  DROP COLUMN IF EXISTS submitted_by,
  DROP COLUMN IF EXISTS payroll_run_id,
  DROP COLUMN IF EXISTS remarks;

DELETE FROM payroll_policy_settings
 WHERE setting_key IN (
   'per_piece_apply_late_deduction',
   'per_piece_apply_undertime_deduction',
   'per_trip_apply_late_deduction',
   'per_trip_apply_undertime_deduction'
 );
