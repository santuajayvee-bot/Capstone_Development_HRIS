/* ============================================================
   Aligns local RBAC roles with the approved access matrix.
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

async function migrate() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const includeAccessLevel = await hasColumn(connection, 'roles', 'access_level');
    if (!includeAccessLevel) {
      await connection.execute('ALTER TABLE roles ADD COLUMN access_level VARCHAR(20) NULL AFTER label');
    }

    const roles = [
      { name: 'employee', label: 'Employee (Level 1)', access_level: 'Level 1' },
      { name: 'hr_manager', label: 'HR Manager (Level 2)', access_level: 'Level 2' },
      { name: 'payroll_officer', label: 'Payroll Officer (Level 2)', access_level: 'Level 2' },
      { name: 'payroll_manager', label: 'Payroll Manager (Level 3)', access_level: 'Level 3' },
      { name: 'system_admin', label: 'System Administrator (Level 4)', access_level: 'Level 4' },
    ];

    for (const role of roles) {
      await upsertRole(connection, role, true);
    }

    await connection.execute(
      `UPDATE roles
          SET label = 'HR Manager (Level 2)',
              access_level = 'Level 2'
        WHERE name IN ('hr_admin', 'manager')`
    );

    await connection.execute(
      `UPDATE users
          SET role_id = (SELECT id FROM roles WHERE name = 'hr_manager' LIMIT 1)
        WHERE role_id IN (SELECT id FROM roles WHERE name IN ('hr_admin', 'manager'))`
    );

    await connection.execute(
      `UPDATE users
          SET role_id = (SELECT id FROM roles WHERE name = 'system_admin' LIMIT 1)
        WHERE role_id IN (SELECT id FROM roles WHERE name = 'admin')`
    );

    await connection.execute(
      `DELETE FROM roles
        WHERE name IN ('admin', 'hr_admin', 'manager')
          AND id NOT IN (SELECT DISTINCT role_id FROM users WHERE role_id IS NOT NULL)`
    );

    await connection.commit();
    console.log('RBAC access matrix migration complete.');
  } catch (error) {
    await connection.rollback();
    console.error('RBAC access matrix migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate();
