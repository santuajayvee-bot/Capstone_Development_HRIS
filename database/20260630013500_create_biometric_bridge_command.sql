-- up
CREATE TABLE IF NOT EXISTS biometric_bridge_command (
  command_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  device_id INT NOT NULL,
  employee_id INT NULL,
  command_type ENUM('VERIFY','ENROLL','DELETE') NOT NULL,
  command_status ENUM('PENDING','IN_PROGRESS','COMPLETED','FAILED','EXPIRED') NOT NULL DEFAULT 'PENDING',
  requested_by INT NULL,
  claimed_at DATETIME NULL,
  completed_at DATETIME NULL,
  expires_at DATETIME NOT NULL,
  result_json TEXT NULL,
  error_message VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (device_id) REFERENCES biometric_device(device_id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
  INDEX idx_bridge_command_device_status (device_id, command_status, expires_at),
  INDEX idx_bridge_command_requested_by (requested_by, created_at),
  INDEX idx_bridge_command_employee (employee_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- down
DROP TABLE IF EXISTS biometric_bridge_command;
