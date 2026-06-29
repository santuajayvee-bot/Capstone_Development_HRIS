SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'salary_calculations') > 0
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'salary_calculations' AND COLUMN_NAME IN ('payroll_run_id', 'employee_id', 'status')) = 3
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'salary_calculations' AND INDEX_NAME = 'idx_salary_calc_run_employee_status') = 0,
  'CREATE INDEX idx_salary_calc_run_employee_status ON salary_calculations (payroll_run_id, employee_id, status)',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;

SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_production_outputs') > 0
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_production_outputs' AND COLUMN_NAME IN ('employee_id', 'output_date', 'status', 'payroll_run_id')) = 4
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_production_outputs' AND INDEX_NAME = 'idx_prod_outputs_preview_lookup') = 0,
  'CREATE INDEX idx_prod_outputs_preview_lookup ON payroll_production_outputs (employee_id, output_date, status, payroll_run_id)',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;

SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_production_pairs') > 0
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_production_pairs' AND COLUMN_NAME IN ('worker1_employee_id', 'production_date', 'status', 'payroll_run_id')) = 4
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_production_pairs' AND INDEX_NAME = 'idx_prod_pairs_worker1_preview') = 0,
  'CREATE INDEX idx_prod_pairs_worker1_preview ON payroll_production_pairs (worker1_employee_id, production_date, status, payroll_run_id)',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;

SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_production_pairs') > 0
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_production_pairs' AND COLUMN_NAME IN ('worker2_employee_id', 'production_date', 'status', 'payroll_run_id')) = 4
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_production_pairs' AND INDEX_NAME = 'idx_prod_pairs_worker2_preview') = 0,
  'CREATE INDEX idx_prod_pairs_worker2_preview ON payroll_production_pairs (worker2_employee_id, production_date, status, payroll_run_id)',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;

SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'piece_rate_output_shares') > 0
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'piece_rate_output_shares' AND COLUMN_NAME IN ('employee_id', 'piece_rate_output_id')) = 2
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'piece_rate_output_shares' AND INDEX_NAME = 'idx_piece_output_shares_employee_output') = 0,
  'CREATE INDEX idx_piece_output_shares_employee_output ON piece_rate_output_shares (employee_id, piece_rate_output_id)',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;

SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'piece_rate_outputs') > 0
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'piece_rate_outputs' AND COLUMN_NAME IN ('output_date', 'status', 'payroll_run_id')) = 3
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'piece_rate_outputs' AND INDEX_NAME = 'idx_piece_outputs_preview_lookup') = 0,
  'CREATE INDEX idx_piece_outputs_preview_lookup ON piece_rate_outputs (output_date, status, payroll_run_id)',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;

SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_deduction_accounts') > 0
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_deduction_accounts' AND COLUMN_NAME IN ('employee_id', 'status', 'start_date', 'end_date')) = 4
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_deduction_accounts' AND INDEX_NAME = 'idx_employee_deductions_payroll_lookup') = 0,
  'CREATE INDEX idx_employee_deductions_payroll_lookup ON employee_deduction_accounts (employee_id, status, start_date, end_date)',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;

SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_deduction_settings') > 0
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_deduction_settings' AND COLUMN_NAME IN ('is_active', 'applicability_scope', 'effective_date')) = 3
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_deduction_settings' AND INDEX_NAME = 'idx_deduction_settings_preview_lookup') = 0,
  'CREATE INDEX idx_deduction_settings_preview_lookup ON payroll_deduction_settings (is_active, applicability_scope, effective_date)',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;
