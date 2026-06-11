-- Permissioned Blockchain Payroll Integrity Migration
-- LGSV HR / Authentica HR
-- Stores sensitive payroll values off-chain in MySQL and records only SHA-256
-- hashes plus audit receipts on Hyperledger Fabric.

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
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_payroll_record_employee (Employee_ID),
  INDEX idx_payroll_record_status (Approval_Status, Blockchain_Status),
  INDEX idx_payroll_record_hash (Transaction_Hash)
);

ALTER TABLE PAYROLL_RECORD
  ADD COLUMN IF NOT EXISTS Transaction_Hash VARCHAR(255) NULL;

ALTER TABLE PAYROLL_RECORD
  ADD COLUMN IF NOT EXISTS Blockchain_Status VARCHAR(50) NOT NULL DEFAULT 'PENDING';

ALTER TABLE PAYROLL_RECORD
  ADD COLUMN IF NOT EXISTS Finalized_At DATETIME NULL;

ALTER TABLE PAYROLL_RECORD
  ADD COLUMN IF NOT EXISTS Approved_By BIGINT NULL;

CREATE TABLE IF NOT EXISTS system_audit_log (
  log_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  employee_id BIGINT NULL,
  target_employee_id BIGINT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  action_performed TEXT NOT NULL,
  module VARCHAR(80) NULL,
  old_value TEXT NULL,
  new_value TEXT NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(500) NULL,
  INDEX idx_system_audit_employee (employee_id),
  INDEX idx_system_audit_module_time (module, timestamp)
);

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS target_employee_id BIGINT NULL AFTER employee_id;

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS module VARCHAR(80) NULL AFTER action_performed;

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS old_value TEXT NULL AFTER module;

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS new_value TEXT NULL AFTER old_value;

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS user_agent VARCHAR(500) NULL AFTER ip_address;

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
);
