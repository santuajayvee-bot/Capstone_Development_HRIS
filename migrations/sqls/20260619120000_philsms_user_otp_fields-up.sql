-- UP migration: PhilSMS backend-owned SMS OTP fields
-- PhilSMS sends the SMS only. LGSV HR stores only OTP hash and metadata.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS otp_hash VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS otp_expires_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS otp_attempt_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS otp_last_sent_at DATETIME NULL;

CREATE INDEX IF NOT EXISTS idx_users_otp_expires
  ON users (otp_expires_at);
