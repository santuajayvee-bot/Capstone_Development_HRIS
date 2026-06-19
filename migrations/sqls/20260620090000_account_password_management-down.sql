-- DOWN migration: remove LGSV HR account and password management fields.

DROP INDEX IF EXISTS idx_users_account_locked_until
  ON users;

DROP INDEX IF EXISTS idx_users_force_password_change
  ON users;

DROP INDEX IF EXISTS idx_users_password_changed_at
  ON users;

ALTER TABLE employees
  DROP COLUMN IF EXISTS force_password_change;

ALTER TABLE users
  DROP COLUMN IF EXISTS last_login_at,
  DROP COLUMN IF EXISTS account_locked_until,
  DROP COLUMN IF EXISTS failed_login_attempts,
  DROP COLUMN IF EXISTS force_password_change,
  DROP COLUMN IF EXISTS password_changed_at;
