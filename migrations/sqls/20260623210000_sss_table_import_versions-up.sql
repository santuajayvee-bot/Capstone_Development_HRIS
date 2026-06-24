-- UP migration: versioned SSS contribution table imports.

CREATE TABLE IF NOT EXISTS sss_table_versions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  version_name VARCHAR(160) NOT NULL,
  effective_date DATE NOT NULL,
  status ENUM('Draft', 'Active', 'Archived') NOT NULL DEFAULT 'Draft',
  created_by BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_by BIGINT NULL,
  approved_at DATETIME NULL,
  archived_at DATETIME NULL,
  source_filename VARCHAR(255) NULL,
  INDEX idx_sss_table_versions_active (status, effective_date),
  INDEX idx_sss_table_versions_created_by (created_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sss_table_rows (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  sss_table_version_id BIGINT NOT NULL,
  compensation_from DECIMAL(12,2) NOT NULL,
  compensation_to DECIMAL(12,2) NOT NULL,
  regular_ss_msc DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  ec_msc DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  mpf_msc DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total_msc DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  employer_regular_ss DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  employer_mpf DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  employer_ec DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  employer_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  employee_regular_ss DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  employee_mpf DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  employee_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  grand_total_contribution DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  remarks VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sss_table_rows_version
    FOREIGN KEY (sss_table_version_id) REFERENCES sss_table_versions(id)
    ON DELETE CASCADE,
  UNIQUE KEY uq_sss_table_row_range (sss_table_version_id, compensation_from, compensation_to),
  INDEX idx_sss_table_rows_lookup (sss_table_version_id, compensation_from, compensation_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
