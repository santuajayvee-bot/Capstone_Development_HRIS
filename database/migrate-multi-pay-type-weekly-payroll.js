/* ============================================================
   Multi-pay-type weekly payroll migration

   Run:
     node database/migrate-multi-pay-type-weekly-payroll.js up
     node database/migrate-multi-pay-type-weekly-payroll.js down
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

async function hasTable(connection, table) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [table]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function hasColumn(connection, table, column) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [table, column]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function addColumnIfMissing(connection, table, column, definition) {
  if (!(await hasTable(connection, table))) return;
  if (!(await hasColumn(connection, table, column))) {
    await connection.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`Added ${table}.${column}`);
  }
}

async function dropColumnIfExists(connection, table, column) {
  if (!(await hasTable(connection, table))) return;
  if (await hasColumn(connection, table, column)) {
    await connection.execute(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    console.log(`Dropped ${table}.${column}`);
  }
}

async function modifyColumnIfExists(connection, table, column, definition) {
  if (!(await hasTable(connection, table))) return;
  if (await hasColumn(connection, table, column)) {
    await connection.execute(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition}`);
    console.log(`Modified ${table}.${column}`);
  }
}

async function ensureIndex(connection, table, indexName, columnsSql) {
  if (!(await hasTable(connection, table))) return;
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?`,
    [table, indexName]
  );
  if (!Number(rows[0]?.count || 0)) {
    await connection.execute(`CREATE INDEX ${indexName} ON ${table} (${columnsSql})`);
    console.log(`Created index ${table}.${indexName}`);
  }
}

async function seedWageTypes(connection) {
  const types = [
    ['Monthly', 'Monthly salary converted for weekly payroll'],
    ['Daily', 'Daily rate based on approved days worked'],
    ['Hourly', 'Hourly rate based on approved hours worked'],
    ['Piece Rate', 'Production output-based payroll'],
    ['Logistics', 'Delivery trip/output-based payroll'],
    ['Trip-Based', 'Logistics: paid from approved delivery trips']
  ];

  for (const [name, description] of types) {
    await connection.execute(
      `INSERT INTO wage_types (name, description)
       SELECT ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM wage_types WHERE LOWER(name) = LOWER(?))`,
      [name, description, name]
    );
  }
}

async function seedPayrollPolicy(connection) {
  if (!(await hasTable(connection, 'payroll_policy_settings'))) return;
  const rows = [
    ['monthly_conversion_method', 'weekly_from_monthly', 'Monthly Rules', 'weekly_from_monthly or daily_equivalent'],
    ['monthly_working_days_per_month', '26', 'Monthly Rules', 'Working days per month used for daily-equivalent monthly payroll']
  ];
  for (const row of rows) {
    await connection.execute(
      `INSERT INTO payroll_policy_settings (setting_key, setting_value, setting_group, description)
       SELECT ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM payroll_policy_settings WHERE setting_key = ?)`,
      [...row, row[0]]
    );
  }
}

async function up(connection) {
  await seedWageTypes(connection);

  await modifyColumnIfExists(connection, 'salary_calculations', 'payroll_period', 'VARCHAR(20) NULL');
  await addColumnIfMissing(connection, 'salary_calculations', 'payroll_run_id', 'INT NULL AFTER wage_type_id');
  await addColumnIfMissing(connection, 'salary_calculations', 'period_start', 'DATE NULL AFTER payroll_period');
  await addColumnIfMissing(connection, 'salary_calculations', 'period_end', 'DATE NULL AFTER period_start');
  await addColumnIfMissing(connection, 'salary_calculations', 'source_type', 'VARCHAR(40) NULL AFTER validation_snapshot');
  await addColumnIfMissing(connection, 'salary_calculations', 'source_record_ids', 'TEXT NULL AFTER source_type');
  await addColumnIfMissing(connection, 'salary_calculations', 'employee_deduction_total', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await ensureIndex(connection, 'salary_calculations', 'idx_salary_calc_payroll_run', 'payroll_run_id');
  await ensureIndex(connection, 'salary_calculations', 'idx_salary_calc_period_employee', 'payroll_period, employee_id');

  await addColumnIfMissing(connection, 'payslips', 'salary_calculation_id', 'INT NULL AFTER payroll_run_id');
  await addColumnIfMissing(connection, 'payslips', 'payroll_period', 'VARCHAR(20) NULL AFTER wage_type_id');
  await addColumnIfMissing(connection, 'payslips', 'source_summary', 'TEXT NULL AFTER notes');
  await ensureIndex(connection, 'payslips', 'idx_payslip_salary_calculation', 'salary_calculation_id');

  await addColumnIfMissing(connection, 'payroll_runs', 'period_label', 'VARCHAR(80) NULL AFTER month_year');
  await addColumnIfMissing(connection, 'payroll_runs', 'payroll_type', 'VARCHAR(40) NULL AFTER end_date');
  await addColumnIfMissing(connection, 'payroll_runs', 'processed_by', 'INT NULL AFTER created_by');
  await addColumnIfMissing(connection, 'payroll_runs', 'processed_at', 'DATETIME NULL AFTER processed_by');
  await addColumnIfMissing(connection, 'payroll_runs', 'source_summary', 'TEXT NULL AFTER processed_at');

  await addColumnIfMissing(connection, 'employee_wage_rates', 'monthly_salary', 'DECIMAL(12,2) NULL AFTER base_rate');
  await addColumnIfMissing(connection, 'employee_wage_rates', 'daily_rate', 'DECIMAL(12,2) NULL AFTER monthly_salary');
  await addColumnIfMissing(connection, 'employee_wage_rates', 'default_role', 'VARCHAR(60) NULL AFTER logistics_region_id');
  await addColumnIfMissing(connection, 'employees', 'default_payroll_role', 'VARCHAR(60) NULL AFTER wage_type_id');

  await addColumnIfMissing(connection, 'attendance_summary', 'payroll_run_id', 'INT NULL AFTER payroll_eligible');
  await addColumnIfMissing(connection, 'attendance_summary', 'paid_at', 'DATETIME NULL AFTER payroll_run_id');
  await ensureIndex(connection, 'attendance_summary', 'idx_attendance_summary_payroll_run', 'payroll_run_id');

  await addColumnIfMissing(connection, 'payroll_production_outputs', 'remarks', 'VARCHAR(255) NULL AFTER final_gross_pay');
  await addColumnIfMissing(connection, 'payroll_production_outputs', 'status', "VARCHAR(30) NOT NULL DEFAULT 'Approved' AFTER remarks");
  await addColumnIfMissing(connection, 'payroll_production_outputs', 'payroll_run_id', 'INT NULL AFTER status');
  await addColumnIfMissing(connection, 'payroll_production_outputs', 'approved_by', 'INT NULL AFTER payroll_run_id');
  await addColumnIfMissing(connection, 'payroll_production_outputs', 'approved_at', 'DATETIME NULL AFTER approved_by');
  await addColumnIfMissing(connection, 'payroll_production_outputs', 'paid_at', 'DATETIME NULL AFTER approved_at');
  await addColumnIfMissing(connection, 'payroll_production_outputs', 'updated_by', 'INT NULL AFTER paid_at');
  await ensureIndex(connection, 'payroll_production_outputs', 'idx_prod_outputs_payroll_status', 'employee_id, output_date, status, payroll_run_id');

  await addColumnIfMissing(connection, 'payroll_production_pairs', 'status', "VARCHAR(30) NOT NULL DEFAULT 'Approved' AFTER rule_snapshot");
  await addColumnIfMissing(connection, 'payroll_production_pairs', 'payroll_run_id', 'INT NULL AFTER status');
  await addColumnIfMissing(connection, 'payroll_production_pairs', 'approved_by', 'INT NULL AFTER payroll_run_id');
  await addColumnIfMissing(connection, 'payroll_production_pairs', 'approved_at', 'DATETIME NULL AFTER approved_by');
  await addColumnIfMissing(connection, 'payroll_production_pairs', 'paid_at', 'DATETIME NULL AFTER approved_at');
  await addColumnIfMissing(connection, 'payroll_production_pairs', 'updated_by', 'INT NULL AFTER paid_at');
  await ensureIndex(connection, 'payroll_production_pairs', 'idx_prod_pairs_payroll_status', 'production_date, status, payroll_run_id');

  await addColumnIfMissing(connection, 'delivery_trips', 'output_quantity', 'DECIMAL(10,2) NOT NULL DEFAULT 1 AFTER plate_number');
  await addColumnIfMissing(connection, 'delivery_trips', 'paid_at', 'DATETIME NULL AFTER approved_at');
  await ensureIndex(connection, 'delivery_trips', 'idx_delivery_trips_payroll_status', 'employee_id, trip_date, status, payroll_run_id');

  await seedPayrollPolicy(connection);
}

async function down(connection) {
  await dropColumnIfExists(connection, 'delivery_trips', 'paid_at');
  await dropColumnIfExists(connection, 'delivery_trips', 'output_quantity');

  for (const column of ['updated_by', 'paid_at', 'approved_at', 'approved_by', 'payroll_run_id', 'status', 'remarks']) {
    await dropColumnIfExists(connection, 'payroll_production_pairs', column);
  }
  for (const column of ['updated_by', 'paid_at', 'approved_at', 'approved_by', 'payroll_run_id', 'status']) {
    await dropColumnIfExists(connection, 'payroll_production_outputs', column);
  }

  await dropColumnIfExists(connection, 'attendance_summary', 'paid_at');
  await dropColumnIfExists(connection, 'attendance_summary', 'payroll_run_id');
  await dropColumnIfExists(connection, 'employees', 'default_payroll_role');
  await dropColumnIfExists(connection, 'employee_wage_rates', 'default_role');
  await dropColumnIfExists(connection, 'employee_wage_rates', 'daily_rate');
  await dropColumnIfExists(connection, 'employee_wage_rates', 'monthly_salary');

  for (const column of ['source_summary', 'payroll_period', 'salary_calculation_id']) {
    await dropColumnIfExists(connection, 'payslips', column);
  }
  for (const column of ['source_summary', 'processed_at', 'processed_by', 'payroll_type', 'period_label']) {
    await dropColumnIfExists(connection, 'payroll_runs', column);
  }
  for (const column of ['employee_deduction_total', 'source_record_ids', 'source_type', 'period_end', 'period_start', 'payroll_run_id']) {
    await dropColumnIfExists(connection, 'salary_calculations', column);
  }
  await modifyColumnIfExists(connection, 'salary_calculations', 'payroll_period', 'VARCHAR(7) NULL');

  if (await hasTable(connection, 'payroll_policy_settings')) {
    await connection.execute(
      `DELETE FROM payroll_policy_settings
        WHERE setting_key IN ('monthly_conversion_method', 'monthly_working_days_per_month')`
    );
  }
}

async function run() {
  const direction = String(process.argv[2] || 'up').toLowerCase();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    if (direction === 'down') {
      await down(connection);
      console.log('Multi-pay-type weekly payroll migration rolled back.');
    } else {
      await up(connection);
      console.log('Multi-pay-type weekly payroll migration completed.');
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error('Multi-pay-type weekly payroll migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    connection.release();
    await pool.end();
  }
}

if (require.main === module) {
  run();
}

module.exports = { up, down };
