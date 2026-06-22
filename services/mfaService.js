const crypto = require('crypto');
const pool = require('../config/db');
const { createAuditLog } = require('../db/authQueries');
const {
  MoceanServiceError,
  checkSmsVerification,
  getMoceanConfig,
  requestSmsVerification,
} = require('./moceanService');

const MAX_MFA_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

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
  const provider = String(process.env.MFA_PROVIDER || 'mocean').trim().toLowerCase();
  const mockMode = booleanEnv('MFA_MOCK_MODE', false);
  const mocean = getMoceanConfig();
  return {
    enabled: booleanEnv('MFA_ENABLED', false),
    provider,
    mockMode,
    mockCode: String(process.env.MFA_MOCK_CODE || '').trim(),
    codeLength: mocean.codeLength,
    pinValidity: mocean.pinValidity,
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

function normalizePhilippinePhone(value) {
  let phone = String(value || '').trim().replace(/[\s().-]/g, '');
  if (phone.startsWith('+')) phone = phone.slice(1);
  if (phone.startsWith('00')) phone = phone.slice(2);
  if (/^09\d{9}$/.test(phone)) return `63${phone.slice(1)}`;
  if (/^9\d{9}$/.test(phone)) return `63${phone}`;
  if (/^639\d{9}$/.test(phone)) return phone;
  return null;
}

function maskPhoneNumber(phoneNumber) {
  return `+63 *** *** ${String(phoneNumber).slice(-4)}`;
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

function assertMfaConfiguration(config) {
  if (config.provider !== 'mocean') {
    throw new MfaServiceError('MFA provider is not configured.', 'MFA_PROVIDER_UNSUPPORTED', 503);
  }
  if (config.mockMode && process.env.NODE_ENV === 'production') {
    throw new MfaServiceError('MFA mock mode cannot be used in production.', 'MFA_MOCK_MODE_FORBIDDEN', 503);
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
  return normalizePhilippinePhone(rows[0]?.contact_number);
}

async function sendVerification(phoneNumber, config) {
  if (config.mockMode) {
    console.warn('[MFA] Mock mode is active; no SMS was sent.');
    return { providerRequestId: `mock-${crypto.randomUUID()}`, mock: true };
  }
  return requestSmsVerification(phoneNumber);
}

async function findChallenge(challengeId) {
  const [rows] = await pool.execute(
    `SELECT Challenge_ID, Employee_ID, Provider, Provider_Request_ID, Challenge_Token_Hash,
            Status, Attempt_Count, Resend_Count, Last_Sent_At, Expires_At
       FROM MFA_CHALLENGE
      WHERE Challenge_ID = ?
      LIMIT 1`,
    [challengeId]
  );
  return rows[0] || null;
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
  const phoneNumber = await getEmployeePhone(employeeId);
  if (!phoneNumber) {
    await auditMfa(employeeId, 'MFA_PHONE_UNAVAILABLE', 'MFA challenge was not created because no valid mobile number is registered.', req);
    throw new MfaServiceError('No valid mobile number is registered for this account.', 'MFA_PHONE_UNAVAILABLE', 400);
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
      (Employee_ID, Provider, Challenge_Token_Hash, Status, Expires_At)
     VALUES (?, ?, ?, 'PENDING', DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [employeeId, configProvider, sha256(challengeToken), config.pinValidity]
  );
  const challengeId = created.insertId;
  await auditMfa(employeeId, 'MFA_CHALLENGE_CREATED', `MFA challenge ${challengeId} created.`, req);

  try {
    const delivery = await sendVerification(phoneNumber, config);
    await pool.execute(
      `UPDATE MFA_CHALLENGE
          SET Provider_Request_ID = ?, Last_Sent_At = NOW()
        WHERE Challenge_ID = ? AND Status = 'PENDING'`,
      [delivery.providerRequestId, challengeId]
    );
    await auditMfa(
      employeeId,
      delivery.mock ? 'MFA_MOCK_MODE_USED' : 'MFA_SMS_SENT',
      delivery.mock ? 'MFA mock challenge created; no SMS was sent.' : 'MFA verification SMS sent.',
      req
    );
  } catch (error) {
    await pool.execute("UPDATE MFA_CHALLENGE SET Status = 'FAILED' WHERE Challenge_ID = ?", [challengeId]);
    await auditMfa(employeeId, 'MFA_SMS_FAILED', 'MFA verification SMS could not be sent.', req);
    if (error instanceof MfaServiceError) throw error;
    throw new MfaServiceError('Failed to send MFA code. Please try again.', 'MFA_SMS_FAILED', 503);
  }

  return {
    challengeId: String(challengeId),
    mfaToken: challengeToken,
    maskedPhoneNumber: maskPhoneNumber(phoneNumber),
    codeLength: config.codeLength,
    expiresIn: config.pinValidity,
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

  let providerVerified;
  try {
    providerVerified = config.mockMode
      ? matchesSecret(code, config.mockCode)
      : await checkSmsVerification(challenge.Provider_Request_ID, code);
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

  const phoneNumber = await getEmployeePhone(challenge.Employee_ID);
  if (!phoneNumber) {
    await auditMfa(challenge.Employee_ID, 'MFA_PHONE_UNAVAILABLE', 'MFA resend was blocked because no valid mobile number is registered.', req);
    throw new MfaServiceError('No valid mobile number is registered for this account.', 'MFA_PHONE_UNAVAILABLE', 400);
  }

  let delivery;
  try {
    delivery = await sendVerification(phoneNumber, config);
  } catch (error) {
    await auditMfa(challenge.Employee_ID, 'MFA_SMS_FAILED', 'MFA resend could not be sent.', req);
    throw new MfaServiceError('Failed to send MFA code. Please try again.', 'MFA_SMS_FAILED', 503);
  }

  const [result] = await pool.execute(
    `UPDATE MFA_CHALLENGE
        SET Provider_Request_ID = ?,
            Last_Sent_At = NOW(),
            Resend_Count = Resend_Count + 1,
            Expires_At = DATE_ADD(NOW(), INTERVAL ? SECOND)
      WHERE Challenge_ID = ?
        AND Status = 'PENDING'`,
    [delivery.providerRequestId, config.pinValidity, challengeId]
  );
  if (!result.affectedRows) {
    throw new MfaServiceError('MFA challenge is no longer available.', 'MFA_CHALLENGE_UNAVAILABLE', 409);
  }
  await auditMfa(
    challenge.Employee_ID,
    delivery.mock ? 'MFA_MOCK_MODE_USED' : 'MFA_SMS_SENT',
    delivery.mock ? 'MFA mock challenge resent; no SMS was sent.' : 'MFA verification SMS resent.',
    req
  );

  return {
    maskedPhoneNumber: maskPhoneNumber(phoneNumber),
    expiresIn: config.pinValidity,
    resendCooldown: RESEND_COOLDOWN_SECONDS,
  };
}

module.exports = {
  MfaServiceError,
  createMfaChallenge,
  isMfaEnabled,
  resendMfaChallenge,
  verifyMfaChallenge,
};
