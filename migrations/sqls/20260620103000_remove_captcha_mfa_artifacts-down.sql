-- DOWN migration: recreate retired CAPTCHA/MFA database artifacts.
-- This exists only to keep the migration reversible.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS MFA_Enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS mfa_method VARCHAR(20) NOT NULL DEFAULT 'sms',
  ADD COLUMN IF NOT EXISTS mfa_verified_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS otp_hash VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS otp_expires_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS otp_attempt_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS otp_last_sent_at DATETIME NULL;

CREATE INDEX IF NOT EXISTS idx_users_mfa
  ON users (mfa_enabled, mfa_method);

CREATE INDEX IF NOT EXISTS idx_users_otp_expires
  ON users (otp_expires_at);

CREATE TABLE IF NOT EXISTS MFA_CHALLENGE (
  Challenge_ID BIGINT PRIMARY KEY AUTO_INCREMENT,
  User_ID BIGINT NOT NULL,
  Phone_Number VARCHAR(20) NULL,
  Method VARCHAR(20) NOT NULL DEFAULT 'sms',
  Provider VARCHAR(30) NULL,
  Status VARCHAR(30) NOT NULL DEFAULT 'pending',
  OTP_Hash VARCHAR(255) NULL,
  OTP_Expires_At DATETIME NULL,
  Attempt_Count INT NOT NULL DEFAULT 0,
  Created_At DATETIME DEFAULT CURRENT_TIMESTAMP,
  Expires_At DATETIME NOT NULL,
  Verified_At DATETIME NULL,
  INDEX idx_mfa_challenge_user_status (User_ID, Status),
  INDEX idx_mfa_challenge_expires (Expires_At),
  INDEX idx_mfa_challenge_phone (Phone_Number),
  INDEX idx_mfa_challenge_otp_expires (OTP_Expires_At),
  CONSTRAINT fk_mfa_challenge_user
    FOREIGN KEY (User_ID)
    REFERENCES users (id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
