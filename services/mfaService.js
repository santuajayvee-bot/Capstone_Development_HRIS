const crypto = require('crypto');
const pool = require('../config/db');
const { decryptColumnValue, encryptColumnValue, hashNullable } = require('../server/data-protection');
const { createAuditLog } = require('../db/authQueries');
const {
  getIprogConfig,
  sendSms,
  sendOtp,
  verifyOtp,
} = require('./iprogSmsService');
const {
  maskPhoneNumber,
  normalizePhilippineMobileNumber,
} = require('../utils/phoneNumberUtil');

const MAX_MFA_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;
let mfaSchemaReady = false;

class MfaServiceError extends Error {
  constructor(message, code = 'MFA_FAILED', statusCode = 400) {
    super(message);
    this.name = 'MfaServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function booleanEnv(name, fallback = false) {
  const value = String(process.env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function mfaConfig() {
  const provider = String(process.env.MFA_PROVIDER || 'iprog').trim().toLowerCase();
  const mockMode = booleanEnv('MFA_MOCK_MODE', false);
  const localSmsDisabled = booleanEnv('DISABLE_SMS_MFA_FOR_LOCAL_DEV', false);
  const iprog = getIprogConfig();
  return {
    enabled: booleanEnv('MFA_ENABLED', false),
    provider,
    mockMode,
    localSmsDisabled,
    mockCode: String(process.env.MFA_MOCK_CODE || '').trim(),
    showMockCode: booleanEnv('MFA_SHOW_MOCK_CODE', false),
    codeLength: 6,
    pinValidity: iprog.expiresInMinutes * 60,
    messageTemplate: iprog.message,
  };
}

function isMfaEnabled() {
  return mfaConfig().enabled;
}

function requestIp(req) {
  return req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || req?.ip
    || req?.socket?.remoteAddress
    || null;
}

function requestUserAgent(req) {
  return typeof req?.get === 'function'
    ? req.get('user-agent') || null
    : req?.headers?.['user-agent'] || null;
}

async function auditMfa(employeeId, actionType, description, req) {
  try {
    await createAuditLog({
      Employee_ID: employeeId,
      Action_Type: actionType,
      Description: description,
      IP_Address: requestIp(req),
      User_Agent: requestUserAgent(req),
    });
  } catch (error) {
    console.error('[mfaService] audit log failed:', error.message);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function matchesHash(rawValue, expectedHash) {
  if (!rawValue || !expectedHash) return false;
  const actual = Buffer.from(sha256(rawValue), 'hex');
  const expected = Buffer.from(String(expectedHash), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function matchesSecret(left, right) {
  const leftValue = Buffer.from(String(left || ''));
  const rightValue = Buffer.from(String(right || ''));
  return leftValue.length === rightValue.length && crypto.timingSafeEqual(leftValue, rightValue);
}

function normalizeChallengeId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new MfaServiceError('Invalid MFA challenge.', 'MFA_CHALLENGE_INVALID', 400);
  }
  return id;
}

async function hasMfaColumn(columnName) {
  const [rows] = await pool.execute(
    `SELECT 1
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'MFA_CHALLENGE'
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [columnName]
  );
  return rows.length > 0;
}

async function ensureMfaColumn(columnName, definition) {
  if (await hasMfaColumn(columnName)) return;
  await pool.execute(`ALTER TABLE MFA_CHALLENGE ADD COLUMN ${columnName} ${definition}`);
}

async function ensureMfaIndex(indexName, sql) {
  const [rows] = await pool.execute(
    `SELECT 1
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'MFA_CHALLENGE'
        AND INDEX_NAME = ?
      LIMIT 1`,
    [indexName]
  );
  if (!rows.length) await pool.execute(sql);
}

async function ensureMfaChallengeSchema() {
  if (mfaSchemaReady) return;
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS MFA_CHALLENGE (
      Challenge_ID BIGINT PRIMARY KEY AUTO_INCREMENT,
      Employee_ID BIGINT NOT NULL,
      Provider VARCHAR(50) NOT NULL DEFAULT 'iprog',
      Phone_Number VARCHAR(20) NULL,
      Phone_Number_Encrypted TEXT NULL,
      Phone_Number_Hash CHAR(64) NULL,
      Challenge_Token_Hash CHAR(64) NOT NULL,
      Status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      Attempt_Count INT NOT NULL DEFAULT 0,
      Resend_Count INT NOT NULL DEFAULT 0,
      Last_Sent_At DATETIME NULL,
      Expires_At DATETIME NOT NULL,
      Verified_At DATETIME NULL,
      Created_At DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      Updated_At DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await ensureMfaColumn('Phone_Number', 'VARCHAR(20) NULL AFTER Provider');
  await ensureMfaColumn('Phone_Number_Encrypted', 'TEXT NULL AFTER Phone_Number');
  await ensureMfaColumn('Phone_Number_Hash', 'CHAR(64) NULL AFTER Phone_Number_Encrypted');
  await ensureMfaColumn('Challenge_Token_Hash', 'CHAR(64) NOT NULL AFTER Phone_Number_Hash');
  await ensureMfaColumn('Attempt_Count', 'INT NOT NULL DEFAULT 0 AFTER Status');
  await ensureMfaColumn('Resend_Count', 'INT NOT NULL DEFAULT 0 AFTER Attempt_Count');
  await ensureMfaColumn('Last_Sent_At', 'DATETIME NULL AFTER Resend_Count');
  await ensureMfaColumn('Expires_At', 'DATETIME NOT NULL AFTER Last_Sent_At');
  await ensureMfaColumn('Verified_At', 'DATETIME NULL AFTER Expires_At');
  await ensureMfaColumn('Created_At', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER Verified_At');
  await ensureMfaColumn('Updated_At', 'DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER Created_At');
  await ensureMfaIndex('idx_mfa_challenge_employee_status', 'CREATE INDEX idx_mfa_challenge_employee_status ON MFA_CHALLENGE (Employee_ID, Status)');
  await ensureMfaIndex('idx_mfa_challenge_expires', 'CREATE INDEX idx_mfa_challenge_expires ON MFA_CHALLENGE (Expires_At)');
  await ensureMfaIndex('idx_mfa_challenge_phone_hash', 'CREATE INDEX idx_mfa_challenge_phone_hash ON MFA_CHALLENGE (Phone_Number_Hash)');
  mfaSchemaReady = true;
}

function assertMfaConfiguration(config) {
  if (config.provider !== 'iprog') {
    throw new MfaServiceError('MFA provider is not configured.', 'MFA_PROVIDER_UNSUPPORTED', 503);
  }
  if (config.mockMode && process.env.NODE_ENV === 'production') {
    throw new MfaServiceError('MFA mock mode cannot be used in production.', 'MFA_MOCK_MODE_FORBIDDEN', 503);
  }
  if (config.localSmsDisabled && process.env.NODE_ENV === 'production') {
    throw new MfaServiceError('Local MFA SMS bypass cannot be used in production.', 'MFA_LOCAL_SMS_DISABLED_FORBIDDEN', 503);
  }
  if (config.localSmsDisabled && !config.mockMode) {
    throw new MfaServiceError('Local MFA SMS bypass requires MFA mock mode.', 'MFA_LOCAL_SMS_DISABLED_INVALID', 503);
  }
  if (config.mockMode && !new RegExp(`^\\d{${config.codeLength}}$`).test(config.mockCode)) {
    throw new MfaServiceError('MFA mock mode is not configured.', 'MFA_MOCK_CODE_INVALID', 503);
  }
}

async function getEmployeePhone(employeeId) {
  const [rows] = await pool.execute(
    'SELECT contact_number FROM employees WHERE Employee_ID = ? OR id = ? LIMIT 1',
    [employeeId, employeeId]
  );
  return normalizePhilippineMobileNumber(decryptColumnValue(rows[0]?.contact_number));
}

async function sendVerification(phoneNumber, config) {
  if (config.mockMode) {
    if (config.localSmsDisabled) {
      console.warn('[MFA] Local development mock mode is active; SMS delivery was skipped.');
      return { mock: true, localOnly: true, mockCode: config.mockCode };
    }
    const message = config.messageTemplate.includes(':otp')
      ? config.messageTemplate.replace(/:otp/g, config.mockCode)
      : `${config.messageTemplate} ${config.mockCode}`.trim();
    await sendSms(phoneNumber, message);
    console.warn('[MFA] Mock mode is active; fake OTP was sent by SMS.');
    return { mock: true, mockCode: config.mockCode };
  }
  await sendOtp(phoneNumber);
  return { mock: false };
}

async function findChallenge(challengeId) {
  await ensureMfaChallengeSchema();
  const [rows] = await pool.execute(
    `SELECT Challenge_ID, Employee_ID, Provider, Phone_Number_Encrypted, Challenge_Token_Hash,
            Status, Attempt_Count, Resend_Count, Last_Sent_At, Expires_At
       FROM MFA_CHALLENGE
      WHERE Challenge_ID = ?
      LIMIT 1`,
    [challengeId]
  );
  const challenge = rows[0] || null;
  if (challenge) {
    challenge.Phone_Number = decryptColumnValue(challenge.Phone_Number_Encrypted);
    delete challenge.Phone_Number_Encrypted;
  }
  return challenge;
}

async function expireChallenge(challenge, req) {
  const [result] = await pool.execute(
    "UPDATE MFA_CHALLENGE SET Status = 'EXPIRED' WHERE Challenge_ID = ? AND Status = 'PENDING'",
    [challenge.Challenge_ID]
  );
  if (result.affectedRows) {
    await auditMfa(challenge.Employee_ID, 'MFA_CHALLENGE_EXPIRED', 'MFA challenge expired before verification.', req);
  }
}

function assertPendingChallenge(challenge, mfaToken, req) {
  if (!challenge || !matchesHash(mfaToken, challenge.Challenge_Token_Hash)) {
    throw new MfaServiceError('Invalid MFA challenge.', 'MFA_CHALLENGE_INVALID', 401);
  }
  if (challenge.Status !== 'PENDING') {
    throw new MfaServiceError('MFA challenge is no longer available.', 'MFA_CHALLENGE_UNAVAILABLE', 409);
  }
  if (new Date(challenge.Expires_At) <= new Date()) {
    return expireChallenge(challenge, req).then(() => {
      throw new MfaServiceError('MFA code expired. Please sign in again.', 'MFA_CHALLENGE_EXPIRED', 410);
    });
  }
  return null;
}

async function createMfaChallenge({ employeeId, req }) {
  const config = mfaConfig();
  assertMfaConfiguration(config);
  await ensureMfaChallengeSchema();
  const phoneNumber = await getEmployeePhone(employeeId);
  if (!phoneNumber) {
    await auditMfa(employeeId, 'MFA_PHONE_UNAVAILABLE', 'MFA challenge was not created because no valid mobile number is registered.', req);
    throw new MfaServiceError('No valid phone number is registered for this account. Please contact the System Administrator.', 'MFA_PHONE_UNAVAILABLE', 400);
  }

  const challengeToken = crypto.randomBytes(32).toString('base64url');
  const configProvider = config.provider;
  // A new successful password step invalidates any earlier pending code for
  // this account, so only the most recent MFA challenge can complete login.
  await pool.execute(
    "UPDATE MFA_CHALLENGE SET Status = 'SUPERSEDED' WHERE Employee_ID = ? AND Status = 'PENDING'",
    [employeeId]
  );
  const [created] = await pool.execute(
    `INSERT INTO MFA_CHALLENGE
      (Employee_ID, Provider, Phone_Number, Phone_Number_Encrypted, Phone_Number_Hash, Challenge_Token_Hash, Status, Expires_At)
     VALUES (?, ?, NULL, ?, ?, ?, 'PENDING', DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [employeeId, configProvider, encryptColumnValue(phoneNumber), hashNullable(phoneNumber), sha256(challengeToken), config.pinValidity]
  );
  const challengeId = created.insertId;
  await auditMfa(employeeId, 'MFA_CHALLENGE_CREATED', `MFA challenge ${challengeId} created.`, req);

  let delivery;
  try {
    delivery = await sendVerification(phoneNumber, config);
    await pool.execute(
      `UPDATE MFA_CHALLENGE
          SET Last_Sent_At = NOW()
        WHERE Challenge_ID = ? AND Status = 'PENDING'`,
      [challengeId]
    );
    await auditMfa(
      employeeId,
      delivery.mock ? 'MFA_MOCK_MODE_USED' : 'IPROG_OTP_SENT',
      delivery.localOnly
        ? 'MFA local development challenge created; SMS delivery skipped.'
        : delivery.mock
          ? 'MFA mock challenge created; fake OTP SMS request accepted.'
          : 'IPROG OTP request accepted.',
      req
    );
  } catch (error) {
    await pool.execute("UPDATE MFA_CHALLENGE SET Status = 'FAILED' WHERE Challenge_ID = ?", [challengeId]);
    await auditMfa(employeeId, 'IPROG_OTP_FAILED', 'IPROG OTP could not be requested.', req);
    if (error instanceof MfaServiceError) throw error;
    throw new MfaServiceError('Failed to send MFA code. Please try again.', 'MFA_SMS_FAILED', 503);
  }

  return {
    challengeId: String(challengeId),
    mfaToken: challengeToken,
    maskedPhoneNumber: maskPhoneNumber(phoneNumber),
    codeLength: config.codeLength,
    expiresIn: config.pinValidity,
    mockCode: delivery?.mock && config.showMockCode ? delivery.mockCode : null,
  };
}

async function verifyMfaChallenge({ challengeId: rawChallengeId, mfaToken, code, req }) {
  const challengeId = normalizeChallengeId(rawChallengeId);
  const config = mfaConfig();
  assertMfaConfiguration(config);
  if (!new RegExp(`^\\d{${config.codeLength}}$`).test(String(code || ''))) {
    throw new MfaServiceError('Invalid verification code.', 'MFA_CODE_INVALID', 400);
  }

  const challenge = await findChallenge(challengeId);
  await assertPendingChallenge(challenge, mfaToken, req);
  const challengePhoneNumber = normalizePhilippineMobileNumber(challenge.Phone_Number);
  if (!challengePhoneNumber) {
    await auditMfa(challenge.Employee_ID, 'MFA_PHONE_UNAVAILABLE', 'MFA verification was blocked because the challenge has no valid mobile number.', req);
    throw new MfaServiceError('No valid phone number is registered for this account. Please contact the System Administrator.', 'MFA_PHONE_UNAVAILABLE', 400);
  }

  let providerVerified;
  try {
    providerVerified = config.mockMode
      ? matchesSecret(code, config.mockCode)
      : await verifyOtp(challengePhoneNumber, code);
  } catch (error) {
    await auditMfa(challenge.Employee_ID, 'MFA_VERIFICATION_PROVIDER_FAILED', 'MFA provider verification could not be completed.', req);
    throw new MfaServiceError('Failed to verify MFA code. Please try again.', 'MFA_PROVIDER_VERIFY_FAILED', 503);
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT Challenge_ID, Employee_ID, Challenge_Token_Hash, Status, Attempt_Count, Expires_At
         FROM MFA_CHALLENGE
        WHERE Challenge_ID = ?
        FOR UPDATE`,
      [challengeId]
    );
    const current = rows[0];
    if (!current || !matchesHash(mfaToken, current.Challenge_Token_Hash)) {
      await connection.rollback();
      throw new MfaServiceError('Invalid MFA challenge.', 'MFA_CHALLENGE_INVALID', 401);
    }
    if (current.Status !== 'PENDING') {
      await connection.rollback();
      throw new MfaServiceError('MFA challenge is no longer available.', 'MFA_CHALLENGE_UNAVAILABLE', 409);
    }
    if (new Date(current.Expires_At) <= new Date()) {
      await connection.execute("UPDATE MFA_CHALLENGE SET Status = 'EXPIRED' WHERE Challenge_ID = ?", [challengeId]);
      await connection.commit();
      await auditMfa(current.Employee_ID, 'MFA_CHALLENGE_EXPIRED', 'MFA challenge expired before verification.', req);
      throw new MfaServiceError('MFA code expired. Please sign in again.', 'MFA_CHALLENGE_EXPIRED', 410);
    }

    if (providerVerified) {
      await connection.execute(
        "UPDATE MFA_CHALLENGE SET Status = 'VERIFIED', Verified_At = NOW() WHERE Challenge_ID = ?",
        [challengeId]
      );
      await connection.commit();
      await auditMfa(current.Employee_ID, 'MFA_VERIFICATION_SUCCESS', 'MFA verification completed successfully.', req);
      return { employeeId: current.Employee_ID };
    }

    const attempts = Number(current.Attempt_Count || 0) + 1;
    const exhausted = attempts >= MAX_MFA_ATTEMPTS;
    await connection.execute(
      'UPDATE MFA_CHALLENGE SET Attempt_Count = ?, Status = ? WHERE Challenge_ID = ?',
      [attempts, exhausted ? 'FAILED' : 'PENDING', challengeId]
    );
    await connection.commit();
    await auditMfa(current.Employee_ID, exhausted ? 'MFA_TOO_MANY_ATTEMPTS' : 'MFA_VERIFICATION_FAILED', exhausted
      ? 'MFA challenge failed after the maximum number of verification attempts.'
      : 'MFA verification code was invalid.', req);
    throw new MfaServiceError(
      exhausted ? 'Too many verification attempts. Please sign in again.' : 'Invalid verification code.',
      exhausted ? 'MFA_TOO_MANY_ATTEMPTS' : 'MFA_CODE_INVALID',
      exhausted ? 429 : 401
    );
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

async function resendMfaChallenge({ challengeId: rawChallengeId, mfaToken, req }) {
  const challengeId = normalizeChallengeId(rawChallengeId);
  const config = mfaConfig();
  assertMfaConfiguration(config);
  const challenge = await findChallenge(challengeId);
  await assertPendingChallenge(challenge, mfaToken, req);

  const lastSentAt = challenge.Last_Sent_At ? new Date(challenge.Last_Sent_At) : null;
  const elapsedSeconds = lastSentAt ? Math.floor((Date.now() - lastSentAt.getTime()) / 1000) : RESEND_COOLDOWN_SECONDS;
  if (elapsedSeconds < RESEND_COOLDOWN_SECONDS) {
    throw new MfaServiceError('Please wait before requesting another MFA code.', 'MFA_RESEND_COOLDOWN', 429);
  }

  const phoneNumber = normalizePhilippineMobileNumber(challenge.Phone_Number);
  if (!phoneNumber) {
    await auditMfa(challenge.Employee_ID, 'MFA_PHONE_UNAVAILABLE', 'MFA resend was blocked because the challenge has no valid mobile number.', req);
    throw new MfaServiceError('No valid phone number is registered for this account. Please contact the System Administrator.', 'MFA_PHONE_UNAVAILABLE', 400);
  }

  let delivery;
  try {
    delivery = await sendVerification(phoneNumber, config);
  } catch (error) {
    await auditMfa(challenge.Employee_ID, 'IPROG_OTP_FAILED', 'IPROG OTP resend could not be requested.', req);
    throw new MfaServiceError('Failed to send MFA code. Please try again.', 'MFA_SMS_FAILED', 503);
  }

  const [result] = await pool.execute(
    `UPDATE MFA_CHALLENGE
        SET Last_Sent_At = NOW(),
            Resend_Count = Resend_Count + 1,
            Expires_At = DATE_ADD(NOW(), INTERVAL ? SECOND)
      WHERE Challenge_ID = ?
        AND Status = 'PENDING'`,
    [config.pinValidity, challengeId]
  );
  if (!result.affectedRows) {
    throw new MfaServiceError('MFA challenge is no longer available.', 'MFA_CHALLENGE_UNAVAILABLE', 409);
  }
  await auditMfa(
    challenge.Employee_ID,
    delivery.mock ? 'MFA_MOCK_MODE_USED' : 'IPROG_OTP_SENT',
    delivery.localOnly
      ? 'MFA local development challenge resent; SMS delivery skipped.'
      : delivery.mock
        ? 'MFA mock challenge resent; fake OTP SMS request accepted.'
        : 'IPROG OTP resend request accepted.',
    req
  );

  return {
    maskedPhoneNumber: maskPhoneNumber(phoneNumber),
    codeLength: config.codeLength,
    expiresIn: config.pinValidity,
    resendCooldown: RESEND_COOLDOWN_SECONDS,
    mockCode: delivery?.mock && config.showMockCode ? delivery.mockCode : null,
  };
}

module.exports = {
  MfaServiceError,
  createMfaChallenge,
  isMfaEnabled,
  resendMfaChallenge,
  verifyMfaChallenge,
};
