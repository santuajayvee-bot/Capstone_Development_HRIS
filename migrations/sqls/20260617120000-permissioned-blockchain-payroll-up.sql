-- UP migration: permissioned blockchain payroll audit layer
-- LGSV HR stores operational payroll data in MySQL and records only finalized
-- payroll hashes plus audit metadata on Hyperledger Fabric.

CREATE TABLE IF NOT EXISTS PAYROLL_RECORD (
  Payroll_ID BIGINT PRIMARY KEY,
  Employee_ID BIGINT NOT NULL,
  Gross_Pay DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  Total_Statutory_Deductions DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  Net_Pay DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  Non_Taxable_Allowance DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  Approval_Status VARCHAR(50) NOT NULL DEFAULT 'Draft',
  Transaction_Hash VARCHAR(255) NULL,
  Blockchain_Status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  Finalized_At DATETIME NULL,
  Approved_By BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE PAYROLL_RECORD
  ADD COLUMN IF NOT EXISTS Transaction_Hash VARCHAR(255) NULL;

ALTER TABLE PAYROLL_RECORD
  ADD COLUMN IF NOT EXISTS Blockchain_Status VARCHAR(50) NOT NULL DEFAULT 'PENDING';

ALTER TABLE PAYROLL_RECORD
  ADD COLUMN IF NOT EXISTS Finalized_At DATETIME NULL;

ALTER TABLE PAYROLL_RECORD
  ADD COLUMN IF NOT EXISTS Approved_By BIGINT NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_record_employee
  ON PAYROLL_RECORD (Employee_ID);

CREATE INDEX IF NOT EXISTS idx_payroll_record_status
  ON PAYROLL_RECORD (Approval_Status, Blockchain_Status);

CREATE INDEX IF NOT EXISTS idx_payroll_record_hash
  ON PAYROLL_RECORD (Transaction_Hash);

CREATE TABLE IF NOT EXISTS system_audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  employee_id BIGINT NULL,
  target_employee_id BIGINT NULL,
  action_performed TEXT NOT NULL,
  module VARCHAR(80) NULL,
  old_value TEXT NULL,
  new_value TEXT NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(500) NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  Action_Type VARCHAR(100) NOT NULL DEFAULT 'SYSTEM_EVENT',
  Description TEXT NULL,
  Created_At DATETIME NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS user_id INT NULL;

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS employee_id BIGINT NULL;

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS target_employee_id BIGINT NULL;

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS action_performed TEXT NULL;

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS Action_Type VARCHAR(100) NULL;

UPDATE system_audit_log
   SET action_performed = COALESCE(NULLIF(action_performed, ''), COALESCE(Action_Type, 'SYSTEM_EVENT'))
 WHERE action_performed IS NULL OR action_performed = '';

ALTER TABLE system_audit_log
  MODIFY COLUMN action_performed TEXT NOT NULL;

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS module VARCHAR(80) NULL;

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS old_value TEXT NULL;

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS new_value TEXT NULL;

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45) NULL;

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS user_agent VARCHAR(500) NULL;

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS timestamp DATETIME DEFAULT CURRENT_TIMESTAMP;

UPDATE system_audit_log
   SET Action_Type = COALESCE(NULLIF(Action_Type, ''), 'SYSTEM_EVENT')
 WHERE Action_Type IS NULL OR Action_Type = '';

ALTER TABLE system_audit_log
  MODIFY COLUMN Action_Type VARCHAR(100) NOT NULL DEFAULT 'SYSTEM_EVENT';

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS Description TEXT NULL;

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS Created_At DATETIME NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_system_audit_employee
  ON system_audit_log (employee_id);

CREATE INDEX IF NOT EXISTS idx_system_audit_module_time
  ON system_audit_log (module, timestamp);

CREATE INDEX IF NOT EXISTS idx_system_audit_action_type
  ON system_audit_log (Action_Type);

CREATE TABLE IF NOT EXISTS BLOCKCHAIN_AUDIT_LOG (
  Audit_ID BIGINT AUTO_INCREMENT PRIMARY KEY,
  Payroll_ID BIGINT NOT NULL,
  Event_Type VARCHAR(80) NOT NULL,
  Actor_User_ID BIGINT NULL,
  Actor_Role VARCHAR(80) NULL,
  Transaction_Hash VARCHAR(255) NULL,
  Payload_Hash CHAR(64) NULL,
  Status VARCHAR(50) NOT NULL,
  IP_Address VARCHAR(45) NULL,
  Details JSON NULL,
  Created_At DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_blockchain_audit_payroll (Payroll_ID),
  INDEX idx_blockchain_audit_status (Status, Created_At),
  INDEX idx_blockchain_audit_hash (Payload_Hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
