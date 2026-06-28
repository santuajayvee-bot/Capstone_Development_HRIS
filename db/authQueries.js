const pool = require('../config/db');
const { decryptNullable, sha256 } = require('../server/data-protection');

const DEFAULT_MAX_FAILED_ATTEMPTS = 5;
const DEFAULT_LOCK_MINUTES = 15;
const DEFAULT_REVOCATION_REASON = 'revoked';
const AUTH_QUERY_ERROR = 'Authentication database operation failed.';
const AUTH_INPUT_ERROR = 'Invalid authentication query input.';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function ensureEmployeeId(employeeId) {
  if (employeeId === undefined || employeeId === null || employeeId === '') {
    throw new Error(AUTH_INPUT_ERROR);
  }
}

function ensureNonEmptyString(value) {
  if (!isNonEmptyString(value)) {
    throw new Error(AUTH_INPUT_ERROR);
  }
}

function normalizeReason(reason) {
  if (!isNonEmptyString(reason)) return DEFAULT_REVOCATION_REASON;
  return reason.trim().slice(0, 100);
}

function normalizeLockMinutes(lockMinutes) {
  const minutes = Number.parseInt(lockMinutes, 10);
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_LOCK_MINUTES;
  return minutes;
}

function normalizeMaxFailedAttempts(maxAttempts) {
  const attempts = Number.parseInt(maxAttempts, 10);
  if (!Number.isFinite(attempts) || attempts <= 0) return DEFAULT_MAX_FAILED_ATTEMPTS;
  return attempts;
}

function isFutureDate(value) {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date > new Date();
}

function toNullable(value) {
  return value === undefined ? null : value;
}

function logAndThrow(error, operation) {
  console.error(`[authQueries] ${operation} failed:`, error.message);
  throw new Error(AUTH_QUERY_ERROR);
}

