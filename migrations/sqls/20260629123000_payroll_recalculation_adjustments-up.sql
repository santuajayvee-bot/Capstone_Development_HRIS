CREATE TABLE IF NOT EXISTS payroll_recalculation_adjustments (
  id BIGINT NOT NULL AUTO_INCREMENT,
  salary_calculation_id BIGINT NOT NULL,
  employee_id BIGINT NOT NULL,
  wage_type VARCHAR(40) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  old_values JSON NOT NULL,
  new_values JSON NOT NULL,
  corrections JSON NOT NULL,
  created_by BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_payroll_recalc_calculation (salary_calculation_id, created_at),
  INDEX idx_payroll_recalc_employee (employee_id, created_at),
  INDEX idx_payroll_recalc_user (created_by, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
