-- DOWN migration: authentication, password security, and session management
-- Scope: schema rollback only.

DROP TABLE IF EXISTS PASSWORD_RESET_TOKEN;

DROP TABLE IF EXISTS USER_SESSION;

ALTER TABLE system_audit_log
  DROP FOREIGN KEY IF EXISTS fk_system_audit_log_employee_auth;

DROP INDEX IF EXISTS idx_system_audit_log_created_at
  ON system_audit_log;

DROP INDEX IF EXISTS idx_system_audit_log_action_type
  ON system_audit_log;

DROP INDEX IF EXISTS idx_system_audit_log_employee_id
  ON system_audit_log;

ALTER TABLE system_audit_log
  MODIFY COLUMN user_agent VARCHAR(500) NULL;

ALTER TABLE system_audit_log
  DROP COLUMN IF EXISTS Created_At,
  DROP COLUMN IF EXISTS Description,
  DROP COLUMN IF EXISTS Action_Type;

ALTER TABLE employees
  DROP COLUMN IF EXISTS Last_Login_At,
  DROP COLUMN IF EXISTS MFA_Enabled,
  DROP COLUMN IF EXISTS Locked_Until,
  DROP COLUMN IF EXISTS Failed_Login_Attempts,
  DROP COLUMN IF EXISTS Password_Changed_At,
  DROP COLUMN IF EXISTS Password_Hash;

DROP INDEX IF EXISTS uq_employees_employee_id
  ON employees;

ALTER TABLE employees
  DROP COLUMN IF EXISTS Employee_ID;