async function ensureUserAuthColumns() {
  for (const [name, definition] of [
    ['account_status', "ENUM('Active','Disabled','Offboarded','Inactive') NOT NULL DEFAULT 'Active'"],
    ['token_version', 'INT NOT NULL DEFAULT 0'],
    ['password_changed_at', 'DATETIME NULL'],
    ['force_password_change', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['failed_login_attempts', 'INT NOT NULL DEFAULT 0'],
    ['account_locked_until', 'DATETIME NULL'],
    ['last_login_at', 'DATETIME NULL'],
    ['email_hash', 'CHAR(64) NULL'],
    ['email_encrypted', 'TEXT NULL'],
  ]) {
    const [existing] = await pool.execute(`SHOW COLUMNS FROM users LIKE '${name}'`);
    if (!existing.length) await pool.execute(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
  }
}

const USER_SELECT_FIELDS = `
  COALESCE(e.Employee_ID, e.id) AS Employee_ID,
  u.id AS id,
  e.id AS employee_table_id,
  COALESCE(u.email, e.email) AS Email,
  u.email_encrypted AS User_Email_Encrypted,
  COALESCE(u.password_hash, e.Password_Hash) AS Password_Hash,
  u.role_id AS Role_ID,
  r.access_level AS Access_Level,
  COALESCE(u.failed_login_attempts, e.Failed_Login_Attempts, 0) AS Failed_Login_Attempts,
  COALESCE(u.account_locked_until, e.Locked_Until) AS Locked_Until,
  COALESCE(u.password_changed_at, e.Password_Changed_At) AS Password_Changed_At,
  COALESCE(e.Last_Login_At, u.last_login_at, u.last_login) AS Last_Login_At,
  (COALESCE(u.force_password_change, 0) OR COALESCE(e.force_password_change, 0)) AS force_password_change,
  u.username,
  u.is_active,
  u.account_status,
  COALESCE(u.token_version, 0) AS token_version,
  r.name AS role_name,
  r.label AS role_label
`;

function hydrateUserRow(row) {
  if (!row) return row;
  if (!row.Email && row.User_Email_Encrypted) {
    try {
      row.Email = decryptNullable(row.User_Email_Encrypted);
    } catch (error) {
      // Email is not required to authenticate. Do not fail login because a
      // legacy encrypted email was written with an old or missing AES key.
      console.warn('[authQueries] encrypted login email could not be decrypted:', error.message);
      row.Email = null;
    }
  }
  delete row.User_Email_Encrypted;
  return row;
}

async function findUserByEmail(email) {
  if (!isNonEmptyString(email)) return null;

  try {
    await ensureUserAuthColumns();
    const [rows] = await pool.execute(
      `SELECT ${USER_SELECT_FIELDS}
         FROM users u
         LEFT JOIN employees e ON e.id = u.employee_id
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.email_hash = ?
           OR LOWER(e.email) = LOWER(?)
           OR LOWER(u.email) = LOWER(?)
           OR LOWER(u.username) = LOWER(?)
        LIMIT 1`,
      [sha256(email), email.trim(), email.trim(), email.trim()]
    );

    return hydrateUserRow(rows[0] || null);
  } catch (error) {
    logAndThrow(error, 'findUserByEmail');
  }
}

async function findUserById(employeeId) {
  ensureEmployeeId(employeeId);

  try {
    await ensureUserAuthColumns();
    const [rows] = await pool.execute(
      `SELECT ${USER_SELECT_FIELDS}
         FROM users u
         LEFT JOIN employees e ON e.id = u.employee_id
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE e.Employee_ID = ? OR e.id = ? OR u.id = ?
        LIMIT 1`,
      [employeeId, employeeId, employeeId]
    );

    return hydrateUserRow(rows[0] || null);
  } catch (error) {
    logAndThrow(error, 'findUserById');
  }
}

async function findUserByUserId(userId) {
  ensureEmployeeId(userId);

  try {
    await ensureUserAuthColumns();
    const [rows] = await pool.execute(
      `SELECT ${USER_SELECT_FIELDS}
         FROM users u
         LEFT JOIN employees e ON e.id = u.employee_id
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id = ?
        LIMIT 1`,
      [userId]
    );

    return hydrateUserRow(rows[0] || null);
  } catch (error) {
    logAndThrow(error, 'findUserByUserId');
  }
}

async function getFailedLoginAttempts(employeeId) {
  const [rows] = await pool.execute(
    `SELECT Failed_Login_Attempts
       FROM employees
      WHERE Employee_ID = ? OR (Employee_ID IS NULL AND id = ?)
      LIMIT 1`,
    [employeeId, employeeId]
  );

  const attempts = rows[0]?.Failed_Login_Attempts;
  return attempts === undefined || attempts === null ? null : Number(attempts);
}

async function incrementFailedLoginAttempts(employeeId) {
  ensureEmployeeId(employeeId);

  try {
    const [result] = await pool.execute(
      `UPDATE employees
          SET Failed_Login_Attempts = COALESCE(Failed_Login_Attempts, 0) + 1
        WHERE Employee_ID = ? OR (Employee_ID IS NULL AND id = ?)`,
      [employeeId, employeeId]
    );
    await pool.execute(
      `UPDATE users u
        JOIN employees e ON e.id = u.employee_id
           SET u.failed_login_attempts = COALESCE(e.Failed_Login_Attempts, u.failed_login_attempts, 0)
         WHERE e.Employee_ID = ? OR (e.Employee_ID IS NULL AND e.id = ?)`,
      [employeeId, employeeId]
    );

    if (!result.affectedRows) return null;
    return await getFailedLoginAttempts(employeeId);
  } catch (error) {
    logAndThrow(error, 'incrementFailedLoginAttempts');
  }
}

// Increment and lock under one row lock so parallel failed requests cannot
// bypass the threshold or leave users/employees account state out of sync.
async function recordFailedLoginFailure(employeeId, options = {}) {
  ensureEmployeeId(employeeId);

  const maxAttempts = normalizeMaxFailedAttempts(options.maxAttempts);
  const lockMinutes = normalizeLockMinutes(options.lockMinutes);
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT id, Failed_Login_Attempts, Locked_Until
         FROM employees
        WHERE Employee_ID = ? OR (Employee_ID IS NULL AND id = ?)
        LIMIT 1
        FOR UPDATE`,
      [employeeId, employeeId]
    );
    const employee = rows[0];
    if (!employee) {
      await connection.rollback();
      return null;
    }

    if (isFutureDate(employee.Locked_Until)) {
      await connection.commit();
      return {
        attempts: Number(employee.Failed_Login_Attempts || 0),
        locked: true,
        newlyLocked: false,
        lockedUntil: employee.Locked_Until,
      };
    }

    // A completed lockout starts a fresh failure window after expiry.
    const previousAttempts = employee.Locked_Until ? 0 : Number(employee.Failed_Login_Attempts || 0);
    const attempts = previousAttempts + 1;
    const newlyLocked = attempts >= maxAttempts;

    await connection.execute(
      `UPDATE employees
          SET Failed_Login_Attempts = ?,
              Locked_Until = CASE WHEN ? THEN DATE_ADD(NOW(), INTERVAL ? MINUTE) ELSE NULL END
        WHERE id = ?`,
      [attempts, newlyLocked ? 1 : 0, lockMinutes, employee.id]
    );

    const [stateRows] = await connection.execute(
      'SELECT Failed_Login_Attempts, Locked_Until FROM employees WHERE id = ? LIMIT 1',
      [employee.id]
    );
    const state = stateRows[0];

    await connection.execute(
      `UPDATE users
          SET failed_login_attempts = ?,
              account_locked_until = ?
        WHERE employee_id = ?`,
      [state.Failed_Login_Attempts, state.Locked_Until, employee.id]
    );

    await connection.commit();
    return {
      attempts: Number(state.Failed_Login_Attempts || 0),
      locked: isFutureDate(state.Locked_Until),
      newlyLocked,
      lockedUntil: state.Locked_Until,
    };
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    logAndThrow(error, 'recordFailedLoginFailure');
  } finally {
    if (connection) connection.release();
  }
}

async function recordFailedLoginFailureForUser(userId, options = {}) {
  ensureEmployeeId(userId);

  const maxAttempts = normalizeMaxFailedAttempts(options.maxAttempts);
  const lockMinutes = normalizeLockMinutes(options.lockMinutes);
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT id, employee_id, failed_login_attempts, account_locked_until,
              account_locked_until > NOW() AS is_locked,
              account_locked_until IS NOT NULL AND account_locked_until <= NOW() AS lock_expired,
              GREATEST(TIMESTAMPDIFF(SECOND, NOW(), account_locked_until), 0) AS lock_seconds_remaining
         FROM users
        WHERE id = ?
        LIMIT 1
        FOR UPDATE`,
      [userId]
    );
    const user = rows[0];
    if (!user) {
      await connection.rollback();
      return null;
    }

    if (Number(user.is_locked || 0) === 1) {
      await connection.commit();
      return {
        attempts: Number(user.failed_login_attempts || 0),
        locked: true,
        newlyLocked: false,
        lockedUntil: user.account_locked_until,
        lockSecondsRemaining: Number(user.lock_seconds_remaining || 0),
      };
    }

    const previousAttempts = Number(user.lock_expired || 0) === 1 ? 0 : Number(user.failed_login_attempts || 0);
    const attempts = previousAttempts + 1;
    const newlyLocked = attempts >= maxAttempts;

    await connection.execute(
      `UPDATE users
          SET failed_login_attempts = ?,
              account_locked_until = CASE WHEN ? THEN DATE_ADD(NOW(), INTERVAL ? MINUTE) ELSE NULL END
        WHERE id = ?`,
      [attempts, newlyLocked ? 1 : 0, lockMinutes, user.id]
    );

    const [stateRows] = await connection.execute(
      `SELECT failed_login_attempts, account_locked_until,
              account_locked_until > NOW() AS is_locked,
              GREATEST(TIMESTAMPDIFF(SECOND, NOW(), account_locked_until), 0) AS lock_seconds_remaining
         FROM users
        WHERE id = ?
        LIMIT 1`,
      [user.id]
    );
    const state = stateRows[0];

    if (user.employee_id) {
      await connection.execute(
        `UPDATE employees
            SET Failed_Login_Attempts = ?,
                Locked_Until = ?
          WHERE id = ?`,
        [state.failed_login_attempts, state.account_locked_until, user.employee_id]
      );
    }

    await connection.commit();
    return {
      attempts: Number(state.failed_login_attempts || 0),
      locked: Number(state.is_locked || 0) === 1,
      newlyLocked,
      lockedUntil: state.account_locked_until,
      lockSecondsRemaining: Number(state.lock_seconds_remaining || 0),
    };
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    logAndThrow(error, 'recordFailedLoginFailureForUser');
  } finally {
    if (connection) connection.release();
  }
}

