-- UP migration: Semaphore PH SMS OTP fields
-- Semaphore is only the SMS gateway. LGSV HR generates the OTP and stores
-- only its hash plus expiry/attempt metadata; plaintext OTPs are never stored.

ALTER TABLE MFA_CHALLENGE
  ADD COLUMN IF NOT EXISTS OTP_Hash VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS OTP_Expires_At DATETIME NULL,
  ADD COLUMN IF NOT EXISTS OTP_Attempt_Count INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_mfa_challenge_otp_expires
  ON MFA_CHALLENGE (OTP_Expires_At);
