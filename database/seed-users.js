/* ============================================================
   database/seed-users.js
   Generates Argon2id hashes and inserts local bootstrap users.
   Run after schema setup/auth migration: node database/seed-users.js
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');
const argon2 = require('argon2');

const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
};

const USERS = [
  {
    username: 'sys.admin',
    password: 'sys123admin',
    role: 'system_admin',
    email: 'sys.admin@lgsv.local',
    employee: {
      employee_code: 'SYS-ADMIN',
      first_name: 'System',
      last_name: 'Administrator',
      position: 'System Administrator',
    },
  },
  {
    username: 'hr.admin',
    password: 'hr123admin',
    role: 'hr_admin',
    email: 'hr.admin@lgsv.local',
    employee: {
      employee_code: 'HR-ADMIN',
      first_name: 'HR',
      last_name: 'Administrator',
      position: 'HR Admin',
    },
  },
  { username: 'payroll.officer', password: 'officer123', role: 'payroll_officer', email: 'payroll.officer@lgsv.local', employee_id: 1 },
  { username: 'payroll.manager', password: 'manager123', role: 'payroll_manager', email: 'payroll.manager@lgsv.local', employee_id: 3 },
  { username: 'serjo.justine', password: 'emp123', role: 'employee', email: 'serjo.justine@lgsv.local', employee_id: 37 },
  { username: 'chris.brown', password: 'emp123', role: 'employee', email: 'chris.brown@lgsv.local', employee_id: 11 },
  { username: 'lebron.james', password: 'emp123', role: 'employee', email: 'lebron.james@lgsv.local', employee_id: 41 },
];

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

function employeeDefaults(user) {
  const employee = user.employee || {};
  return {
    employee_code: employee.employee_code || user.username.toUpperCase().replace(/[^A-Z0-9]+/g, '-'),
    first_name: employee.first_name || user.username.split('.')[0] || 'LGSV',
    last_name: employee.last_name || user.username.split('.')[1] || 'User',
    email: user.email,
    position: employee.position || user.role.replace(/_/g, ' '),
  };
}

async function findEmployee(connection, user) {
  if (user.employee_id) {
    const [rows] = await connection.execute(
      'SELECT id FROM employees WHERE id = ? LIMIT 1',
      [user.employee_id]
    );
    if (rows[0]) return rows[0].id;
  }

  const employee = employeeDefaults(user);
  const [rows] = await connection.execute(
    `SELECT id
       FROM employees
      WHERE employee_code = ?
         OR LOWER(email) = LOWER(?)
      LIMIT 1`,
    [employee.employee_code, employee.email]
  );

  return rows[0]?.id || null;
}

async function resetEmployeeAuth(connection, employeeId, passwordHash) {
  await connection.execute(
    `UPDATE employees
        SET Employee_ID = COALESCE(Employee_ID, id),
            Password_Hash = ?,
            Password_Changed_At = NULL,
            Failed_Login_Attempts = 0,
            Locked_Until = NULL,
            MFA_Enabled = COALESCE(MFA_Enabled, 1)
      WHERE id = ?`,
    [passwordHash, employeeId]
  );
}

async function ensureEmployee(connection, user, passwordHash) {
  const existingEmployeeId = await findEmployee(connection, user);

  if (existingEmployeeId) {
    await resetEmployeeAuth(connection, existingEmployeeId, passwordHash);
    return existingEmployeeId;
  }

  const employee = employeeDefaults(user);
  const [result] = await connection.execute(
    `INSERT INTO employees
       (employee_code, first_name, last_name, email, position, employment_type,
        status, Password_Hash, Password_Changed_At, Failed_Login_Attempts,
        Locked_Until, MFA_Enabled)
     VALUES (?, ?, ?, ?, ?, 'Full-time', 'Active', ?, NULL, 0, NULL, 1)`,
    [
      employee.employee_code,
      employee.first_name,
      employee.last_name,
      employee.email,
      employee.position,
      passwordHash,
    ]
  );

  const employeeId = result.insertId;
  await connection.execute(
    'UPDATE employees SET Employee_ID = id WHERE id = ? AND Employee_ID IS NULL',
    [employeeId]
  );

  return employeeId;
}

async function seedUsers() {
  const conn = await pool.getConnection();
  try {
    console.log('Seeding users...\n');

    await conn.beginTransaction();

    const [roles] = await conn.execute('SELECT id, name FROM roles');
    const roleIdByName = new Map(roles.map(role => [role.name, role.id]));
    const usersHasEmail = await hasColumn(conn, 'users', 'email');

    for (const user of USERS) {
      const roleId = roleIdByName.get(user.role);
      if (!roleId) throw new Error(`Missing role: ${user.role}. Run the role migration first.`);

      // Bootstrap passwords are temporary demo credentials. They are still
      // stored only as Argon2id hashes, never plaintext or reversible data.
      const hash = await argon2.hash(user.password, ARGON2ID_OPTIONS);
      const employeeId = await ensureEmployee(conn, user, hash);

      if (usersHasEmail) {
        await conn.execute(
          `INSERT INTO users (username, email, password_hash, role_id, employee_id, is_active, account_status)
           VALUES (?, ?, ?, ?, ?, 1, 'Active')
           ON DUPLICATE KEY UPDATE
             email = VALUES(email),
             password_hash = VALUES(password_hash),
             role_id = VALUES(role_id),
             employee_id = VALUES(employee_id),
             is_active = 1,
             account_status = 'Active'`,
          [user.username, user.email, hash, roleId, employeeId]
        );
      } else {
        await conn.execute(
          `INSERT INTO users (username, password_hash, role_id, employee_id, is_active)
           VALUES (?, ?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE
             password_hash = VALUES(password_hash),
             role_id = VALUES(role_id),
             employee_id = VALUES(employee_id),
             is_active = 1`,
          [user.username, hash, roleId, employeeId]
        );
      }

      console.log(`  ${user.username} (${user.role}) seeded`);
    }

    await conn.commit();
    console.log('\nAll users seeded successfully.');
  } catch (err) {
    await conn.rollback();
    console.error('Seed error:', err.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

seedUsers();
