-- UP migration: remove retired CAPTCHA/MFA database artifacts.
-- LGSV HR login currently uses username/password, Argon2id, JWT sessions,
-- RBAC, account lockout, and audit logging without Turnstile or SMS MFA.

DROP TABLE IF EXISTS MFA_CHALLENGE;

DROP INDEX IF EXISTS idx_users_otp_expires
  ON users;

DROP INDEX IF EXISTS idx_users_mfa
  ON users;

ALTER TABLE users
  DROP COLUMN IF EXISTS otp_last_sent_at,
  DROP COLUMN IF EXISTS otp_attempt_count,
  DROP COLUMN IF EXISTS otp_expires_at,
  DROP COLUMN IF EXISTS otp_hash,
  DROP COLUMN IF EXISTS mfa_verified_at,
  DROP COLUMN IF EXISTS mfa_method,
  DROP COLUMN IF EXISTS mfa_enabled,
  DROP COLUMN IF EXISTS phone_number;

ALTER TABLE employees
  DROP COLUMN IF EXISTS MFA_Enabled;
