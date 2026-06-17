-- DOWN migration: permissioned blockchain payroll audit layer
-- Keeps PAYROLL_RECORD rows, but removes the blockchain audit layer additions.

DROP TABLE IF EXISTS BLOCKCHAIN_AUDIT_LOG;

DROP INDEX IF EXISTS idx_payroll_record_hash
  ON PAYROLL_RECORD;

DROP INDEX IF EXISTS idx_payroll_record_status
  ON PAYROLL_RECORD;

DROP INDEX IF EXISTS idx_payroll_record_employee
  ON PAYROLL_RECORD;

ALTER TABLE PAYROLL_RECORD
  DROP COLUMN IF EXISTS Approved_By,
  DROP COLUMN IF EXISTS Finalized_At,
  DROP COLUMN IF EXISTS Blockchain_Status,
  DROP COLUMN IF EXISTS Transaction_Hash;

DROP INDEX IF EXISTS idx_system_audit_action_type
  ON system_audit_log;

DROP INDEX IF EXISTS idx_system_audit_module_time
  ON system_audit_log;

DROP INDEX IF EXISTS idx_system_audit_employee
  ON system_audit_log;
