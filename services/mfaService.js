const crypto = require('crypto');
const QRCode = require('qrcode');
const pool = require('../config/db');
const { decryptColumnValue, encryptColumnValue, hashNullable } = require('../server/data-protection');
const { createAuditLog } = require('../db/authQueries');

const MAX_MFA_ATTEMPTS = 5;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_SECRET_BYTES = 20;
const TOTP_ISSUER = 'LGSV HR';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PRIVILEGED_ROLES = new Set([
  'system_admin',
  'admin',
  'payroll_manager',
  'payroll_officer',
  'hr_admin',
  'hr_manager',
  'manager',
]);

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
  const configuredValidity = Number(process.env.MFA_CHALLENGE_TTL_SECONDS || 300);
  const configuredWindow = Number(process.env.MFA_TOTP_WINDOW_STEPS || 1);
  return {
    enabled: booleanEnv('MFA_ENABLED', false),
    requireAllUsers: booleanEnv('MFA_REQUIRE_ALL_USERS', false),
    codeLength: 6,
    challengeTtl: Number.isFinite(configuredValidity) && configuredValidity >= 120 && configuredValidity <= 900
      ? configuredValidity
      : 300,
    totpWindow: Number.isFinite(configuredWindow) && configuredWindow >= 0 && configuredWindow <= 2
      ? configuredWindow
      : 1,
    issuer: String(process.env.MFA_TOTP_ISSUER || TOTP_ISSUER).trim() || TOTP_ISSUER,
  };
}

function isMfaEnabled() {
  return mfaConfig().enabled;
}

function isMfaRequiredForRole(roleName) {
  const normalized = String(roleName || '').trim().toLowerCase();
  const config = mfaConfig();
  return PRIVILEGED_ROLES.has(normalized) || (config.enabled && config.requireAllUsers);
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

function normalizeChallengeId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new MfaServiceError('Invalid MFA challenge.', 'MFA_CHALLENGE_INVALID', 400);
  }
  return id;
}

function assertMfaConfiguration(config) {
  if (!config.enabled) {
    throw new MfaServiceError('MFA is required but is not configured.', 'MFA_DISABLED', 503);
  }
}

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(secret) {
  const normalized = String(secret || '').toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new MfaServiceError('Invalid MFA secret.', 'MFA_SECRET_INVALID', 500);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(TOTP_SECRET_BYTES));
}

function counterBuffer(counter) {
  const buffer = Buffer.alloc(8);
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  buffer.writeUInt32BE(high, 0);
  buffer.writeUInt32BE(low, 4);
  return buffer;
}

function generateTotpCode(secret, timestamp = Date.now(), periodSeconds = TOTP_PERIOD_SECONDS, digits = 6) {
  const key = base32Decode(secret);
  const counter = Math.floor(timestamp / 1000 / periodSeconds);
  const hmac = crypto.createHmac('sha1', key).update(counterBuffer(counter)).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function timingSafeCodeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyTotpCode(secret, code, options = {}) {
  const normalized = String(code || '').trim();
  const digits = Number(options.digits || 6);
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return false;
  const windowSteps = Number(options.windowSteps || 0);
  const now = Number(options.timestamp || Date.now());
  for (let step = -windowSteps; step <= windowSteps; step += 1) {
    const timestamp = now + (step * TOTP_PERIOD_SECONDS * 1000);
    if (timingSafeCodeEqual(generateTotpCode(secret, timestamp, TOTP_PERIOD_SECONDS, digits), normalized)) {
      return true;
    }
  }
  return false;
}

function otpauthUrl({ secret, accountName, issuer }) {
  const label = `${issuer}:${accountName || 'lgsv-user'}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

async function getEmployeeMfaProfile(employeeId, executor = pool) {
  const [rows] = await executor.execute(
    `SELECT Employee_ID, MFA_TOTP_Secret_Encrypted, MFA_TOTP_Secret_Hash, MFA_TOTP_Enrolled_At
       FROM employees
      WHERE Employee_ID = ?
      LIMIT 1`,
    [employeeId]
  );
  const row = rows[0] || null;
  if (!row) return null;
  return {
    employeeId: row.Employee_ID,
    secret: decryptColumnValue(row.MFA_TOTP_Secret_Encrypted),
    secretHash: row.MFA_TOTP_Secret_Hash || null,
    enrolledAt: row.MFA_TOTP_Enrolled_At || null,
  };
}

async function ensureEmployeeTotpSecret(employeeId, req) {
  const profile = await getEmployeeMfaProfile(employeeId);
  if (!profile) {
    throw new MfaServiceError('MFA account is not fully configured. Please contact the System Administrator.', 'MFA_ACCOUNT_NOT_FOUND', 400);
  }
  if (profile.secret) return { secret: profile.secret, enrollmentRequired: !profile.enrolledAt };

  const secret = generateTotpSecret();
  await pool.execute(
    `UPDATE employees
        SET MFA_TOTP_Secret_Encrypted = ?,
            MFA_TOTP_Secret_Hash = ?,
            MFA_TOTP_Enrolled_At = NULL
      WHERE Employee_ID = ?`,
    [encryptColumnValue(secret), hashNullable(secret), employeeId]
  );
  await auditMfa(employeeId, 'MFA_TOTP_ENROLLMENT_STARTED', 'TOTP MFA enrollment was started for this account.', req);
  return { secret, enrollmentRequired: true };
}

async function findChallenge(challengeId) {
  const [rows] = await pool.execute(
    `SELECT Challenge_ID, Employee_ID, Provider, Challenge_Token_Hash,
            Status, Attempt_Count, Expires_At
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
    await auditMfa(challenge.Employee_ID, 'MFA_CHALLENGE_EXPIRED', 'TOTP MFA challenge expired before verification.', req);
  }
}

