const crypto = require('crypto');

const pool = require('../config/db');
const {
  hashPassword,
  hashTemporaryPassword,
  verifyPassword,
  validatePasswordStrength,
  validateTemporaryPassword,
} = require('./passwordService');

class AccountPasswordError extends Error {
  constructor(message, statusCode = 400, code = 'ACCOUNT_PASSWORD_ERROR', details = null) {
    super(message);
    this.name = 'AccountPasswordError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeUserId(value) {
  const userId = Number.parseInt(value, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new AccountPasswordError('Invalid user account.', 400, 'INVALID_USER');
  }
  return userId;
}

function normalizeEmployeeId(value) {
  const employeeId = Number.parseInt(value, 10);
  return Number.isFinite(employeeId) && employeeId > 0 ? employeeId : null;
}

function normalizePasswordInput(currentPassword, newPassword, confirmPassword) {
  if (!isNonEmptyString(currentPassword)) {
    throw new AccountPasswordError('Current password is required.', 400, 'CURRENT_PASSWORD_REQUIRED');
  }

  if (!isNonEmptyString(newPassword) || !isNonEmptyString(confirmPassword)) {
    throw new AccountPasswordError('New password and confirmation are required.', 400, 'NEW_PASSWORD_REQUIRED');
  }

  if (newPassword !== confirmPassword) {
    throw new AccountPasswordError('Passwords do not match.', 400, 'PASSWORD_MISMATCH');
  }

  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    throw new AccountPasswordError(
      'Password does not meet requirements.',
      400,
      'PASSWORD_POLICY_FAILED',
      strength.errors
    );
  }
}

function generateTemporaryPassword() {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const symbols = '!@#$%^&*';
  const all = `${lower}${upper}${digits}${symbols}`;
  const required = [
    lower[crypto.randomInt(lower.length)],
    upper[crypto.randomInt(upper.length)],
    digits[crypto.randomInt(digits.length)],
    symbols[crypto.randomInt(symbols.length)],
  ];

  while (required.length < 16) {
    required.push(all[crypto.randomInt(all.length)]);
  }

  for (let i = required.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [required[i], required[j]] = [required[j], required[i]];
  }

  return required.join('');
}

async function getAccountByUserId(userId, connection = pool) {
  const normalizedUserId = normalizeUserId(userId);
  const [rows] = await connection.execute(
    `SELECT
       u.id,
       u.username,
       u.password_hash,
       u.employee_id,
       u.password_changed_at,
       u.force_password_change,
       u.failed_login_attempts,
       u.account_locked_until,
       u.last_login_at,
       e.Employee_ID,
       e.Password_Hash AS employee_password_hash,
       e.Password_Changed_At AS employee_password_changed_at
     FROM users u
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.id = ?
     LIMIT 1`,
    [normalizedUserId]
  );
  return rows[0] || null;
}

async function writePasswordAudit(connection, {
  actorUserId,
  actorEmployeeId,
  targetEmployeeId,
  actionType,
  description,
  status = 'SUCCESS',
  ipAddress = null,
  userAgent = null,
  metadata = {},
}) {
  await connection.execute(
    `INSERT INTO system_audit_log
       (user_id, employee_id, target_employee_id, action_performed, module,
        old_value, new_value, ip_address, user_agent, timestamp,
        Action_Type, Description, Created_At)
     VALUES (?, ?, ?, ?, 'AUTH', NULL, ?, ?, ?, NOW(), ?, ?, NOW())`,
    [
      actorUserId || null,
      actorEmployeeId || null,
      targetEmployeeId || null,
      description,
      JSON.stringify({ status, ...metadata }),
      ipAddress,
      userAgent,
      actionType,
      description,
    ]
  );
}

async function syncPasswordHash(connection, {
  userId,
  employeeId,
  passwordHash,
  forcePasswordChange,
}) {
  await connection.execute(
    `UPDATE users
        SET password_hash = ?,
            password_changed_at = NOW(),
            force_password_change = ?,
            failed_login_attempts = 0,
            account_locked_until = NULL
      WHERE id = ?`,
    [passwordHash, forcePasswordChange ? 1 : 0, userId]
  );

  if (employeeId) {
    await connection.execute(
      `UPDATE employees
          SET Password_Hash = ?,
              Password_Changed_At = CASE WHEN ? = 1 THEN NULL ELSE NOW() END,
              Failed_Login_Attempts = 0,
              Locked_Until = NULL,
              force_password_change = ?
        WHERE id = ?`,
      [passwordHash, forcePasswordChange ? 1 : 0, forcePasswordChange ? 1 : 0, employeeId]
    );
  }
}

async function revokeUserSessions(connection, employeeId, reason) {
  const normalizedEmployeeId = normalizeEmployeeId(employeeId);
  if (!normalizedEmployeeId) return 0;

  const [result] = await connection.execute(
    `UPDATE USER_SESSION
        SET Revoked_At = NOW(),
            Revocation_Reason = ?
      WHERE Employee_ID = ?
        AND Revoked_At IS NULL`,
    [reason, normalizedEmployeeId]
  );

  return result.affectedRows || 0;
}

