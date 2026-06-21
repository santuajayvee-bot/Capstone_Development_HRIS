CREATE TABLE IF NOT EXISTS piece_rate_outputs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  payroll_period_id VARCHAR(20) NOT NULL,
  output_date DATE NOT NULL,
  sew_type_id BIGINT NULL,
  operation_type VARCHAR(40) NOT NULL,
  size_range VARCHAR(40) NULL,
  quantity_produced DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  rate_per_piece DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  full_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  output_mode ENUM('solo','partner') NOT NULL DEFAULT 'solo',
  split_rule VARCHAR(40) NOT NULL DEFAULT 'SOLO',
  status VARCHAR(30) NOT NULL DEFAULT 'Draft',
  created_by BIGINT NULL,
  approved_by BIGINT NULL,
  approved_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_piece_rate_outputs_period_date (payroll_period_id, output_date),
  INDEX idx_piece_rate_outputs_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS piece_rate_output_shares (
  id BIGINT NOT NULL AUTO_INCREMENT,
  piece_rate_output_id BIGINT NOT NULL,
  employee_id BIGINT NOT NULL,
  partner_role VARCHAR(40) NOT NULL,
  share_percentage DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  share_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_piece_rate_output_shares_output
    FOREIGN KEY (piece_rate_output_id) REFERENCES piece_rate_outputs(id) ON DELETE CASCADE,
  INDEX idx_piece_rate_output_shares_employee_period (employee_id, piece_rate_output_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
