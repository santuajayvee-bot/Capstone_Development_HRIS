const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const DEFAULT_ACCESS_EXPIRES_IN = '15m';
const DEFAULT_REFRESH_TOKEN_EXPIRES_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getAccessSecret() {
  if (!isNonEmptyString(process.env.JWT_ACCESS_SECRET)) {
    throw new Error('JWT access secret is not configured.');
  }

  return process.env.JWT_ACCESS_SECRET;
}

function getAccessExpiresIn() {
  return process.env.JWT_ACCESS_EXPIRES_IN || DEFAULT_ACCESS_EXPIRES_IN;
}

function getRefreshTokenExpiresDays() {
  const configuredDays = Number.parseInt(process.env.REFRESH_TOKEN_EXPIRES_DAYS, 10);

  if (!Number.isFinite(configuredDays) || configuredDays <= 0) {
    return DEFAULT_REFRESH_TOKEN_EXPIRES_DAYS;
  }

  return configuredDays;
}

function getUserValue(user, preferredKey, fallbackKeys = []) {
  if (!user || typeof user !== 'object') return undefined;

  const keys = [preferredKey, ...fallbackKeys];
  for (const key of keys) {
    if (user[key] !== undefined && user[key] !== null) {
      return user[key];
    }
  }

  return undefined;
}

function generateJwtId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return crypto.randomBytes(32).toString('hex');
}

function generateAccessToken(user) {
  const employeeId = getUserValue(user, 'Employee_ID', ['employee_id']);

  if (employeeId === undefined || employeeId === null || employeeId === '') {
    throw new Error('Invalid user payload.');
  }

  const jwtId = generateJwtId();
  const expiresIn = getAccessExpiresIn();
  const payload = {
    sub: String(employeeId),
    roleId: getUserValue(user, 'Role_ID', ['role_id']),
    accessLevel: getUserValue(user, 'Access_Level', ['access_level']),
    email: getUserValue(user, 'Email', ['email']),
    jti: jwtId,
  };

  // Access tokens are intentionally short-lived to reduce the blast radius if
  // a token is exposed. Revocation is tracked through the jti/session record.
  const token = jwt.sign(payload, getAccessSecret(), {
    algorithm: 'HS256',
    expiresIn,
  });

  return {
    token,
    jwtId,
    expiresIn,
  };
}

function verifyAccessToken(token) {
  if (!isNonEmptyString(token)) {
    return null;
  }

  try {
    return jwt.verify(token, getAccessSecret(), {
      algorithms: ['HS256'],
    });
  } catch (error) {
    return null;
  }
}

function generateRefreshToken() {
  // Refresh tokens are opaque random values instead of JWTs so they carry no
  // readable claims and can be revoked using the server-side session record.
  return crypto.randomBytes(64).toString('hex');
}

function hashRefreshToken(refreshToken) {
  if (!isNonEmptyString(refreshToken)) {
    throw new Error('Refresh token is required.');
  }

  // Only this digest should be stored in USER_SESSION.Refresh_Token_Hash.
  // Storing a hash prevents database reads from exposing usable refresh tokens.
  return crypto.createHash('sha256').update(refreshToken).digest('hex');
}

function getRefreshTokenExpiryDate() {
  return new Date(Date.now() + getRefreshTokenExpiresDays() * MS_PER_DAY);
}

function getRefreshCookieOptions() {
  const maxAge = getRefreshTokenExpiresDays() * MS_PER_DAY;

  // HttpOnly cookies keep browser JavaScript from reading the refresh token,
  // which helps reduce token theft if an XSS bug is ever introduced.
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/auth',
    maxAge,
  };
}

module.exports = {
  generateJwtId,
  generateAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  getRefreshTokenExpiryDate,
  getRefreshCookieOptions,
};
