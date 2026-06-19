/* ============================================================
   database/migrate-attendance-minute-flags.js
   Adds separate late, undertime, and overtime minute storage.
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

async function hasColumn(conn, table, column) {
  const [rows] = await conn.execute(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function addColumnIfMissing(conn, table, column, definition) {
  if (!(await hasColumn(conn, table, column))) {
    await conn.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`Added ${table}.${column}`);
  }
}

async function dropColumnIfExists(conn, table, column) {
  if (await hasColumn(conn, table, column)) {
    await conn.execute(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    console.log(`Dropped ${table}.${column}`);
  }
}

async function up(conn) {
  await addColumnIfMissing(conn, 'attendance_log', 'late_minutes', 'INT NOT NULL DEFAULT 0 AFTER overtime_hours');
  await addColumnIfMissing(conn, 'attendance_log', 'undertime_minutes', 'INT NOT NULL DEFAULT 0 AFTER late_minutes');
  await addColumnIfMissing(conn, 'attendance_log', 'overtime_minutes', 'INT NOT NULL DEFAULT 0 AFTER undertime_minutes');

  await addColumnIfMissing(conn, 'attendance_summary', 'undertime_minutes', 'INT NOT NULL DEFAULT 0 AFTER late_minutes');
  await addColumnIfMissing(conn, 'attendance_summary', 'policy_snapshot_json', 'JSON NULL AFTER integrity_hash');
}

async function down(conn) {
  await dropColumnIfExists(conn, 'attendance_log', 'overtime_minutes');
  await dropColumnIfExists(conn, 'attendance_log', 'undertime_minutes');
  await dropColumnIfExists(conn, 'attendance_log', 'late_minutes');
  await dropColumnIfExists(conn, 'attendance_summary', 'policy_snapshot_json');
  await dropColumnIfExists(conn, 'attendance_summary', 'undertime_minutes');
}

async function run() {
  const direction = String(process.argv[2] || 'up').toLowerCase();
  const conn = await pool.getConnection();
  try {
    if (direction === 'down') {
      await down(conn);
      console.log('Attendance minute flags migration rolled back.');
    } else {
      await up(conn);
      console.log('Attendance minute flags migration complete.');
    }
  } catch (error) {
    console.error('Attendance minute flags migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

if (require.main === module) run();

module.exports = { up, down };