async function getUserLoginLockState(userId) {
  ensureEmployeeId(userId);

  try {
    await ensureUserAuthColumns();
    const [rows] = await pool.execute(
      `SELECT failed_login_attempts, account_locked_until,
              account_locked_until > NOW() AS is_locked,
              GREATEST(TIMESTAMPDIFF(SECOND, NOW(), account_locked_until), 0) AS lock_seconds_remaining
         FROM users
        WHERE id = ?
        LIMIT 1`,
      [userId]
    );
    const state = rows[0] || null;
    if (!state) return null;
    return {
      attempts: Number(state.failed_login_attempts || 0),
      locked: Number(state.is_locked || 0) === 1,
      lockedUntil: state.account_locked_until,
      lockSecondsRemaining: Number(state.lock_seconds_remaining || 0),
    };
  } catch (error) {
    logAndThrow(error, 'getUserLoginLockState');
  }
}

async function resetFailedLoginAttempts(employeeId) {
  ensureEmployeeId(employeeId);

  try {
    const [result] = await pool.execute(
      `UPDATE employees
          SET Failed_Login_Attempts = 0,
              Locked_Until = NULL
        WHERE Employee_ID = ? OR (Employee_ID IS NULL AND id = ?)`,
      [employeeId, employeeId]
    );
    await pool.execute(
      `UPDATE users u
        JOIN employees e ON e.id = u.employee_id
           SET u.failed_login_attempts = 0,
               u.account_locked_until = NULL
         WHERE e.Employee_ID = ? OR (e.Employee_ID IS NULL AND e.id = ?)`,
      [employeeId, employeeId]
    );

    return result.affectedRows;
  } catch (error) {
    logAndThrow(error, 'resetFailedLoginAttempts');
  }
}

