ALTER TABLE salary_calculations
  ADD COLUMN IF NOT EXISTS payslip_payload_encrypted LONGTEXT NULL AFTER source_record_ids,
  ADD COLUMN IF NOT EXISTS payslip_payload_hash CHAR(64) NULL AFTER payslip_payload_encrypted,
  ADD COLUMN IF NOT EXISTS payslip_payload_encrypted_at DATETIME NULL AFTER payslip_payload_hash;

ALTER TABLE payslips
  ADD COLUMN IF NOT EXISTS payslip_payload_encrypted LONGTEXT NULL AFTER source_summary,
  ADD COLUMN IF NOT EXISTS payslip_payload_hash CHAR(64) NULL AFTER payslip_payload_encrypted,
  ADD COLUMN IF NOT EXISTS payslip_payload_encrypted_at DATETIME NULL AFTER payslip_payload_hash;
