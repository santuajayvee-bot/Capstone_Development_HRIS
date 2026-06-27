ALTER TABLE payslips
  ADD COLUMN IF NOT EXISTS total_earning_encrypted TEXT NULL AFTER total_earning,
  ADD COLUMN IF NOT EXISTS total_deduction_encrypted TEXT NULL AFTER total_deduction,
  ADD COLUMN IF NOT EXISTS net_pay_encrypted TEXT NULL AFTER net_pay,
  ADD COLUMN IF NOT EXISTS source_summary_encrypted LONGTEXT NULL AFTER source_summary,
  ADD COLUMN IF NOT EXISTS payslip_storage_encrypted_at DATETIME NULL AFTER source_summary_encrypted;
