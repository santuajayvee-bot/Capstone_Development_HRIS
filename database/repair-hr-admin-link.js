require('dotenv').config();
const pool = require('../config/db');
const { createAuditLog } = require('../db/authQueries');
const argon2 = require('argon2');

const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
};

async function repair() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [users] = await connection.execute(
      `SELECT id, username, email, password_hash, employee_id
         FROM users
        WHERE LOWER(username) = 'hr.admin'
        LIMIT 1`
    );
    const user = users[0];
    if (!user) throw new Error('hr.admin user record was not found.');

    const [employees] = await connection.execute(
      `SELECT id, Employee_ID
         FROM employees
        WHERE employee_code = 'HR-ADMIN'
           OR LOWER(email) = LOWER(COALESCE(?, 'hr.admin@lgsv.local'))
        ORDER BY id
        LIMIT 1`,
      [user.email]
    );

    let employee = employees[0];
    if (!employee) {
      const [created] = await connection.execute(
        `INSERT INTO employees
           (employee_code, first_name, last_name, email, position, employment_type,
            status, Password_Hash, Password_Changed_At, Failed_Login_Attempts,
            Locked_Until, MFA_Enabled)
         VALUES ('HR-ADMIN', 'HR', 'Administrator', ?, 'HR Admin', 'Full-time',
                 'Active', ?, NOW(), 0, NULL, 1)`,
        [user.email || 'hr.admin@lgsv.local', user.password_hash]
      );
      employee = { id: created.insertId, Employee_ID: null };
    }

    await connection.execute(
      'UPDATE employees SET Employee_ID = COALESCE(Employee_ID, id) WHERE id = ?',
      [employee.id]
    );
    const [linkedEmployee] = await connection.execute(
      'SELECT id, Employee_ID FROM employees WHERE id = ? LIMIT 1',
      [employee.id]
    );

    await connection.execute(
      `UPDATE users
          SET employee_id = ?,
              is_active = 1,
              account_status = 'Active'
        WHERE id = ?`,
      [employee.id, user.id]
    );

    const bootstrapPassword = process.env.LOCAL_HR_ADMIN_BOOTSTRAP_PASSWORD;
    if (bootstrapPassword) {
      if (bootstrapPassword.length < 8) {
        throw new Error('Local bootstrap password must be at least 8 characters.');
      }
      const passwordHash = await argon2.hash(bootstrapPassword, ARGON2ID_OPTIONS);
      await connection.execute(
        'UPDATE users SET password_hash = ?, failed_login_attempts = 0, account_locked_until = NULL WHERE id = ?',
        [passwordHash, user.id]
      );
      await connection.execute(
        `UPDATE employees
            SET Password_Hash = ?, Failed_Login_Attempts = 0, Locked_Until = NULL
          WHERE id = ?`,
        [passwordHash, employee.id]
      );
    }
    await connection.commit();

    await createAuditLog({
      Employee_ID: linkedEmployee[0].Employee_ID || employee.id,
      Action_Type: 'ACCOUNT_EMPLOYEE_LINK_REPAIRED',
      Description: bootstrapPassword
        ? 'Restored the employee link and reset the local hr.admin bootstrap password.'
        : 'Restored the employee link for the local hr.admin account.',
      IP_Address: null,
      User_Agent: 'database/repair-hr-admin-link.js',
    }).catch(() => {});

    console.log(`hr.admin linked to employee record ${employee.id}.`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

repair().catch((error) => {
  console.error('Failed to repair hr.admin employee link:', error.message);
  process.exitCode = 1;
});