async function resetFailedLoginAttemptsForUser(userId) {
  ensureEmployeeId(userId);

  try {
    const [result] = await pool.execute(
      `UPDATE users
          SET failed_login_attempts = 0,
              account_locked_until = NULL
        WHERE id = ?`,
      [userId]
    );
    await pool.execute(
      `UPDATE employees e
        JOIN users u ON u.employee_id = e.id
           SET e.Failed_Login_Attempts = 0,
               e.Locked_Until = NULL
         WHERE u.id = ?`,
      [userId]
    );

    return result.affectedRows;
  } catch (error) {
    logAndThrow(error, 'resetFailedLoginAttemptsForUser');
  }
}

async function lockUserAccount(employeeId, lockMinutes = DEFAULT_LOCK_MINUTES) {
  ensureEmployeeId(employeeId);

  try {
    const [result] = await pool.execute(
      `UPDATE employees
          SET Locked_Until = DATE_ADD(NOW(), INTERVAL ? MINUTE)
        WHERE Employee_ID = ? OR (Employee_ID IS NULL AND id = ?)`,
      [normalizeLockMinutes(lockMinutes), employeeId, employeeId]
    );
    await pool.execute(
      `UPDATE users u
        JOIN employees e ON e.id = u.employee_id
           SET u.account_locked_until = e.Locked_Until
         WHERE e.Employee_ID = ? OR (e.Employee_ID IS NULL AND e.id = ?)`,
      [employeeId, employeeId]
    );

    return result.affectedRows;
  } catch (error) {
    logAndThrow(error, 'lockUserAccount');
  }
}

async function updateLastLogin(employeeId) {
  ensureEmployeeId(employeeId);

  try {
    const [result] = await pool.execute(
      `UPDATE employees
          SET Last_Login_At = NOW()
        WHERE Employee_ID = ? OR (Employee_ID IS NULL AND id = ?)`,
      [employeeId, employeeId]
    );
    await pool.execute(
      `UPDATE users u
        JOIN employees e ON e.id = u.employee_id
           SET u.last_login = NOW(),
               u.last_login_at = NOW()
         WHERE e.Employee_ID = ? OR (e.Employee_ID IS NULL AND e.id = ?)`,
      [employeeId, employeeId]
    );

    return result.affectedRows;
  } catch (error) {
    logAndThrow(error, 'updateLastLogin');
  }
}

