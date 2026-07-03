CREATE TABLE IF NOT EXISTS DATA_PRIVACY_AGREEMENT_ACCEPTANCE (
  Acceptance_ID BIGINT AUTO_INCREMENT PRIMARY KEY,
  User_ID INT NOT NULL,
  Employee_ID INT NULL,
  Agreement_Version VARCHAR(80) NOT NULL,
  Accepted_At DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  IP_Address VARCHAR(45) NULL,
  User_Agent VARCHAR(500) NULL,
  Created_At DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  Updated_At DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dpa_acceptance_user_version (User_ID, Agreement_Version),
  INDEX idx_dpa_acceptance_employee (Employee_ID),
  INDEX idx_dpa_acceptance_version (Agreement_Version, Accepted_At),
  CONSTRAINT fk_dpa_acceptance_user
    FOREIGN KEY (User_ID) REFERENCES users(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dpa_acceptance_employee
    FOREIGN KEY (Employee_ID) REFERENCES employees(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