async function auditFailedOwnPasswordChange({
  userId,
  employeeId,
  reason,
  ipAddress,
  userAgent,
}) {
  const connection = await pool.getConnection();
  try {
    await writePasswordAudit(connection, {
      actorUserId: userId,
      actorEmployeeId: employeeId,
      targetEmployeeId: employeeId,
      actionType: 'PASSWORD_CHANGE_FAILED',
      description: reason,
      status: 'FAILED',
      ipAddress,
      userAgent,
    });
  } finally {
    connection.release();
  }
}

async function changeOwnPassword({
  userId,
  employeeId,
  currentPassword,
  newPassword,
  confirmPassword,
  ipAddress,
  userAgent,
}) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedEmployeeId = normalizeEmployeeId(employeeId);

  normalizePasswordInput(currentPassword, newPassword, confirmPassword);

  const account = await getAccountByUserId(normalizedUserId);
  if (!account || !account.password_hash) {
    throw new AccountPasswordError('Account not found.', 404, 'ACCOUNT_NOT_FOUND');
  }

  const currentMatches = await verifyPassword(account.password_hash, currentPassword);
  if (!currentMatches) {
    await auditFailedOwnPasswordChange({
      userId: normalizedUserId,
      employeeId: normalizedEmployeeId,
      reason: 'Failed password change due to wrong current password.',
      ipAddress,
      userAgent,
    });
    throw new AccountPasswordError('Current password is incorrect.', 400, 'CURRENT_PASSWORD_INCORRECT');
  }

  const passwordHash = await hashPassword(newPassword);
  const connection = await pool.getConnection();
  const targetEmployeeId = normalizeEmployeeId(account.employee_id || normalizedEmployeeId);
  const wasForced = Boolean(Number(account.force_password_change));

  try {
    await connection.beginTransaction();
    await syncPasswordHash(connection, {
      userId: normalizedUserId,
      employeeId: targetEmployeeId,
      passwordHash,
      forcePasswordChange: false,
    });

    // Password changes revoke active sessions so old tokens cannot continue
    // accessing HR/payroll data after credentials have rotated.
    const revokedSessions = await revokeUserSessions(
      connection,
      account.Employee_ID || targetEmployeeId,
      'password_changed'
    );

    await writePasswordAudit(connection, {
      actorUserId: normalizedUserId,
      actorEmployeeId: normalizedEmployeeId,
      targetEmployeeId,
      actionType: wasForced ? 'FIRST_TIME_PASSWORD_CHANGE_COMPLETED' : 'PASSWORD_CHANGE_SUCCESS',
      description: wasForced
        ? 'First-time password setup completed.'
        : 'User changed own password successfully.',
      status: 'SUCCESS',
      ipAddress,
      userAgent,
      metadata: { revoked_sessions: revokedSessions },
    });

    await connection.commit();
    return { wasForced, revokedSessions };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function adminResetPassword({
  actorUserId,
  actorEmployeeId,
  targetUserId,
  temporaryPassword,
  ipAddress,
  userAgent,
}) {
  const normalizedTargetUserId = normalizeUserId(targetUserId);
  const account = await getAccountByUserId(normalizedTargetUserId);
  if (!account) {
    throw new AccountPasswordError('User account not found.', 404, 'ACCOUNT_NOT_FOUND');
  }

  const generated = !isNonEmptyString(temporaryPassword);
  const passwordToSet = generated ? generateTemporaryPassword() : temporaryPassword;
  const temporaryValidation = validateTemporaryPassword(passwordToSet);
  if (!temporaryValidation.valid) {
    throw new AccountPasswordError(
      'Temporary password is invalid.',
      400,
      'TEMPORARY_PASSWORD_INVALID',
      temporaryValidation.errors
    );
  }

  const passwordHash = await hashTemporaryPassword(passwordToSet);
  const connection = await pool.getConnection();
  const targetEmployeeId = normalizeEmployeeId(account.employee_id);

  try {
    await connection.beginTransaction();
    await syncPasswordHash(connection, {
      userId: normalizedTargetUserId,
      employeeId: targetEmployeeId,
      passwordHash,
      forcePasswordChange: true,
    });

    const revokedSessions = await revokeUserSessions(
      connection,
      account.Employee_ID || targetEmployeeId,
      'admin_password_reset'
    );

    await writePasswordAudit(connection, {
      actorUserId,
      actorEmployeeId,
      targetEmployeeId,
      actionType: 'ADMIN_PASSWORD_RESET',
      description: `System Administrator reset password for user ${account.username}.`,
      status: 'SUCCESS',
      ipAddress,
      userAgent,
      metadata: {
        target_user_id: normalizedTargetUserId,
        force_password_change: true,
        generated_temporary_password: generated,
        revoked_sessions: revokedSessions,
      },
    });

    await connection.commit();
    return {
      generated,
      temporaryPassword: generated ? passwordToSet : null,
      targetUserId: normalizedTargetUserId,
      targetEmployeeId,
      revokedSessions,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  AccountPasswordError,
  adminResetPassword,
  changeOwnPassword,
  generateTemporaryPassword,
  getAccountByUserId,
};
