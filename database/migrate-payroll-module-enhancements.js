const pool = require('../config/db');

async function ensureColumn(connection, table, column, definition) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );

  if (!rows.length) {
    await connection.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function migrate() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS payroll_deduction_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        category ENUM('Government','Company','Other') NOT NULL DEFAULT 'Other',
        computation_type ENUM('Fixed Amount','Percentage','Manual Amount') NOT NULL DEFAULT 'Manual Amount',
        rate_or_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
        apply_schedule ENUM('Every Payroll','1st Week','2nd Week','3rd Week','4th Week','5th Week') NOT NULL DEFAULT 'Every Payroll',
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        effective_date DATE NOT NULL,
        remarks TEXT NULL,
        created_by INT NULL,
        updated_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS payroll_allowance_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        allowance_type ENUM('Fixed','Percentage','Manual') NOT NULL DEFAULT 'Fixed',
        amount_or_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
        is_taxable TINYINT(1) NOT NULL DEFAULT 0,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        effective_date DATE NOT NULL,
        created_by INT NULL,
        updated_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS payroll_audit_trail (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NULL,
        employee_id INT NULL,
        payroll_run_id INT NULL,
        salary_calculation_id INT NULL,
        action VARCHAR(80) NOT NULL,
        remarks TEXT NULL,
        metadata JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_payroll_audit_created (created_at),
        INDEX idx_payroll_audit_action (action)
      )
    `);

    await ensureColumn(connection, 'salary_calculations', 'payroll_period', 'VARCHAR(7) NULL');
    await ensureColumn(connection, 'salary_calculations', 'calculated_by', 'INT NULL');
    await ensureColumn(connection, 'salary_calculations', 'submitted_at', 'DATETIME NULL');
    await ensureColumn(connection, 'salary_calculations', 'approved_by', 'INT NULL');
    await ensureColumn(connection, 'salary_calculations', 'approved_at', 'DATETIME NULL');
    await ensureColumn(connection, 'salary_calculations', 'released_by', 'INT NULL');
    await ensureColumn(connection, 'salary_calculations', 'released_at', 'DATETIME NULL');

    const defaultDeductions = [
      ['SSS', 'Government', 'Percentage', 4.5, '3rd Week'],
      ['PhilHealth', 'Government', 'Percentage', 2.75, '3rd Week'],
      ['Pag-IBIG', 'Government', 'Percentage', 2, '3rd Week'],
      ['Withholding Tax', 'Government', 'Manual Amount', 0, '3rd Week']
    ];

    for (const row of defaultDeductions) {
      await connection.execute(`
        INSERT INTO payroll_deduction_settings
          (name, category, computation_type, rate_or_amount, apply_schedule, is_active, effective_date)
        SELECT ?, ?, ?, ?, ?, 1, CURDATE()
        WHERE NOT EXISTS (SELECT 1 FROM payroll_deduction_settings WHERE name = ?)
      `, [...row, row[0]]);
    }

    const defaultAllowances = [
      ['Meal Allowance', 'Fixed', 0, 0],
      ['Transportation Allowance', 'Fixed', 0, 0],
      ['Communication Allowance', 'Fixed', 0, 0],
      ['Other Allowance', 'Manual', 0, 0]
    ];

    for (const row of defaultAllowances) {
      await connection.execute(`
        INSERT INTO payroll_allowance_settings
          (name, allowance_type, amount_or_rate, is_taxable, is_active, effective_date)
        SELECT ?, ?, ?, ?, 1, CURDATE()
        WHERE NOT EXISTS (SELECT 1 FROM payroll_allowance_settings WHERE name = ?)
      `, [...row, row[0]]);
    }

    await connection.commit();
    console.log('Payroll module enhancement migration completed.');
  } catch (err) {
    await connection.rollback();
    console.error('Payroll module enhancement migration failed:', err);
    process.exitCode = 1;
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate();
