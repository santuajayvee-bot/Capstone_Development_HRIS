/*
 * Targeted production employee-contact updater.
 *
 * Uses the deployed application's DB and AES environment configuration, updates
 * exactly one username-linked employee, and records an audit entry. It never
 * changes credentials, roles, or any other employee field.
 *
 * Required environment variables:
 *   TARGET_USERNAME
 *   TARGET_CONTACT_NUMBER
 *
 * Usage on the production EC2 host:
 *   TARGET_USERNAME=payroll.officer TARGET_CONTACT_NUMBER=09XXXXXXXXX \
 *     node scripts/update-production-employee-contact.js --apply
 */

require('dotenv').config();

const pool = require('../config/db');
const { encryptColumnValue, decryptColumnValue } = require('../server/data-protection');
const { normalizePhilippineMobileNumber, maskPhoneNumber } = require('../utils/phoneNumberUtil');

const username = String(process.env.TARGET_USERNAME || '').trim();
const requestedPhone = normalizePhilippineMobileNumber(process.env.TARGET_CONTACT_NUMBER);
const apply = process.argv.includes('--apply');

function assertSafeProductionTarget() {
  const host = String(process.env.DB_HOST || '').trim().toLowerCase();
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();

  if (!apply) throw new Error('No changes made. Re-run with --apply after reviewing the target.');
  if (nodeEnv !== 'production') throw new Error('Refusing contact update because NODE_ENV is not production.');
  if (!host || ['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('Refusing contact update because DB_HOST is not a production database host.');
  }
  if (!username) throw new Error('TARGET_USERNAME is required.');
  if (!requestedPhone) throw new Error('TARGET_CONTACT_NUMBER must be a valid Philippine mobile number.');
}

async function updateContact() {
  assertSafeProductionTarget();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT u.id AS user_id,
              u.employee_id,
              e.id AS employee_table_id,
              COALESCE(e.Employee_ID, e.id) AS audit_employee_id
         FROM users u
         JOIN employees e ON e.id = u.employee_id
        WHERE u.username = ?
        LIMIT 1
        FOR UPDATE`,
      [username]
    );

    if (rows.length !== 1) {
      throw new Error(`Expected one active employee link for ${username}; found ${rows.length}.`);
    }

    const target = rows[0];
    const [updated] = await connection.execute(
      'UPDATE employees SET contact_number = ? WHERE id = ?',
      [encryptColumnValue(requestedPhone), target.employee_table_id]
    );
    if (updated.affectedRows !== 1) throw new Error('Employee contact update did not affect exactly one row.');

    const [[verified]] = await connection.execute(
      'SELECT contact_number FROM employees WHERE id = ? LIMIT 1',
      [target.employee_table_id]
    );
    if (normalizePhilippineMobileNumber(decryptColumnValue(verified?.contact_number)) !== requestedPhone) {
      throw new Error('Encrypted contact-number verification failed.');
    }

    const description = `Updated the registered MFA contact number for ${username}.`;
    await connection.execute(
      `INSERT INTO system_audit_log
        (employee_id, action_performed, module, ip_address, user_agent, timestamp,
         Action_Type, Description, Created_At)
       VALUES (?, ?, 'AUTH', NULL, ?, NOW(), 'MFA_CONTACT_UPDATED', ?, NOW())`,
      [
        target.audit_employee_id,
        description,
        'scripts/update-production-employee-contact.js',
        description,
      ]
    );

    await connection.commit();
    console.log(`${username} MFA contact updated and verified: ${maskPhoneNumber(requestedPhone)}`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

updateContact().catch(async (error) => {
  console.error(`Production contact update failed: ${error.message}`);
  process.exitCode = 1;
  try { await pool.end(); } catch (_) {}
});
