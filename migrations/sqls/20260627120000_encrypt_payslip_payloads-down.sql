ALTER TABLE payslips
  DROP COLUMN IF EXISTS payslip_payload_encrypted_at,
  DROP COLUMN IF EXISTS payslip_payload_hash,
  DROP COLUMN IF EXISTS payslip_payload_encrypted;

ALTER TABLE salary_calculations
  DROP COLUMN IF EXISTS payslip_payload_encrypted_at,
  DROP COLUMN IF EXISTS payslip_payload_hash,
  DROP COLUMN IF EXISTS payslip_payload_encrypted;
