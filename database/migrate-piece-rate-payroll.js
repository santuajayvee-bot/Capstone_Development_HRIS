/* ============================================================
   Piece-rate payroll configuration migration

   Run:
     node database/migrate-piece-rate-payroll.js
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

async function migrate() {
  try {
    const ensureColumn = async (table, column, definition) => {
      const [rows] = await pool.execute(
        `SELECT COUNT(*) AS count
           FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = ?
            AND COLUMN_NAME = ?`,
        [table, column]
      );
      if (!Number(rows[0]?.count || 0)) {
        await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS payroll_sew_types (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(40) NOT NULL,
        description VARCHAR(255) NULL,
        effective_date DATE NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        updated_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_payroll_sew_type_code_date (code, effective_date),
        INDEX idx_sew_type_active (is_active, effective_date)
      )
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS payroll_size_ranges (
        id INT AUTO_INCREMENT PRIMARY KEY,
        size_range VARCHAR(40) NOT NULL,
        description VARCHAR(255) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        updated_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_payroll_size_range (size_range),
        INDEX idx_size_range_active (is_active)
      )
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS payroll_piece_rates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_type VARCHAR(120) NOT NULL,
        product_category VARCHAR(120) NULL,
        piece_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
        effective_date DATE NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        updated_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_piece_rate_active (is_active, effective_date),
        INDEX idx_piece_rate_product (product_type, product_category)
      )
    `);
    await ensureColumn('payroll_piece_rates', 'sew_type_code', 'VARCHAR(40) NULL AFTER product_category');
    await ensureColumn('payroll_piece_rates', 'size_range', 'VARCHAR(40) NULL AFTER sew_type_code');

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS payroll_production_shares (
        id INT AUTO_INCREMENT PRIMARY KEY,
        worker_category VARCHAR(80) NOT NULL,
        percentage_share DECIMAL(6,2) NOT NULL DEFAULT 0,
        effective_date DATE NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        updated_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_share_active (is_active, effective_date),
        INDEX idx_share_category (worker_category)
      )
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS payroll_piece_incentives (
        id INT AUTO_INCREMENT PRIMARY KEY,
        incentive_name VARCHAR(120) NOT NULL,
        incentive_category ENUM('Quota Incentive','Sunday Work Incentive','Special Sewing Type Incentive') NOT NULL,
        amount DECIMAL(12,2) NOT NULL DEFAULT 0,
        threshold_quantity INT NULL,
        sewing_type VARCHAR(120) NULL,
        computation_type ENUM('Fixed Amount','Percentage Multiplier') NOT NULL DEFAULT 'Fixed Amount',
        effective_date DATE NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        updated_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_incentive_active (is_active, effective_date),
        INDEX idx_incentive_category (incentive_category)
      )
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS payroll_production_share_rules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        pairing_type ENUM('Standard Sewer-Fixer','Substitute Sewer-Sewer') NOT NULL,
        worker1_share DECIMAL(6,2) NOT NULL DEFAULT 0,
        worker2_share DECIMAL(6,2) NOT NULL DEFAULT 0,
        effective_date DATE NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        updated_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_pair_rule_active (is_active, effective_date),
        INDEX idx_pair_rule_type (pairing_type)
      )
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS payroll_production_outputs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NULL,
        payroll_period VARCHAR(7) NOT NULL,
        product_type VARCHAR(120) NOT NULL,
        product_category VARCHAR(120) NULL,
        sew_type_code VARCHAR(40) NULL,
        size_range VARCHAR(40) NULL,
        worker_category VARCHAR(80) NOT NULL,
        quantity_produced INT NOT NULL DEFAULT 0,
        piece_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
        production_value DECIMAL(12,2) NOT NULL DEFAULT 0,
        share_percentage DECIMAL(6,2) NOT NULL DEFAULT 0,
        quota_incentive DECIMAL(12,2) NOT NULL DEFAULT 0,
        sunday_incentive DECIMAL(12,2) NOT NULL DEFAULT 0,
        special_incentive DECIMAL(12,2) NOT NULL DEFAULT 0,
        final_gross_pay DECIMAL(12,2) NOT NULL DEFAULT 0,
        output_date DATE NOT NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_production_period (payroll_period, output_date),
        INDEX idx_production_employee (employee_id)
      )
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS payroll_production_pairs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        production_date DATE NOT NULL,
        payroll_period VARCHAR(7) NOT NULL,
        worker1_employee_id INT NOT NULL,
        worker2_employee_id INT NOT NULL,
        pairing_type ENUM('Standard Sewer-Fixer','Substitute Sewer-Sewer') NOT NULL,
        product_type VARCHAR(120) NOT NULL,
        product_category VARCHAR(120) NULL,
        sew_type_code VARCHAR(40) NULL,
        size_range VARCHAR(40) NULL,
        quantity_produced INT NOT NULL DEFAULT 0,
        piece_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
        production_value DECIMAL(12,2) NOT NULL DEFAULT 0,
        worker1_share DECIMAL(6,2) NOT NULL DEFAULT 0,
        worker2_share DECIMAL(6,2) NOT NULL DEFAULT 0,
        worker1_earnings DECIMAL(12,2) NOT NULL DEFAULT 0,
        worker2_earnings DECIMAL(12,2) NOT NULL DEFAULT 0,
        rule_snapshot JSON NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_pair_period (payroll_period, production_date),
        INDEX idx_pair_workers (worker1_employee_id, worker2_employee_id)
      )
    `);
    await ensureColumn('payroll_production_outputs', 'sew_type_code', 'VARCHAR(40) NULL AFTER product_category');
    await ensureColumn('payroll_production_outputs', 'size_range', 'VARCHAR(40) NULL AFTER sew_type_code');
    await ensureColumn('payroll_production_pairs', 'sew_type_code', 'VARCHAR(40) NULL AFTER product_category');
    await ensureColumn('payroll_production_pairs', 'size_range', 'VARCHAR(40) NULL AFTER sew_type_code');

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS payroll_piece_incentive_entries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        payroll_period VARCHAR(7) NOT NULL,
        incentive_type ENUM('Quota Incentive','Sunday Work Incentive','Special Sewing Incentive') NOT NULL,
        amount DECIMAL(12,2) NOT NULL DEFAULT 0,
        remarks VARCHAR(255) NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_piece_incentive_entry_employee (employee_id, payroll_period),
        INDEX idx_piece_incentive_entry_period (payroll_period)
      )
    `);

    const [shares] = await pool.execute('SELECT COUNT(*) AS count FROM payroll_production_shares WHERE is_active = 1');
    if (!Number(shares[0].count)) {
      const today = new Date().toISOString().split('T')[0];
      await pool.execute(
        `INSERT INTO payroll_production_shares (worker_category, percentage_share, effective_date, is_active)
         VALUES ('Sewer', 55, ?, 1), ('Fixer', 45, ?, 1)`,
        [today, today]
      );
    }

    const [pairRules] = await pool.execute('SELECT COUNT(*) AS count FROM payroll_production_share_rules WHERE is_active = 1');
    if (!Number(pairRules[0].count)) {
      const today = new Date().toISOString().split('T')[0];
      await pool.execute(
        `INSERT INTO payroll_production_share_rules
           (pairing_type, worker1_share, worker2_share, effective_date, is_active)
         VALUES
           ('Standard Sewer-Fixer', 55, 45, ?, 1),
           ('Substitute Sewer-Sewer', 50, 50, ?, 1)`,
        [today, today]
      );
    }

    const today = new Date().toISOString().split('T')[0];
    const [sewTypes] = await pool.execute('SELECT COUNT(*) AS count FROM payroll_sew_types');
    if (!Number(sewTypes[0].count)) {
      await pool.execute(
        `INSERT INTO payroll_sew_types (code, description, effective_date, is_active)
         VALUES
           ('UL', 'UL sewing operation', ?, 1),
           ('MS', 'MS sewing operation', ?, 1),
           ('HL', 'HL sewing operation', ?, 1),
           ('AL', 'AL sewing operation', ?, 1),
           ('DF', 'DF sewing operation', ?, 1)`,
        [today, today, today, today, today]
      );
    }

    const [sizeRanges] = await pool.execute('SELECT COUNT(*) AS count FROM payroll_size_ranges');
    if (!Number(sizeRanges[0].count)) {
      await pool.execute(`
        INSERT INTO payroll_size_ranges (size_range, description, is_active)
        VALUES
          ('14-19', 'Size range 14-19', 1),
          ('20-23', 'Size range 20-23', 1),
          ('24-26', 'Size range 24-26', 1),
          ('27-29', 'Size range 27-29', 1)
      `);
    }

    console.log('Piece-rate payroll migration completed.');
  } catch (error) {
    console.error('Piece-rate payroll migration failed:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();
