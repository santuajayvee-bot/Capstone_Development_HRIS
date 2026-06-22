-- UP migration: LGSV HR account and password management
-- Adds account-level password state used by first-time password changes,
-- administrator-assisted resets, and session invalidation.

SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'password_changed_at') = 0,
  'ALTER TABLE users ADD COLUMN password_changed_at DATETIME NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'force_password_change') = 0,
  'ALTER TABLE users ADD COLUMN force_password_change BOOLEAN NOT NULL DEFAULT FALSE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'failed_login_attempts') = 0,
  'ALTER TABLE users ADD COLUMN failed_login_attempts INT NOT NULL DEFAULT 0',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'account_locked_until') = 0,
  'ALTER TABLE users ADD COLUMN account_locked_until DATETIME NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'last_login_at') = 0,
  'ALTER TABLE users ADD COLUMN last_login_at DATETIME NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE users u
LEFT JOIN employees e ON e.id = u.employee_id
SET u.password_changed_at = COALESCE(u.password_changed_at, e.Password_Changed_At),
    u.failed_login_attempts = COALESCE(u.failed_login_attempts, e.Failed_Login_Attempts, 0),
    u.account_locked_until = COALESCE(u.account_locked_until, e.Locked_Until),
    u.last_login_at = COALESCE(u.last_login_at, e.Last_Login_At, u.last_login);

SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'force_password_change') = 0,
  'ALTER TABLE employees ADD COLUMN force_password_change BOOLEAN NOT NULL DEFAULT FALSE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE employees e
JOIN users u ON u.employee_id = e.id
SET e.force_password_change = COALESCE(e.force_password_change, u.force_password_change, FALSE);

SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_password_changed_at') = 0,
  'CREATE INDEX idx_users_password_changed_at ON users (password_changed_at)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_force_password_change') = 0,
  'CREATE INDEX idx_users_force_password_change ON users (force_password_change)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_account_locked_until') = 0,
  'CREATE INDEX idx_users_account_locked_until ON users (account_locked_until)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
