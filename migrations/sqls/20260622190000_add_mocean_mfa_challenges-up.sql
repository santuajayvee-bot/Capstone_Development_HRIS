-- UP migration: Mocean Verify MFA challenge state for LGSV HR.
-- Phone numbers remain in employees.contact_number; this table stores no OTP.

CREATE TABLE IF NOT EXISTS MFA_CHALLENGE (
  Challenge_ID BIGINT PRIMARY KEY AUTO_INCREMENT,
  Employee_ID BIGINT NOT NULL,
  Provider VARCHAR(50) NOT NULL DEFAULT 'mocean',
  Provider_Request_ID VARCHAR(255) NULL,
  Challenge_Token_Hash CHAR(64) NOT NULL,
  Status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  Attempt_Count INT NOT NULL DEFAULT 0,
  Resend_Count INT NOT NULL DEFAULT 0,
  Last_Sent_At DATETIME NULL,
  Expires_At DATETIME NOT NULL,
  Verified_At DATETIME NULL,
  Created_At DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  Updated_At DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_mfa_challenge_employee
    FOREIGN KEY (Employee_ID)
    REFERENCES employees (Employee_ID)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  INDEX idx_mfa_challenge_employee_status (Employee_ID, Status),
  INDEX idx_mfa_challenge_expires (Expires_At),
  INDEX idx_mfa_challenge_provider_request (Provider_Request_ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
