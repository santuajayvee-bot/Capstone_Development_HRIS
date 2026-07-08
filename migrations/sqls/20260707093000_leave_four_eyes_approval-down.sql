UPDATE leave_requests
   SET status = 'Pending'
 WHERE status = 'Payroll Approved';

ALTER TABLE leave_requests
  DROP COLUMN IF EXISTS payroll_approval_remarks_encrypted;

ALTER TABLE leave_requests
  DROP COLUMN IF EXISTS payroll_approval_remarks;

ALTER TABLE leave_requests
  DROP COLUMN IF EXISTS payroll_approved_at;

ALTER TABLE leave_requests
  DROP COLUMN IF EXISTS payroll_approved_by;

ALTER TABLE leave_requests
  MODIFY status ENUM('Pending','Approved','Rejected','Denied','Cancelled') DEFAULT 'Pending';
