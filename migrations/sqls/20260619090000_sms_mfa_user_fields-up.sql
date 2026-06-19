-- UP migration: SMS MFA account fields and challenge metadata
-- OTP codes are never stored. Twilio Verify owns code generation and checking.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS mfa_method VARCHAR(20) NOT NULL DEFAULT 'sms',
  ADD COLUMN IF NOT EXISTS mfa_verified_at DATETIME NULL;

CREATE INDEX IF NOT EXISTS idx_users_phone_number
  ON users (phone_number);

CREATE INDEX IF NOT EXISTS idx_users_mfa
  ON users (mfa_enabled, mfa_method);

CREATE TABLE IF NOT EXISTS MFA_CHALLENGE (
  Challenge_ID BIGINT PRIMARY KEY AUTO_INCREMENT,
  User_ID INT NOT NULL,
  Employee_ID BIGINT NOT NULL,
  Phone_Number VARCHAR(20) NOT NULL,
  Method VARCHAR(20) NOT NULL DEFAULT 'sms',
  Status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  Send_Count INT NOT NULL DEFAULT 1,
  Verify_Attempt_Count INT NOT NULL DEFAULT 0,
  Last_Sent_At DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  Expires_At DATETIME NOT NULL,
  Completed_At DATETIME NULL,
  Created_At DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  Updated_At DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_mfa_challenge_user_status (User_ID, Status),
  INDEX idx_mfa_challenge_expires (Expires_At),
  INDEX idx_mfa_challenge_phone (Phone_Number),
  CONSTRAINT fk_mfa_challenge_user
    FOREIGN KEY (User_ID)
    REFERENCES users (id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
