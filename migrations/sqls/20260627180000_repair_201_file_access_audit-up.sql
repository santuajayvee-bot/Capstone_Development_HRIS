CREATE TABLE IF NOT EXISTS employee_201_file_access_audit (
  id BIGINT NOT NULL AUTO_INCREMENT,
  employee_id BIGINT NOT NULL,
  accessed_by BIGINT NOT NULL,
  accessed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(100) NULL,
  resource_id BIGINT NULL,
  details JSON NULL,
  PRIMARY KEY (id),
  INDEX idx_201_access_employee (employee_id),
  INDEX idx_201_access_user (accessed_by),
  INDEX idx_201_access_time (accessed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
