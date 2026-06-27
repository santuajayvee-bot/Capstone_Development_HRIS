ALTER TABLE payslips
  DROP COLUMN IF EXISTS payslip_storage_encrypted_at,
  DROP COLUMN IF EXISTS source_summary_encrypted,
  DROP COLUMN IF EXISTS net_pay_encrypted,
  DROP COLUMN IF EXISTS total_deduction_encrypted,
  DROP COLUMN IF EXISTS total_earning_encrypted;
