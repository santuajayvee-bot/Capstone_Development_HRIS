/* ============================================================
   Ensures HR Manager exists and maps the existing hr.admin login
   to that role for final approvals.
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

async function hasColumn(connection, tableName, columnName) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function upsertRole(connection, role, includeAccessLevel) {
  if (includeAccessLevel) {
    await connection.execute(
      `INSERT INTO roles (name, label, access_level)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         label = VALUES(label),
         access_level = VALUES(access_level)`,
      [role.name, role.label, role.access_level]
    );
    return;
  }

  await connection.execute(
    `INSERT INTO roles (name, label)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE label = VALUES(label)`,
    [role.name, role.label]
  );
}

async function migrateHrManagerRole() {
  const connection = await pool.getConnection();
  try {
    const includeAccessLevel = await hasColumn(connection, 'roles', 'access_level');
    const roles = [
      { name: 'hr_admin', label: 'HR Manager (Level 2)', access_level: 'Level 2' },
      { name: 'hr_manager', label: 'HR Manager (Level 2)', access_level: 'Level 2' },
    ];

    for (const role of roles) {
      await upsertRole(connection, role, includeAccessLevel);
    }

    const [result] = await connection.execute(
      `UPDATE users
          SET role_id = (SELECT id FROM roles WHERE name = 'hr_manager' LIMIT 1)
        WHERE username = 'hr.admin'`
    );

    console.log('HR Manager role is ready.');
    console.log(`hr.admin accounts updated: ${result.affectedRows}`);
  } catch (error) {
    console.error('HR Manager role migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    connection.release();
    await pool.end();
  }
}

migrateHrManagerRole();
