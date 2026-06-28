SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'salary_calculations' AND INDEX_NAME = 'idx_salary_calc_run_employee_status') > 0,
  'DROP INDEX idx_salary_calc_run_employee_status ON salary_calculations',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;

SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_production_outputs' AND INDEX_NAME = 'idx_prod_outputs_preview_lookup') > 0,
  'DROP INDEX idx_prod_outputs_preview_lookup ON payroll_production_outputs',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;

SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_production_pairs' AND INDEX_NAME = 'idx_prod_pairs_worker1_preview') > 0,
  'DROP INDEX idx_prod_pairs_worker1_preview ON payroll_production_pairs',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;

SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_production_pairs' AND INDEX_NAME = 'idx_prod_pairs_worker2_preview') > 0,
  'DROP INDEX idx_prod_pairs_worker2_preview ON payroll_production_pairs',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;

SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'piece_rate_output_shares' AND INDEX_NAME = 'idx_piece_output_shares_employee_output') > 0,
  'DROP INDEX idx_piece_output_shares_employee_output ON piece_rate_output_shares',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;

SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'piece_rate_outputs' AND INDEX_NAME = 'idx_piece_outputs_preview_lookup') > 0,
  'DROP INDEX idx_piece_outputs_preview_lookup ON piece_rate_outputs',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;

SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_deduction_accounts' AND INDEX_NAME = 'idx_employee_deductions_payroll_lookup') > 0,
  'DROP INDEX idx_employee_deductions_payroll_lookup ON employee_deduction_accounts',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;

SET @lgsv_migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_deduction_settings' AND INDEX_NAME = 'idx_deduction_settings_preview_lookup') > 0,
  'DROP INDEX idx_deduction_settings_preview_lookup ON payroll_deduction_settings',
  'SELECT 1'
);
PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql;
EXECUTE lgsv_migration_stmt;
DEALLOCATE PREPARE lgsv_migration_stmt;
