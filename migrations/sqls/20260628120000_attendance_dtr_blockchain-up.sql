-- UP migration: Attendance DTR blockchain anchoring.
-- Raw attendance logs, biometric data, full DTR lines, and employee PII stay
-- off-chain. Hyperledger Fabric receives only DTR hashes and audit metadata.

CREATE TABLE IF NOT EXISTS DTR_RECORD (
  DTR_ID BIGINT AUTO_INCREMENT PRIMARY KEY,
  Employee_ID BIGINT NOT NULL,
  Date_Range_Start DATE NOT NULL,
  Date_Range_End DATE NOT NULL,
  Total_Work_Hours DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  Total_Late_Minutes INT NOT NULL DEFAULT 0,
  Total_Undertime_Minutes INT NOT NULL DEFAULT 0,
  Total_Overtime_Hours DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  Attendance_Status VARCHAR(50) NOT NULL DEFAULT 'FINALIZED',
  Generated_By BIGINT NULL,
  Verified_By BIGINT NULL,
  Finalized_At DATETIME NULL,
  DTR_Hash CHAR(64) NULL,
  Transaction_Hash VARCHAR(255) NULL,
  Blockchain_Status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  Source_Summary_Count INT NOT NULL DEFAULT 0,
  Audit_Summary JSON NULL,
  Remarks VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_dtr_record_employee_range (Employee_ID, Date_Range_Start, Date_Range_End),
  INDEX idx_dtr_record_status (Attendance_Status, Blockchain_Status),
  INDEX idx_dtr_record_hash (DTR_Hash),
  INDEX idx_dtr_record_transaction (Transaction_Hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS DTR_BLOCKCHAIN_AUDIT_LOG (
  Audit_ID BIGINT AUTO_INCREMENT PRIMARY KEY,
  DTR_ID BIGINT NOT NULL,
  Event_Type VARCHAR(80) NOT NULL,
  Actor_User_ID BIGINT NULL,
  Actor_Role VARCHAR(80) NULL,
  Transaction_Hash VARCHAR(255) NULL,
  Payload_Hash CHAR(64) NULL,
  Status VARCHAR(50) NOT NULL,
  IP_Address VARCHAR(45) NULL,
  Details JSON NULL,
  Created_At DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_dtr_blockchain_audit_dtr (DTR_ID),
  INDEX idx_dtr_blockchain_audit_status (Status, Created_At),
  INDEX idx_dtr_blockchain_audit_hash (Payload_Hash),
  CONSTRAINT fk_dtr_blockchain_audit_record
    FOREIGN KEY (DTR_ID) REFERENCES DTR_RECORD(DTR_ID)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS DTR_ADJUSTMENT_RECORD (
  Adjustment_ID BIGINT AUTO_INCREMENT PRIMARY KEY,
  DTR_ID BIGINT NOT NULL,
  Adjustment_Reference VARCHAR(120) NOT NULL,
  Reason VARCHAR(500) NOT NULL,
  Previous_DTR_Hash CHAR(64) NULL,
  Adjustment_Hash CHAR(64) NOT NULL,
  Transaction_Hash VARCHAR(255) NULL,
  Blockchain_Status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  Created_By BIGINT NULL,
  Created_At DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  Details JSON NULL,
  INDEX idx_dtr_adjustment_dtr (DTR_ID),
  INDEX idx_dtr_adjustment_hash (Adjustment_Hash),
  INDEX idx_dtr_adjustment_status (Blockchain_Status, Created_At),
  CONSTRAINT fk_dtr_adjustment_record
    FOREIGN KEY (DTR_ID) REFERENCES DTR_RECORD(DTR_ID)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
