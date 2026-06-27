const crypto = require('crypto');

const pool = require('../config/db');
const { hashTemporaryPassword } = require('../services/passwordService');

const APPLY = process.argv.includes('--apply');

async function run() {
  const [legacyAccounts] = await pool.execute(`
    SELECT u.id, u.employee_id, e.Employee_ID AS legacy_employee_id
      FROM users u
      LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.password_hash NOT LIKE '$argon2id$%'
  `);

  if (!legacyAccounts.length) {
    console.log('PASS: No legacy user password hashes found.');
    return;
  }

  console.log(`Found ${legacyAccounts.length} legacy password hash(es).`);
  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to invalidate legacy credentials securely.');
    return;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const account of legacyAccounts) {
      const unusableRandomPassword = crypto.randomBytes(64).toString('base64url');
      const argon2idHash = await hashTemporaryPassword(unusableRandomPassword);

      await connection.execute(
        `UPDATE users
            SET password_hash = ?,
                is_active = 0,
                account_status = 'Disabled',
                force_password_change = 1,
                password_changed_at = NOW(),
                token_version = COALESCE(token_version, 0) + 1,
                failed_login_attempts = 0,
                account_locked_until = NULL
          WHERE id = ?`,
        [argon2idHash, account.id]
      );

      if (account.employee_id) {
        await connection.execute(
          `UPDATE employees
              SET Password_Hash = ?,
                  Password_Changed_At = NULL,
                  Failed_Login_Attempts = 0,
                  Locked_Until = NULL,
                  force_password_change = 1
            WHERE id = ?`,
          [argon2idHash, account.employee_id]
        );
      }

      const sessionEmployeeId = account.legacy_employee_id || account.employee_id;
      if (sessionEmployeeId) {
        await connection.execute(
          `UPDATE USER_SESSION
              SET Revoked_At = NOW(), Revocation_Reason = 'legacy_password_hash_invalidated'
            WHERE Employee_ID = ? AND Revoked_At IS NULL`,
          [sessionEmployeeId]
        );
      }

      await connection.execute(
        `INSERT INTO system_audit_log
           (user_id, employee_id, target_employee_id, action_performed, module,
            old_value, new_value, ip_address, user_agent, timestamp,
            Action_Type, Description, Created_At)
         VALUES (NULL, NULL, ?, 'Legacy password credential invalidated', 'AUTH',
                 ?, ?, '127.0.0.1', 'security-migration-script', NOW(),
                 'LEGACY_PASSWORD_HASH_INVALIDATED',
                 'Non-Argon2id credential disabled; administrator reset is required.', NOW())`,
        [
          account.employee_id || null,
          JSON.stringify({ hash_policy: 'legacy_non_argon2id' }),
          JSON.stringify({
            hash_policy: 'argon2id',
            account_disabled: true,
            force_password_change: true,
            sessions_revoked: true,
          }),
        ]
      );
    }
    await connection.commit();
    console.log(`PASS: Invalidated ${legacyAccounts.length} legacy credential(s).`);
    console.log('Affected accounts require administrator password reset and reactivation.');
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

run()
  .catch(error => {
    console.error(`Legacy password migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
