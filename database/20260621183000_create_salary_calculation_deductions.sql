-- Migration: create salary calculation deduction snapshots
-- up

CREATE TABLE IF NOT EXISTS salary_calculation_deductions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  salary_calculation_id BIGINT NOT NULL,
  deduction_config_id BIGINT NULL,
  deduction_key VARCHAR(120) NOT NULL,
  name VARCHAR(160) NOT NULL,
  category VARCHAR(80) NULL,
  computation_type VARCHAR(80) NULL,
  rate_or_amount DECIMAL(12,4) NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_salary_calc_deduction_config (salary_calculation_id, deduction_config_id),
  UNIQUE KEY uq_salary_calc_deduction_key (salary_calculation_id, deduction_key),
  INDEX idx_salary_calc_deductions_calc (salary_calculation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE salary_calculations
  MODIFY COLUMN status ENUM('Draft','Calculated','For Review','For Approval','Submitted','Approved','Finalized','Paid','Released','Locked','Superseded','Cancelled') DEFAULT 'For Review';

-- down

DROP TABLE IF EXISTS salary_calculation_deductions;

UPDATE salary_calculations
   SET status = 'Draft'
 WHERE status IN ('Calculated','For Review','For Approval','Locked');

ALTER TABLE salary_calculations
  MODIFY COLUMN status ENUM('Draft','Submitted','Approved','Finalized','Paid','Released','Superseded','Cancelled') DEFAULT 'Submitted';