async function updatePasswordHash(employeeId, passwordHash) {
  ensureEmployeeId(employeeId);
  ensureNonEmptyString(passwordHash);

  try {
    const [result] = await pool.execute(
      `UPDATE employees
          SET Password_Hash = ?,
              Password_Changed_At = NOW(),
              Failed_Login_Attempts = 0,
              Locked_Until = NULL,
              force_password_change = 0
        WHERE Employee_ID = ? OR (Employee_ID IS NULL AND id = ?)`,
      [passwordHash, employeeId, employeeId]
    );
    await pool.execute(
      `UPDATE users u
        JOIN employees e ON e.id = u.employee_id
           SET u.password_hash = ?,
               u.password_changed_at = NOW(),
               u.force_password_change = 0,
               u.failed_login_attempts = 0,
               u.account_locked_until = NULL
         WHERE e.Employee_ID = ? OR (e.Employee_ID IS NULL AND e.id = ?)`,
      [passwordHash, employeeId, employeeId]
    );

    return result.affectedRows;
  } catch (error) {
    logAndThrow(error, 'updatePasswordHash');
  }
}

async function createUserSession(sessionData) {
  const {
    Employee_ID,
    Refresh_Token_Hash,
    JWT_ID,
    IP_Address,
    User_Agent,
    Expires_At,
  } = sessionData || {};

  ensureEmployeeId(Employee_ID);
  ensureNonEmptyString(Refresh_Token_Hash);
  ensureNonEmptyString(JWT_ID);

  if (!Expires_At) {
    throw new Error(AUTH_INPUT_ERROR);
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO USER_SESSION
        (Employee_ID, Refresh_Token_Hash, JWT_ID, IP_Address, User_Agent, Expires_At)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        Employee_ID,
        Refresh_Token_Hash,
        JWT_ID,
        toNullable(IP_Address),
        toNullable(User_Agent),
        Expires_At,
      ]
    );

    return result.insertId;
  } catch (error) {
    logAndThrow(error, 'createUserSession');
  }
}

async function findActiveSessionByRefreshTokenHash(refreshTokenHash) {
  if (!isNonEmptyString(refreshTokenHash)) return null;

  try {
    await ensureUserAuthColumns();
    const [rows] = await pool.execute(
      `SELECT
         s.Session_ID,
         s.Employee_ID,
         s.Refresh_Token_Hash,
         s.JWT_ID,
         s.IP_Address,
         s.User_Agent,
         s.Created_At,
         s.Last_Activity,
         s.Expires_At,
         s.Revoked_At,
         s.Revocation_Reason,
         e.id AS employee_table_id,
         e.email AS Email,
         u.id AS id,
         u.role_id AS Role_ID,
         r.access_level AS Access_Level,
         r.name AS role_name,
         r.label AS role_label
       FROM USER_SESSION s
       LEFT JOIN employees e ON e.Employee_ID = s.Employee_ID
       LEFT JOIN users u ON u.employee_id = e.id
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE s.Refresh_Token_Hash = ?
         AND s.Revoked_At IS NULL
         AND s.Expires_At > NOW()
       LIMIT 1`,
      [refreshTokenHash]
    );

    return rows[0] || null;
  } catch (error) {
    logAndThrow(error, 'findActiveSessionByRefreshTokenHash');
  }
}

async function revokeSessionByJwtId(jwtId, reason) {
  ensureNonEmptyString(jwtId);

  try {
    const [result] = await pool.execute(
      `UPDATE USER_SESSION
          SET Revoked_At = NOW(),
              Revocation_Reason = ?
        WHERE JWT_ID = ?
          AND Revoked_At IS NULL`,
      [normalizeReason(reason), jwtId]
    );

    return result.affectedRows;
  } catch (error) {
    logAndThrow(error, 'revokeSessionByJwtId');
  }
}

async function revokeSessionByRefreshTokenHash(refreshTokenHash, reason) {
  ensureNonEmptyString(refreshTokenHash);

  try {
    const [result] = await pool.execute(
      `UPDATE USER_SESSION
          SET Revoked_At = NOW(),
              Revocation_Reason = ?
        WHERE Refresh_Token_Hash = ?
          AND Revoked_At IS NULL`,
      [normalizeReason(reason), refreshTokenHash]
    );

    return result.affectedRows;
  } catch (error) {
    logAndThrow(error, 'revokeSessionByRefreshTokenHash');
  }
}

async function revokeAllUserSessions(employeeId, reason) {
  ensureEmployeeId(employeeId);

  try {
    const [result] = await pool.execute(
      `UPDATE USER_SESSION
          SET Revoked_At = NOW(),
              Revocation_Reason = ?
        WHERE Employee_ID = ?
          AND Revoked_At IS NULL`,
      [normalizeReason(reason), employeeId]
    );

    return result.affectedRows;
  } catch (error) {
    logAndThrow(error, 'revokeAllUserSessions');
  }
}

