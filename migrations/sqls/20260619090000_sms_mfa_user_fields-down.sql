-- DOWN migration: SMS MFA account fields and challenge metadata

DROP TABLE IF EXISTS MFA_CHALLENGE;

DROP INDEX IF EXISTS idx_users_mfa
  ON users;

DROP INDEX IF EXISTS idx_users_phone_number
  ON users;

ALTER TABLE users
  DROP COLUMN IF EXISTS mfa_verified_at,
  DROP COLUMN IF EXISTS mfa_method,
  DROP COLUMN IF EXISTS mfa_enabled,
  DROP COLUMN IF EXISTS phone_number;
