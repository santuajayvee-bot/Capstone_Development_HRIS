require('dotenv').config();
const pool = require('../config/db');

const leaveColumns = [
  ['filing_source', "ENUM('Portal','Manual') NOT NULL DEFAULT 'Portal'"],
  ['remarks', 'TEXT NULL'],
  ['filed_by', 'INT NULL'],
  ['encoded_by', 'INT NULL'],
  ['approved_by', 'INT NULL'],
  ['approved_at', 'TIMESTAMP NULL'],
  ['rejected_by', 'INT NULL'],
  ['rejected_at', 'TIMESTAMP NULL'],
  ['rejection_remarks', 'TEXT NULL']
];

async function columnExists(conn, table, column) {
  const [rows] = await conn.execute(
    `SELECT COUNT(*) AS count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].count > 0;
}

async function migrate() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(`
      ALTER TABLE leave_requests
      MODIFY status ENUM('Pending','Approved','Rejected','Denied','Cancelled') DEFAULT 'Pending'
    `);

    for (const [column, definition] of leaveColumns) {
      if (!(await columnExists(conn, 'leave_requests', column))) {
        await conn.execute(`ALTER TABLE leave_requests ADD COLUMN ${column} ${definition}`);
        console.log(`Added leave_requests.${column}`);
      }
    }

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS leave_balances (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        leave_type ENUM('Vacation','Sick','Emergency') NOT NULL,
        balance DECIMAL(8,2) NOT NULL DEFAULT 0,
        used DECIMAL(8,2) NOT NULL DEFAULT 0,
        year INT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_leave_balance (employee_id, leave_type, year),
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
      )
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS leave_audit_trail (
        id INT AUTO_INCREMENT PRIMARY KEY,
        leave_request_id INT NULL,
        employee_id INT NULL,
        actor_user_id INT NULL,
        action VARCHAR(50) NOT NULL,
        remarks TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (leave_request_id) REFERENCES leave_requests(id) ON DELETE SET NULL,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
        FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    console.log('Leave management enhancement migration complete.');
  } finally {
    conn.release();
    await pool.end();
  }
}

migrate().catch(error => {
  console.error('Leave management migration failed:', error);
  process.exit(1);
});