async function rotateRefreshToken(sessionId, newRefreshTokenHash, newJwtId, newExpiresAt) {
  ensureEmployeeId(sessionId);
  ensureNonEmptyString(newRefreshTokenHash);
  ensureNonEmptyString(newJwtId);

  if (!newExpiresAt) {
    throw new Error(AUTH_INPUT_ERROR);
  }

  try {
    const [result] = await pool.execute(
      `UPDATE USER_SESSION
          SET Refresh_Token_Hash = ?,
              JWT_ID = ?,
              Expires_At = ?,
              Last_Activity = NOW()
        WHERE Session_ID = ?
          AND Revoked_At IS NULL`,
      [newRefreshTokenHash, newJwtId, newExpiresAt, sessionId]
    );

    return result.affectedRows;
  } catch (error) {
    logAndThrow(error, 'rotateRefreshToken');
  }
}

async function createPasswordResetToken(employeeId, resetTokenHash, expiresAt, ipAddress) {
  ensureEmployeeId(employeeId);
  ensureNonEmptyString(resetTokenHash);

  if (!expiresAt) {
    throw new Error(AUTH_INPUT_ERROR);
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO PASSWORD_RESET_TOKEN
        (Employee_ID, Reset_Token_Hash, Expires_At, IP_Address)
       VALUES (?, ?, ?, ?)`,
      [employeeId, resetTokenHash, expiresAt, toNullable(ipAddress)]
    );

    return result.insertId;
  } catch (error) {
    logAndThrow(error, 'createPasswordResetToken');
  }
}

async function findValidPasswordResetToken(resetTokenHash) {
  if (!isNonEmptyString(resetTokenHash)) return null;

  try {
    await ensureUserAuthColumns();
    const [rows] = await pool.execute(
      `SELECT
         Reset_ID,
         Employee_ID,
         Reset_Token_Hash,
         Created_At,
         Expires_At,
         Used_At,
         IP_Address
       FROM PASSWORD_RESET_TOKEN
       WHERE Reset_Token_Hash = ?
         AND Used_At IS NULL
         AND Expires_At > NOW()
       LIMIT 1`,
      [resetTokenHash]
    );

    return rows[0] || null;
  } catch (error) {
    logAndThrow(error, 'findValidPasswordResetToken');
  }
}

async function markPasswordResetTokenUsed(resetId) {
  ensureEmployeeId(resetId);

  try {
    const [result] = await pool.execute(
      `UPDATE PASSWORD_RESET_TOKEN
          SET Used_At = NOW()
        WHERE Reset_ID = ?
          AND Used_At IS NULL`,
      [resetId]
    );

    return result.affectedRows;
  } catch (error) {
    logAndThrow(error, 'markPasswordResetTokenUsed');
  }
}

async function createAuditLog(logData) {
  const {
    Employee_ID,
    Action_Type,
    Description,
    IP_Address,
    User_Agent,
  } = logData || {};

  ensureNonEmptyString(Action_Type);

  const description = toNullable(Description);
  const actionPerformed = (description || Action_Type).slice(0, 255);

  try {
    const [result] = await pool.execute(
      `INSERT INTO system_audit_log
        (employee_id, action_performed, module, ip_address, user_agent, timestamp,
         Action_Type, Description, Created_At)
       VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, NOW())`,
      [
        toNullable(Employee_ID),
        actionPerformed,
        'AUTH',
        toNullable(IP_Address),
        toNullable(User_Agent),
        Action_Type,
        description,
      ]
    );

    return result.insertId;
  } catch (error) {
    logAndThrow(error, 'createAuditLog');
  }
}

module.exports = {
  findUserByEmail,
  findUserById,
  findUserByUserId,
  incrementFailedLoginAttempts,
  recordFailedLoginFailure,
  recordFailedLoginFailureForUser,
  getUserLoginLockState,
  resetFailedLoginAttempts,
  resetFailedLoginAttemptsForUser,
  lockUserAccount,
  updateLastLogin,
  updatePasswordHash,
  createUserSession,
  findActiveSessionByRefreshTokenHash,
  revokeSessionByJwtId,
  revokeSessionByRefreshTokenHash,
  revokeAllUserSessions,
  rotateRefreshToken,
  createPasswordResetToken,
  findValidPasswordResetToken,
  markPasswordResetTokenUsed,
  createAuditLog,
  _hydrateUserRowForTest: hydrateUserRow,
};
