-- Migration: Add document verification columns to documents table
-- This adds support for document verification status tracking and audit trail

ALTER TABLE documents ADD COLUMN verification_status ENUM('Pending','Verified','Rejected') DEFAULT 'Pending' AFTER file_path;
ALTER TABLE documents ADD COLUMN verified_by INT NULL AFTER verification_status;
ALTER TABLE documents ADD COLUMN verified_at TIMESTAMP NULL AFTER verified_by;
ALTER TABLE documents ADD COLUMN rejection_reason TEXT NULL AFTER verified_at;
ALTER TABLE documents ADD FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL;

-- Create sensitive_employee_data table if it doesn't exist
CREATE TABLE IF NOT EXISTS sensitive_employee_data (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL UNIQUE,
  ssn VARCHAR(20) NULL,
  tax_id VARCHAR(50) NULL,
  bank_account_number VARCHAR(100) NULL,
  bank_routing_number VARCHAR(50) NULL,
  emergency_contact_phone VARCHAR(20) NULL,
  other_sensitive_info TEXT NULL,
  updated_by INT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Create employee_201_file_access_log table if it doesn't exist
CREATE TABLE IF NOT EXISTS employee_201_file_access_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  accessed_by INT NOT NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(100) NULL,
  resource_id INT NULL,
  details JSON NULL,
  accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (accessed_by) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_employee_accessed (employee_id, accessed_at),
  INDEX idx_accessed_by (accessed_by)
);

-- Update documents table to ensure it has the new columns (if adding to existing table)
-- This update statement is safe if columns already exist
ALTER TABLE documents MODIFY COLUMN document_type ENUM('Resume','Government_ID','NBI_Clearance','Contract','Other') NOT NULL;
