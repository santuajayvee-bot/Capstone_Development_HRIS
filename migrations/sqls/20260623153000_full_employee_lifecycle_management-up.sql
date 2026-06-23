ALTER TABLE employees
  MODIFY COLUMN lifecycle_status ENUM('Active','Pending Onboarding','Pending Training','On Hold','For Onboarding','Under Screening','In Training','Rejected','Transferred') NULL DEFAULT 'Active';

ALTER TABLE employees
  MODIFY COLUMN status ENUM('Active','Inactive','Resigned','Terminated','End of Contract','Suspended','Retired','Offboarded','Rehired') NOT NULL DEFAULT 'Active';

SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'token_version') = 0,
  'ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS employee_lifecycle_event (
  lifecycle_event_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  event_type ENUM('ONBOARDED','OFFBOARDED','REONBOARDED','CONTRACT_RENEWED','STATUS_CHANGED') NOT NULL,
  previous_status VARCHAR(40) NULL,
  new_status VARCHAR(40) NULL,
  effective_date DATE NULL,
  reason VARCHAR(180) NULL,
  remarks VARCHAR(500) NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_employee_lifecycle_event_employee (employee_id, created_at),
  INDEX idx_employee_lifecycle_event_type (event_type),
  CONSTRAINT fk_employee_lifecycle_event_employee
    FOREIGN KEY (employee_id) REFERENCES employees(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_employee_lifecycle_event_created_by
    FOREIGN KEY (created_by) REFERENCES users(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS employee_offboarding_case (
  offboarding_case_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  status ENUM('Pending','Approved','Completed','Cancelled') NOT NULL DEFAULT 'Pending',
  offboarding_type ENUM('Resignation','Termination','End of Contract','Retirement','AWOL') NOT NULL,
  separation_type ENUM('Resigned','Terminated','End of Contract','Retired','Offboarded') NOT NULL,
  effective_date DATE NOT NULL,
  last_working_day DATE NOT NULL,
  separation_date DATE NOT NULL,
  separation_reason VARCHAR(180) NOT NULL,
  clearance_status ENUM('Pending','Cleared','Not Cleared') NOT NULL DEFAULT 'Pending',
  final_pay_status ENUM('Pending','For Processing','Processed','Released') NOT NULL DEFAULT 'Pending',
  account_action ENUM('Disable Immediately','Disable on Effective Date') NOT NULL DEFAULT 'Disable on Effective Date',
  account_deactivated TINYINT(1) NOT NULL DEFAULT 0,
  remarks VARCHAR(500) NULL,
  created_by INT NULL,
  completed_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_employee_offboarding_case_employee (employee_id, status),
  CONSTRAINT fk_employee_offboarding_case_employee
    FOREIGN KEY (employee_id) REFERENCES employees(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_employee_offboarding_case_created_by
    FOREIGN KEY (created_by) REFERENCES users(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_employee_offboarding_case_completed_by
    FOREIGN KEY (completed_by) REFERENCES users(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS employee_reonboarding_case (
  reonboarding_case_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  previous_offboarding_case_id BIGINT NULL,
  status ENUM('Pending','Approved','Completed','Cancelled') NOT NULL DEFAULT 'Pending',
  rehire_date DATE NOT NULL,
  department_id INT NULL,
  work_location VARCHAR(160) NULL,
  position VARCHAR(120) NULL,
  employment_type ENUM('Full-time','Part-time','Contractual','Regular') NULL,
  hiring_type ENUM('Direct Hire','Agency-Hired') NULL,
  new_supervisor VARCHAR(120) NULL,
  employee_level ENUM('Rank and File','Supervisor','Manager','Executive') NULL,
  payroll_setup_status ENUM('Pending','Ready') NOT NULL DEFAULT 'Pending',
  assigned_system_role VARCHAR(80) NULL,
  force_password_reset TINYINT(1) NOT NULL DEFAULT 1,
  contract_start_date DATE NULL,
  contract_end_date DATE NULL,
  account_reactivated TINYINT(1) NOT NULL DEFAULT 0,
  remarks VARCHAR(500) NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_employee_reonboarding_case_employee (employee_id, created_at),
  CONSTRAINT fk_employee_reonboarding_case_employee
    FOREIGN KEY (employee_id) REFERENCES employees(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_employee_reonboarding_case_offboarding
    FOREIGN KEY (previous_offboarding_case_id) REFERENCES employee_offboarding_case(offboarding_case_id)
    ON DELETE SET NULL,
  CONSTRAINT fk_employee_reonboarding_case_department
    FOREIGN KEY (department_id) REFERENCES departments(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_employee_reonboarding_case_created_by
    FOREIGN KEY (created_by) REFERENCES users(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
