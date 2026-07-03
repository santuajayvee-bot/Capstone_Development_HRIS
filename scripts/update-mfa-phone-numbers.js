/*
 * Updates the registered MFA mobile numbers for privileged LGSV HR accounts.
 *
 * This script uses the deployed application's DB and AES configuration so
 * employee contact numbers remain encrypted at rest. It does not touch
 * credentials, roles, payroll data, or blockchain records.
 *
 * Usage:
 *   node scripts/update-mfa-phone-numbers.js           # dry-run only
 *   node scripts/update-mfa-phone-numbers.js --apply   # write and verify
 */

require('dotenv').config();

const pool = require('../config/db');
const { decryptColumnValue, encryptColumnValue } = require('../server/data-protection');
const { maskPhoneNumber, normalizePhilippineMobileNumber } = require('../utils/phoneNumberUtil');

const MFA_PHONE_TARGETS = [
  { username: 'hr.admin', phoneNumber: '09192017325' },
  { username: 'sys.admin', phoneNumber: '09085528852' },
  { username: 'payroll.officer', phoneNumber: '09913845895' },
];

const applyChanges = process.argv.includes('--apply');

async function getColumns(connection, tableName) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [tableName]
  );
  return new Set(rows.map(row => row.COLUMN_NAME));
}

function sqlNow() {
  return { raw: 'NOW()' };
}

function addAuditValue(columns, insertColumns, values, columnName, value) {
  if (!columns.has(columnName)) return;
  insertColumns.push(columnName);
  values.push(value);
}

async function insertAuditLog(connection, auditColumns, target, previousPhone, nextPhone) {
  if (!auditColumns.size) return;

  const maskedPrevious = maskPhoneNumber(previousPhone) || 'not set';
  const maskedNext = maskPhoneNumber(nextPhone);
  const description = `Updated registered MFA contact number for ${target.username}.`;
  const insertColumns = [];
  const values = [];

  addAuditValue(auditColumns, insertColumns, values, 'user_id', target.user_id);
  addAuditValue(auditColumns, insertColumns, values, 'employee_id', target.audit_employee_id);
  addAuditValue(auditColumns, insertColumns, values, 'target_employee_id', target.audit_employee_id);
  addAuditValue(auditColumns, insertColumns, values, 'action_performed', 'MFA_CONTACT_UPDATED');
  addAuditValue(auditColumns, insertColumns, values, 'module', 'AUTH_SECURITY');
  addAuditValue(auditColumns, insertColumns, values, 'old_value', maskedPrevious);
  addAuditValue(auditColumns, insertColumns, values, 'new_value', maskedNext);
  addAuditValue(auditColumns, insertColumns, values, 'ip_address', null);
  addAuditValue(auditColumns, insertColumns, values, 'user_agent', 'scripts/update-mfa-phone-numbers.js');
  addAuditValue(auditColumns, insertColumns, values, 'Action_Type', 'MFA_CONTACT_UPDATED');
  addAuditValue(auditColumns, insertColumns, values, 'Description', description);

  if (auditColumns.has('timestamp')) {
    insertColumns.push('timestamp');
    values.push(sqlNow());
  }
  if (auditColumns.has('Created_At')) {
    insertColumns.push('Created_At');
    values.push(sqlNow());
  }
  if (auditColumns.has('created_at')) {
    insertColumns.push('created_at');
    values.push(sqlNow());
  }

  if (!insertColumns.length) return;

  const placeholders = values.map(value => (value && value.raw ? value.raw : '?')).join(', ');
  const params = values.filter(value => !(value && value.raw));
  await connection.execute(
    `INSERT INTO system_audit_log (${insertColumns.map(column => `\`${column}\``).join(', ')})
     VALUES (${placeholders})`,
    params
  );
}

function normalizeTarget(target) {
  const phoneNumber = normalizePhilippineMobileNumber(target.phoneNumber);
  if (!phoneNumber) {
    throw new Error(`Invalid Philippine mobile number configured for ${target.username}.`);
  }
  return {
    username: String(target.username || '').trim().toLowerCase(),
    phoneNumber,
  };
}

async function findTargetAccount(connection, username, lockForUpdate) {
  const [rows] = await connection.execute(
    `SELECT u.id AS user_id,
            u.username,
            u.employee_id,
            e.id AS employee_table_id,
            COALESCE(e.Employee_ID, e.id) AS audit_employee_id,
            e.contact_number
       FROM users u
       LEFT JOIN employees e ON e.id = u.employee_id
      WHERE LOWER(u.username) = ?
      LIMIT 1 ${lockForUpdate ? 'FOR UPDATE' : ''}`,
    [username]
  );

  if (!rows.length) throw new Error(`User account not found: ${username}`);
  if (!rows[0].employee_table_id) {
    throw new Error(`User account has no linked employee record: ${username}`);
  }
  return rows[0];
}

async function updateMfaPhoneNumbers() {
  const targets = MFA_PHONE_TARGETS.map(normalizeTarget);
  const connection = await pool.getConnection();

  try {
    const employeeColumns = await getColumns(connection, 'employees');
    if (!employeeColumns.has('contact_number')) {
      throw new Error('employees.contact_number column is missing.');
    }

    const auditColumns = await getColumns(connection, 'system_audit_log');
    const results = [];

    if (applyChanges) await connection.beginTransaction();

    for (const target of targets) {
      const account = await findTargetAccount(connection, target.username, applyChanges);
      const previousPhone = normalizePhilippineMobileNumber(decryptColumnValue(account.contact_number));
      const maskedPrevious = maskPhoneNumber(previousPhone) || 'not set';
      const maskedNext = maskPhoneNumber(target.phoneNumber);

      if (applyChanges) {
        const [updated] = await connection.execute(
          'UPDATE employees SET contact_number = ? WHERE id = ?',
          [encryptColumnValue(target.phoneNumber), account.employee_table_id]
        );
        if (updated.affectedRows !== 1) {
          throw new Error(`Contact update did not affect exactly one row for ${target.username}.`);
        }

        const [[verified]] = await connection.execute(
          'SELECT contact_number FROM employees WHERE id = ? LIMIT 1',
          [account.employee_table_id]
        );
        const verifiedPhone = normalizePhilippineMobileNumber(decryptColumnValue(verified?.contact_number));
        if (verifiedPhone !== target.phoneNumber) {
          throw new Error(`Encrypted contact-number verification failed for ${target.username}.`);
        }

        await insertAuditLog(connection, auditColumns, account, previousPhone, target.phoneNumber);
      }

      results.push({
        username: target.username,
        previous: maskedPrevious,
        next: maskedNext,
      });
    }

    if (applyChanges) await connection.commit();

    const mode = applyChanges ? 'Applied' : 'Dry run';
    console.log(`${mode} MFA contact-number update:`);
    for (const result of results) {
      console.log(`- ${result.username}: ${result.previous} -> ${result.next}`);
    }
    if (!applyChanges) {
      console.log('No database changes were made. Re-run with --apply to update AWS production.');
    }
  } catch (error) {
    if (applyChanges) {
      try { await connection.rollback(); } catch (_) {}
    }
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

updateMfaPhoneNumbers().catch(async (error) => {
  console.error(`MFA contact-number update failed: ${error.message}`);
  process.exitCode = 1;
  try { await pool.end(); } catch (_) {}
});
