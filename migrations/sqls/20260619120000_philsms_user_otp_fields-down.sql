-- DOWN migration: PhilSMS backend-owned SMS OTP fields

DROP INDEX IF EXISTS idx_users_otp_expires
  ON users;

ALTER TABLE users
  DROP COLUMN IF EXISTS otp_last_sent_at,
  DROP COLUMN IF EXISTS otp_attempt_count,
  DROP COLUMN IF EXISTS otp_expires_at,
  DROP COLUMN IF EXISTS otp_hash;
