-- UP migration: LGSV HR account and password management
-- Adds account-level password state used by first-time password changes,
-- administrator-assisted resets, and session invalidation.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_changed_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS account_locked_until DATETIME NULL,
  ADD COLUMN IF NOT EXISTS last_login_at DATETIME NULL;

UPDATE users u
LEFT JOIN employees e ON e.id = u.employee_id
SET u.password_changed_at = COALESCE(u.password_changed_at, e.Password_Changed_At),
    u.failed_login_attempts = COALESCE(u.failed_login_attempts, e.Failed_Login_Attempts, 0),
    u.account_locked_until = COALESCE(u.account_locked_until, e.Locked_Until),
    u.last_login_at = COALESCE(u.last_login_at, e.Last_Login_At, u.last_login);

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE employees e
JOIN users u ON u.employee_id = e.id
SET e.force_password_change = COALESCE(e.force_password_change, u.force_password_change, FALSE);

CREATE INDEX IF NOT EXISTS idx_users_password_changed_at
  ON users (password_changed_at);

CREATE INDEX IF NOT EXISTS idx_users_force_password_change
  ON users (force_password_change);

CREATE INDEX IF NOT EXISTS idx_users_account_locked_until
  ON users (account_locked_until);
