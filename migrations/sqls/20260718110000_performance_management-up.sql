CREATE TABLE IF NOT EXISTS performance_cycles (
  id BIGINT NOT NULL AUTO_INCREMENT,
  cycle_name VARCHAR(160) NOT NULL,
  review_period_start DATE NOT NULL,
  review_period_end DATE NOT NULL,
  due_date DATE NOT NULL,
  status ENUM('DRAFT', 'ACTIVE', 'CLOSED') NOT NULL DEFAULT 'DRAFT',
  description_encrypted LONGTEXT NULL,
  created_by BIGINT NOT NULL,
  updated_by BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_performance_cycles_status_dates (status, review_period_start, review_period_end),
  INDEX idx_performance_cycles_due_date (due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS performance_reviews (
  id BIGINT NOT NULL AUTO_INCREMENT,
  cycle_id BIGINT NOT NULL,
  employee_id BIGINT NOT NULL,
  reviewer_user_id BIGINT NOT NULL,
  status ENUM('ASSIGNED', 'FINALIZED') NOT NULL DEFAULT 'ASSIGNED',
  indicator_ratings_encrypted LONGTEXT NULL,
  final_score DECIMAL(4,2) NULL,
  goals_encrypted LONGTEXT NULL,
  reviewer_feedback_encrypted LONGTEXT NULL,
  development_plan_encrypted LONGTEXT NULL,
  integrity_hash CHAR(64) NULL,
  finalized_at DATETIME NULL,
  reopened_at DATETIME NULL,
  reopened_by BIGINT NULL,
  reopen_reason_encrypted LONGTEXT NULL,
  version INT NOT NULL DEFAULT 1,
  created_by BIGINT NOT NULL,
  updated_by BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_performance_review_cycle_employee (cycle_id, employee_id),
  INDEX idx_performance_reviews_employee_status (employee_id, status),
  INDEX idx_performance_reviews_reviewer_status (reviewer_user_id, status),
  INDEX idx_performance_reviews_integrity (integrity_hash),
  CONSTRAINT fk_performance_reviews_cycle
    FOREIGN KEY (cycle_id) REFERENCES performance_cycles(id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_performance_reviews_employee
    FOREIGN KEY (employee_id) REFERENCES employees(Employee_ID)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
