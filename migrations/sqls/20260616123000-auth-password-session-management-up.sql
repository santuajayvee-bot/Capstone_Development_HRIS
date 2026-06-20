-- UP migration: authentication, password security, and session management
-- Scope: schema only. Controllers, middleware, and JWT logic are intentionally excluded.

-- The existing application schema uses `employees` as the employee table.
-- This BIGINT alias supports capstone-style Employee_ID foreign keys without
-- changing the existing employees.id primary key used by current code.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS Employee_ID BIGINT NULL;

UPDATE employees
SET Employee_ID = id
WHERE Employee_ID IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_employee_id
  ON employees (Employee_ID);

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS Password_Hash VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS Password_Changed_At DATETIME NULL,
  ADD COLUMN IF NOT EXISTS Failed_Login_Attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS Locked_Until DATETIME NULL,
  ADD COLUMN IF NOT EXISTS Last_Login_At DATETIME NULL;

-- Placeholder for legacy rows so Password_Hash can be enforced as NOT NULL.
-- This is an Argon2id hash of a random undisclosed value and should be replaced
-- by a password reset/change flow before real user authentication is enabled.
UPDATE employees
SET Password_Hash = '$argon2id$v=19$m=65536,t=3,p=4$UN3Vj2Q3XboTxUKpDT2Vmg$PSQY6d7QaTx3VvJtjFTlV57rngCnukZRU2tXzMqohXk'
WHERE Password_Hash IS NULL OR Password_Hash = '';

ALTER TABLE employees
  MODIFY COLUMN Password_Hash VARCHAR(255) NOT NULL;

CREATE TABLE IF NOT EXISTS USER_SESSION (
  Session_ID BIGINT PRIMARY KEY AUTO_INCREMENT,
  Employee_ID BIGINT NOT NULL,
  Refresh_Token_Hash VARCHAR(255) NOT NULL,
  JWT_ID VARCHAR(255) NOT NULL,
  IP_Address VARCHAR(45) NULL,
  User_Agent TEXT NULL,
  Created_At DATETIME DEFAULT CURRENT_TIMESTAMP,
  Last_Activity DATETIME DEFAULT CURRENT_TIMESTAMP,
  Expires_At DATETIME NOT NULL,
  Revoked_At DATETIME NULL,
  Revocation_Reason VARCHAR(100) NULL,
  CONSTRAINT fk_user_session_employee
    FOREIGN KEY (Employee_ID)
    REFERENCES employees (Employee_ID)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  UNIQUE KEY uq_user_session_jwt_id (JWT_ID),
  INDEX idx_user_session_employee_id (Employee_ID),
  INDEX idx_user_session_expires_at (Expires_At),
  INDEX idx_user_session_revoked_at (Revoked_At)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS PASSWORD_RESET_TOKEN (
  Reset_ID BIGINT PRIMARY KEY AUTO_INCREMENT,
  Employee_ID BIGINT NOT NULL,
  Reset_Token_Hash VARCHAR(255) NOT NULL,
  Created_At DATETIME DEFAULT CURRENT_TIMESTAMP,
  Expires_At DATETIME NOT NULL,
  Used_At DATETIME NULL,
  IP_Address VARCHAR(45) NULL,
  CONSTRAINT fk_password_reset_token_employee
    FOREIGN KEY (Employee_ID)
    REFERENCES employees (Employee_ID)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  INDEX idx_password_reset_token_employee_id (Employee_ID),
  INDEX idx_password_reset_token_expires_at (Expires_At),
  INDEX idx_password_reset_token_used_at (Used_At)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Auth-related audit action values expected by the application layer:
-- LOGIN_SUCCESS, LOGIN_FAILED, ACCOUNT_LOCKED, LOGOUT, LOGOUT_ALL_SESSIONS,
-- TOKEN_REFRESH, PASSWORD_CHANGE, PASSWORD_RESET_REQUEST, PASSWORD_RESET_SUCCESS.
CREATE TABLE IF NOT EXISTS system_audit_log (
  Log_ID BIGINT PRIMARY KEY AUTO_INCREMENT,
  Employee_ID BIGINT NULL,
  Action_Type VARCHAR(100) NOT NULL,
  Description TEXT NULL,
  IP_Address VARCHAR(45) NULL,
  User_Agent TEXT NULL,
  Created_At DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_system_audit_log_employee_auth
    FOREIGN KEY (Employee_ID)
    REFERENCES employees (Employee_ID)
    ON UPDATE CASCADE
    ON DELETE SET NULL,
  INDEX idx_system_audit_log_employee_id (Employee_ID),
  INDEX idx_system_audit_log_action_type (Action_Type),
  INDEX idx_system_audit_log_created_at (Created_At)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- If system_audit_log already exists, extend it with the required auth fields.
-- Existing lower-case audit columns such as employee_id, ip_address, and user_agent
-- are retained because MySQL treats column names case-insensitively.
ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS Action_Type VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS Description TEXT NULL,
  ADD COLUMN IF NOT EXISTS Created_At DATETIME NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE system_audit_log
SET Action_Type = COALESCE(NULLIF(Action_Type, ''), 'SYSTEM_EVENT')
WHERE Action_Type IS NULL OR Action_Type = '';

ALTER TABLE system_audit_log
  MODIFY COLUMN Action_Type VARCHAR(100) NOT NULL;

ALTER TABLE system_audit_log
  MODIFY COLUMN user_agent TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_system_audit_log_employee_id
  ON system_audit_log (employee_id);

CREATE INDEX IF NOT EXISTS idx_system_audit_log_action_type
  ON system_audit_log (Action_Type);

CREATE INDEX IF NOT EXISTS idx_system_audit_log_created_at
  ON system_audit_log (Created_At);
