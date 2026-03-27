/* ============================================================
   database/add-file-path-column.js
   Adds file_path column to leave_requests table.
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

async function addColumn() {
  const conn = await pool.getConnection();
  try {
    console.log('🔨 Adding file_path column to leave_requests...\n');

    await conn.execute(`
      ALTER TABLE leave_requests 
      ADD COLUMN IF NOT EXISTS file_path VARCHAR(500) NULL AFTER reason
    `);

    console.log('✅ file_path column added successfully.');
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log('✅ Column already exists.');
    } else {
      console.error('❌ Error:', err.message);
    }
  } finally {
    conn.release();
    process.exit(0);
  }
}

addColumn();
