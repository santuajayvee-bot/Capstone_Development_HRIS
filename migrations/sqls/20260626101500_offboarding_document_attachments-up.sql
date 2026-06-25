ALTER TABLE documents
  MODIFY COLUMN document_type ENUM(
    'Resume',
    'Government_ID',
    'NBI_Clearance',
    'Contract',
    'Other',
    'Separation_Notice',
    'Offboarding_Clearance',
    'Property_Return',
    'Attendance_Timesheet',
    'Final_Pay_Computation',
    'COE_Request',
    'Exit_Interview',
    'Final_Pay_Acknowledgement'
  ) NOT NULL,
  ADD COLUMN IF NOT EXISTS offboarding_case_id BIGINT NULL AFTER employee_id,
  ADD COLUMN IF NOT EXISTS document_stage ENUM('Employee Profile','Offboarding') NOT NULL DEFAULT 'Employee Profile' AFTER document_type,
  ADD COLUMN IF NOT EXISTS uploaded_by INT NULL AFTER uploaded_date;

SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'documents'
      AND INDEX_NAME = 'idx_documents_offboarding_case') = 0,
  'CREATE INDEX idx_documents_offboarding_case ON documents (offboarding_case_id, document_stage, uploaded_date)',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;
