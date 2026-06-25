UPDATE documents
   SET document_type = 'Other'
 WHERE document_type IN (
   'Separation_Notice',
   'Offboarding_Clearance',
   'Property_Return',
   'Attendance_Timesheet',
   'Final_Pay_Computation',
   'COE_Request',
   'Exit_Interview',
   'Final_Pay_Acknowledgement'
 );

SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'documents'
      AND INDEX_NAME = 'idx_documents_offboarding_case') > 0,
  'ALTER TABLE documents DROP INDEX idx_documents_offboarding_case',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;

ALTER TABLE documents
  MODIFY COLUMN document_type ENUM('Resume','Government_ID','NBI_Clearance','Contract','Other') NOT NULL,
  DROP COLUMN IF EXISTS offboarding_case_id,
  DROP COLUMN IF EXISTS document_stage,
  DROP COLUMN IF EXISTS uploaded_by;
