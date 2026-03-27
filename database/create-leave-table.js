/* ============================================================
   database/create-leave-table.js
   Creates the leave_requests table.
   Run once:  node database/create-leave-table.js
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

async function createLeaveTable() {
  const conn = await pool.getConnection();
  try {
    console.log('🔨 Creating leave_requests table...\n');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS leave_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        type VARCHAR(50) NOT NULL,
        date_from DATE NOT NULL,
        date_to DATE NOT NULL,
        days INT DEFAULT 1,
        reason TEXT,
        file_path VARCHAR(500) NULL COMMENT 'Path to uploaded attachment',
        status ENUM('Pending','Approved','Denied') DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        reviewed_by INT NULL,
        reviewed_at TIMESTAMP NULL,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
        FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    console.log('✅ leave_requests table created successfully.');
  } catch (err) {
    console.error('❌ Error creating table:', err.message);
  } finally {
    conn.release();
    process.exit(0);
  }
}

createLeaveTable();
