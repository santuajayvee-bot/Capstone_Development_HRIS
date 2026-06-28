CREATE TABLE IF NOT EXISTS performance_logs (
  performance_log_id BIGINT NOT NULL AUTO_INCREMENT,
  operation_name VARCHAR(100) NOT NULL,
  employees_processed INT NOT NULL DEFAULT 0,
  payroll_period VARCHAR(50) NULL,
  start_time DATETIME(3) NOT NULL,
  end_time DATETIME(3) NOT NULL,
  duration_ms BIGINT NOT NULL,
  status VARCHAR(16) NOT NULL,
  metadata_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (performance_log_id),
  INDEX idx_performance_logs_operation_created (operation_name, created_at),
  INDEX idx_performance_logs_period (payroll_period),
  CONSTRAINT chk_performance_logs_status CHECK (status IN ('success', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
