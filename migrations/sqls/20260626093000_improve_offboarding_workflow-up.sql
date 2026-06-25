ALTER TABLE employee_offboarding_case
  MODIFY COLUMN status ENUM('Pending','In Progress','For Offboarding','Clearance Pending','Payroll Review','Final Approval','Approved','Completed','Offboarded','Inactive','Cancelled') NOT NULL DEFAULT 'For Offboarding',
  MODIFY COLUMN offboarding_type ENUM('Resignation','Termination','End of Contract','Retirement','AWOL','Redundancy') NOT NULL,
  ADD COLUMN IF NOT EXISTS final_attendance_cutoff DATE NULL AFTER payroll_checked_at,
  ADD COLUMN IF NOT EXISTS unpaid_salary DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER final_attendance_cutoff,
  ADD COLUMN IF NOT EXISTS final_deductions DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER unpaid_salary,
  ADD COLUMN IF NOT EXISTS final_allowances DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER final_deductions,
  ADD COLUMN IF NOT EXISTS pending_benefits DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER final_allowances;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS offboarding_clearance_result ENUM('Pending','Cleared','Not Cleared','Not Applicable') NULL AFTER offboarding_remarks;

CREATE TABLE IF NOT EXISTS employee_offboarding_clearance_item (
  clearance_item_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  offboarding_case_id BIGINT NOT NULL,
  item_key VARCHAR(80) NOT NULL,
  item_label VARCHAR(160) NOT NULL,
  status ENUM('Pending','Cleared','Not Applicable') NOT NULL DEFAULT 'Pending',
  checked_by INT NULL,
  checked_at DATETIME NULL,
  remarks VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_offboarding_clearance_item (offboarding_case_id, item_key),
  INDEX idx_offboarding_clearance_item_case (offboarding_case_id, status),
  INDEX idx_offboarding_clearance_item_checked_by (checked_by),
  CONSTRAINT fk_offboarding_clearance_item_case
    FOREIGN KEY (offboarding_case_id) REFERENCES employee_offboarding_case(offboarding_case_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_offboarding_clearance_item_checked_by
    FOREIGN KEY (checked_by) REFERENCES users(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
