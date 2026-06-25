-- LGSV HR legacy account creation request workflow.
-- New onboarding accounts are created directly by HR Admin/Manager only after
-- approval and transfer, with the role locked to Regular Employee (Level 1).
-- This table remains for existing request records and their audit history.

CREATE TABLE IF NOT EXISTS account_creation_requests (
  request_id BIGINT NOT NULL AUTO_INCREMENT,
  employee_id BIGINT NOT NULL,
  source_applicant_id BIGINT NULL,
  requested_by BIGINT NOT NULL,
  suggested_username VARCHAR(100) NOT NULL,
  default_role_id BIGINT NOT NULL,
  assigned_role_id BIGINT NULL,
  status ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
  account_status ENUM('PENDING', 'ACTIVE', 'DISABLED') NOT NULL DEFAULT 'PENDING',
  account_user_id BIGINT NULL,
  request_note VARCHAR(500) NULL,
  review_reason VARCHAR(500) NULL,
  approved_by BIGINT NULL,
  approved_at DATETIME NULL,
  rejected_by BIGINT NULL,
  rejected_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (request_id),
  INDEX idx_account_request_employee (employee_id, status),
  INDEX idx_account_request_status_created (status, created_at),
  INDEX idx_account_request_requested_by (requested_by, created_at),
  INDEX idx_account_request_account_user (account_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
