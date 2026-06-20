const pool = require('../config/db');

async function hasColumn(connection, table, column) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows.length > 0;
}

async function up() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS employee_deduction_accounts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        employee_id BIGINT NOT NULL,
        module_type ENUM('Cash Advance','Employee Loan') NOT NULL,
        deduction_name VARCHAR(120) NOT NULL,
        loan_type VARCHAR(80) NULL,
        original_amount DECIMAL(12,2) NOT NULL,
        remaining_balance DECIMAL(12,2) NOT NULL,
        installment_amount DECIMAL(12,2) NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NULL,
        status ENUM('Active','Paused','Paid','Cancelled') NOT NULL DEFAULT 'Active',
        remarks TEXT NULL,
        created_by BIGINT NULL,
        updated_by BIGINT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_employee_deduction_employee (employee_id),
        INDEX idx_employee_deduction_status (status),
        INDEX idx_employee_deduction_dates (start_date, end_date)
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS employee_deduction_payments (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        deduction_account_id BIGINT NOT NULL,
        employee_id BIGINT NOT NULL,
        salary_calculation_id BIGINT NULL,
        payroll_period VARCHAR(7) NULL,
        applied_amount DECIMAL(12,2) NOT NULL,
        balance_before DECIMAL(12,2) NOT NULL,
        balance_after DECIMAL(12,2) NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by BIGINT NULL,
        INDEX idx_deduction_payment_account (deduction_account_id),
        INDEX idx_deduction_payment_employee (employee_id),
        INDEX idx_deduction_payment_salary (salary_calculation_id)
      )
    `);

    if (!(await hasColumn(connection, 'salary_calculations', 'employee_deduction_total'))) {
      await connection.execute(`
        ALTER TABLE salary_calculations
          ADD COLUMN employee_deduction_total DECIMAL(12,2) NOT NULL DEFAULT 0
      `);
    }

    await connection.commit();
    console.log('Employee deduction accounts migration applied.');
  } catch (err) {
    await connection.rollback();
    console.error('Employee deduction accounts migration failed:', err);
    process.exitCode = 1;
  } finally {
    connection.release();
  }
}

async function down() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    if (await hasColumn(connection, 'salary_calculations', 'employee_deduction_total')) {
      await connection.execute('ALTER TABLE salary_calculations DROP COLUMN employee_deduction_total');
    }
    await connection.execute('DROP TABLE IF EXISTS employee_deduction_payments');
    await connection.execute('DROP TABLE IF EXISTS employee_deduction_accounts');

    await connection.commit();
    console.log('Employee deduction accounts migration reverted.');
  } catch (err) {
    await connection.rollback();
    console.error('Employee deduction accounts rollback failed:', err);
    process.exitCode = 1;
  } finally {
    connection.release();
  }
}

async function main() {
  const direction = String(process.argv[2] || 'up').toLowerCase();
  if (direction === 'down') await down();
  else await up();
  await pool.end();
}

main();
