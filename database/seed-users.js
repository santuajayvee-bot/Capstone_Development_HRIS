/* ============================================================
   database/seed-users.js
   Generates Argon2id hashes and inserts local bootstrap users.
   Run after schema setup/auth migration: node database/seed-users.js
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');
const argon2 = require('argon2');
const { encryptColumnValue, hashNullable } = require('../server/data-protection');

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
      contact_number: '09085528852',
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
      contact_number: '09192017325',
    },
  },
  {
    username: 'payroll.officer', password: 'officer123', role: 'payroll_officer', email: 'payroll.officer@lgsv.local',
    employee: { employee_code: 'PAYROLL-OFFICER', first_name: 'Payroll', last_name: 'Officer', position: 'Payroll Officer', contact_number: '09913845895' }
  },
  {
    username: 'payroll.manager', password: 'manager123', role: 'payroll_manager', email: 'payroll.manager@lgsv.local',
    employee: { employee_code: 'PAYROLL-MANAGER', first_name: 'Payroll', last_name: 'Manager', position: 'Payroll Manager', contact_number: '09994979897' }
  },
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
    contact_number: employee.contact_number || null,
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
      LIMIT 1`,
    [employee.employee_code]
  );

  return rows[0]?.id || null;
}

async function resetEmployeeAuth(connection, employeeId, passwordHash, employeesHasForcePasswordChange = false, user = {}) {
  const employee = employeeDefaults(user);
  await connection.execute(
    `UPDATE employees
        SET Employee_ID = COALESCE(Employee_ID, id),
            contact_number = COALESCE(?, contact_number),
            Password_Hash = ?,
            Password_Changed_At = NOW(),
            Failed_Login_Attempts = 0,
            Locked_Until = NULL
      WHERE id = ?`,
    [encryptColumnValue(employee.contact_number), passwordHash, employeeId]
  );

  if (employeesHasForcePasswordChange) {
    await connection.execute(
      'UPDATE employees SET force_password_change = 0 WHERE id = ?',
      [employeeId]
    );
  }
}

async function ensureEmployee(connection, user, passwordHash, employeesHasForcePasswordChange = false) {
  const existingEmployeeId = await findEmployee(connection, user);

  if (existingEmployeeId) {
    await resetEmployeeAuth(connection, existingEmployeeId, passwordHash, employeesHasForcePasswordChange, user);
    return existingEmployeeId;
  }

  const employee = employeeDefaults(user);
  const [result] = await connection.execute(
    `INSERT INTO employees
       (employee_code, first_name, last_name, email, email_hash, contact_number, position, employment_type,
        status, Password_Hash, Password_Changed_At, Failed_Login_Attempts,
        Locked_Until)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Full-time', 'Active', ?, NOW(), 0, NULL)`,
    [
      employee.employee_code,
      encryptColumnValue(employee.first_name),
      encryptColumnValue(employee.last_name),
      encryptColumnValue(employee.email),
      hashNullable(employee.email),
      encryptColumnValue(employee.contact_number),
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
    const usersHasEmailHash = await hasColumn(conn, 'users', 'email_hash');
    const usersHasEmailEncrypted = await hasColumn(conn, 'users', 'email_encrypted');
    const usersHasAccountStatus = await hasColumn(conn, 'users', 'account_status');
    const usersHasPasswordChangedAt = await hasColumn(conn, 'users', 'password_changed_at');
    const usersHasForcePasswordChange = await hasColumn(conn, 'users', 'force_password_change');
    const usersHasFailedLoginAttempts = await hasColumn(conn, 'users', 'failed_login_attempts');
    const usersHasAccountLockedUntil = await hasColumn(conn, 'users', 'account_locked_until');
    const usersHasLastLoginAt = await hasColumn(conn, 'users', 'last_login_at');
    const employeesHasForcePasswordChange = await hasColumn(conn, 'employees', 'force_password_change');

    for (const user of USERS) {
      const roleId = roleIdByName.get(user.role);
      if (!roleId) throw new Error(`Missing role: ${user.role}. Run the role migration first.`);

      // Bootstrap passwords are temporary demo credentials. They are still
      // stored only as Argon2id hashes, never plaintext or reversible data.
      const hash = await argon2.hash(user.password, ARGON2ID_OPTIONS);
      const employeeId = await ensureEmployee(conn, user, hash, employeesHasForcePasswordChange);

      const columns = ['username'];
      const values = [user.username];
      const updates = [];

      if (usersHasEmail) {
        columns.push('email');
        values.push(null);
        updates.push('email = NULL');
      }
      if (usersHasEmailHash) {
        columns.push('email_hash');
        values.push(hashNullable(user.email));
        updates.push('email_hash = VALUES(email_hash)');
      }
      if (usersHasEmailEncrypted) {
        columns.push('email_encrypted');
        values.push(encryptColumnValue(user.email));
        updates.push('email_encrypted = VALUES(email_encrypted)');
      }

      columns.push('password_hash', 'role_id', 'employee_id', 'is_active');
      values.push(hash, roleId, employeeId, 1);
      updates.push(
        'password_hash = VALUES(password_hash)',
        'role_id = VALUES(role_id)',
        'employee_id = VALUES(employee_id)',
        'is_active = 1'
      );

      if (usersHasAccountStatus) {
        columns.push('account_status');
        values.push('Active');
        updates.push("account_status = 'Active'");
      }

      if (usersHasPasswordChangedAt) {
        columns.push('password_changed_at');
        values.push(new Date());
        updates.push('password_changed_at = VALUES(password_changed_at)');
      }

      if (usersHasForcePasswordChange) {
        columns.push('force_password_change');
        values.push(0);
        updates.push('force_password_change = 0');
      }

      if (usersHasFailedLoginAttempts) {
        columns.push('failed_login_attempts');
        values.push(0);
        updates.push('failed_login_attempts = 0');
      }

      if (usersHasAccountLockedUntil) {
        columns.push('account_locked_until');
        values.push(null);
        updates.push('account_locked_until = NULL');
      }

      if (usersHasLastLoginAt) {
        columns.push('last_login_at');
        values.push(null);
      }

      const placeholders = columns.map(() => '?').join(', ');
      await conn.execute(
        `INSERT INTO users (${columns.join(', ')})
         VALUES (${placeholders})
         ON DUPLICATE KEY UPDATE ${updates.join(', ')}`,
        values
      );

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
