require('dotenv').config();
const pool = require('../config/db');

async function columnExists(conn, table, column) {
  const [rows] = await conn.execute(
    `SELECT COUNT(*) AS count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function ensureColumn(conn, table, column, definition) {
  if (!(await columnExists(conn, table, column))) {
    await conn.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`Added ${table}.${column}`);
  }
}

async function migrate() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS leave_balances (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        leave_type_id INT NULL,
        leave_type VARCHAR(120) NOT NULL,
        balance DECIMAL(8,2) NOT NULL DEFAULT 0,
        used DECIMAL(8,2) NOT NULL DEFAULT 0,
        year INT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_leave_balance (employee_id, leave_type, year),
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
      )
    `);

    await ensureColumn(conn, 'leave_balances', 'leave_type_id', 'INT NULL');
    await ensureColumn(conn, 'leave_balances', 'total_days', 'DECIMAL(8,2) NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'leave_balances', 'used_days', 'DECIMAL(8,2) NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'leave_balances', 'remaining_days', 'DECIMAL(8,2) NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'leave_balances', 'last_updated_by', 'INT NULL');

    await conn.execute(`
      UPDATE leave_balances
         SET total_days = CASE WHEN total_days = 0 THEN COALESCE(balance, 0) ELSE total_days END,
             used_days = CASE WHEN used_days = 0 THEN COALESCE(used, 0) ELSE used_days END
    `);
    await conn.execute(`
      UPDATE leave_balances
         SET remaining_days = GREATEST(total_days - used_days, 0),
             balance = total_days,
             used = used_days
    `);

    await conn.commit();
    console.log('Leave balances v2 migration complete.');
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
    await pool.end();
  }
}

migrate().catch(error => {
  console.error('Leave balances v2 migration failed:', error);
  process.exit(1);
});
