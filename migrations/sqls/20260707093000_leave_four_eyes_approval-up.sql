ALTER TABLE leave_requests
  MODIFY status ENUM('Pending','Payroll Approved','Approved','Rejected','Denied','Cancelled') DEFAULT 'Pending';

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS payroll_approved_by INT NULL AFTER reviewed_at;

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS payroll_approved_at DATETIME NULL AFTER payroll_approved_by;

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS payroll_approval_remarks TEXT NULL AFTER payroll_approved_at;

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS payroll_approval_remarks_encrypted TEXT NULL AFTER payroll_approval_remarks;