function assertPendingChallenge(challenge, mfaToken, req) {
  if (!challenge || !matchesHash(mfaToken, challenge.Challenge_Token_Hash) || challenge.Provider !== 'totp') {
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

async function createMfaChallenge({ employeeId, accountName, req }) {
  const config = mfaConfig();
  assertMfaConfiguration(config);
  const { secret, enrollmentRequired } = await ensureEmployeeTotpSecret(employeeId, req);
  const challengeToken = crypto.randomBytes(32).toString('base64url');

  await pool.execute(
    "UPDATE MFA_CHALLENGE SET Status = 'SUPERSEDED' WHERE Employee_ID = ? AND Status = 'PENDING'",
    [employeeId]
  );
  const [created] = await pool.execute(
    `INSERT INTO MFA_CHALLENGE
      (Employee_ID, Provider, Challenge_Token_Hash, Status, Expires_At)
     VALUES (?, 'totp', ?, 'PENDING', DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [employeeId, sha256(challengeToken), config.challengeTtl]
  );

  const challengeId = created.insertId;
  await auditMfa(employeeId, 'MFA_CHALLENGE_CREATED', `TOTP MFA challenge ${challengeId} created.`, req);

  const response = {
    challengeId: String(challengeId),
    mfaToken: challengeToken,
    codeLength: config.codeLength,
    expiresIn: config.challengeTtl,
    enrollmentRequired,
    method: 'totp',
  };

  if (enrollmentRequired) {
    const url = otpauthUrl({ secret, accountName, issuer: config.issuer });
    response.qrCodeDataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 192,
    });
    response.manualEntryKey = secret.replace(/(.{4})/g, '$1 ').trim();
    response.issuer = config.issuer;
    response.accountName = accountName || 'lgsv-user';
  }

  return response;
}

async function verifyMfaChallenge({ challengeId: rawChallengeId, mfaToken, code, req }) {
  const challengeId = normalizeChallengeId(rawChallengeId);
  const config = mfaConfig();
  assertMfaConfiguration(config);
  if (!new RegExp(`^\\d{${config.codeLength}}$`).test(String(code || '').trim())) {
    throw new MfaServiceError('Invalid verification code.', 'MFA_CODE_INVALID', 400);
  }

  const challenge = await findChallenge(challengeId);
  await assertPendingChallenge(challenge, mfaToken, req);

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT c.Challenge_ID, c.Employee_ID, c.Provider, c.Challenge_Token_Hash,
              c.Status, c.Attempt_Count, c.Expires_At,
              e.MFA_TOTP_Secret_Encrypted, e.MFA_TOTP_Enrolled_At
         FROM MFA_CHALLENGE c
         JOIN employees e ON e.Employee_ID = c.Employee_ID
        WHERE c.Challenge_ID = ?
        FOR UPDATE`,
      [challengeId]
    );
    const current = rows[0];
    if (!current || current.Provider !== 'totp' || !matchesHash(mfaToken, current.Challenge_Token_Hash)) {
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
      await auditMfa(current.Employee_ID, 'MFA_CHALLENGE_EXPIRED', 'TOTP MFA challenge expired before verification.', req);
      throw new MfaServiceError('MFA code expired. Please sign in again.', 'MFA_CHALLENGE_EXPIRED', 410);
    }

    const secret = decryptColumnValue(current.MFA_TOTP_Secret_Encrypted);
    if (!secret) {
      await connection.rollback();
      throw new MfaServiceError('MFA is not enrolled for this account.', 'MFA_TOTP_NOT_ENROLLED', 400);
    }

    const providerVerified = verifyTotpCode(secret, code, {
      digits: config.codeLength,
      windowSteps: config.totpWindow,
    });
    if (providerVerified) {
      await connection.execute(
        "UPDATE MFA_CHALLENGE SET Status = 'VERIFIED', Verified_At = NOW() WHERE Challenge_ID = ?",
        [challengeId]
      );
      if (!current.MFA_TOTP_Enrolled_At) {
        await connection.execute(
          'UPDATE employees SET MFA_TOTP_Enrolled_At = NOW() WHERE Employee_ID = ?',
          [current.Employee_ID]
        );
      }
      await connection.commit();
      await auditMfa(
        current.Employee_ID,
        current.MFA_TOTP_Enrolled_At ? 'MFA_VERIFICATION_SUCCESS' : 'MFA_TOTP_ENROLLMENT_COMPLETED',
        current.MFA_TOTP_Enrolled_At
          ? 'TOTP MFA verification completed successfully.'
          : 'TOTP MFA enrollment was completed successfully.',
        req
      );
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
      ? 'TOTP MFA challenge failed after the maximum number of verification attempts.'
      : 'TOTP verification code was invalid.', req);
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

async function resendMfaChallenge() {
  throw new MfaServiceError('Authenticator app codes refresh automatically every 30 seconds.', 'MFA_RESEND_UNSUPPORTED', 410);
}

module.exports = {
  MfaServiceError,
  createMfaChallenge,
  isMfaEnabled,
  isMfaRequiredForRole,
  resendMfaChallenge,
  verifyMfaChallenge,
  _base32DecodeForTest: base32Decode,
  _base32EncodeForTest: base32Encode,
  _generateTotpCodeForTest: generateTotpCode,
  _generateTotpSecretForTest: generateTotpSecret,
  _getEmployeeMfaProfileForTest: getEmployeeMfaProfile,
  _verifyTotpCodeForTest: verifyTotpCode,
};
