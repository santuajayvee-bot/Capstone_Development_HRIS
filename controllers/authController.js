const { verifyPassword } = require('../services/passwordService');
const {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  getRefreshTokenExpiryDate,
  getRefreshCookieOptions,
} = require('../services/tokenService');
const {
  findUserByEmail,
  incrementFailedLoginAttempts,
  resetFailedLoginAttempts,
  lockUserAccount,
  updateLastLogin,
  createUserSession,
  createAuditLog,
} = require('../db/authQueries');

const INVALID_LOGIN_MESSAGE = 'Invalid email or password.';
const LOCKED_ACCOUNT_MESSAGE = 'Account temporarily locked. Please try again later.';
const UNEXPECTED_LOGIN_MESSAGE = 'Unable to process login request.';
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const REFRESH_COOKIE_NAME = 'refreshToken';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getRequestIp(req) {
  return req.ip || req.connection?.remoteAddress || null;
}

function getUserAgent(req) {
  if (typeof req.get === 'function') {
    return req.get('user-agent') || null;
  }

  return req.headers?.['user-agent'] || null;
}

function isFutureDate(value) {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date > new Date();
}

function isInactiveUser(user) {
  if (user?.is_active === 0 || user?.is_active === false) return true;
  if (!isNonEmptyString(user?.account_status)) return false;
  return user.account_status.trim().toLowerCase() !== 'active';
}

function getAuthEmployeeId(user) {
  return user?.Employee_ID || user?.employee_table_id || user?.id || null;
}

async function safeCreateAuditLog(logData) {
  try {
    await createAuditLog(logData);
  } catch (error) {
    console.error('[authController] audit log failed:', error.message);
  }
}

function invalidLoginResponse(res) {
  return res.status(401).json({
    success: false,
    message: INVALID_LOGIN_MESSAGE,
  });
}

async function login(req, res) {
  const loginIdentifier = req.body?.email || req.body?.username;
  const password = req.body?.password;
  const ipAddress = getRequestIp(req);
  const userAgent = getUserAgent(req);

  if (!isNonEmptyString(loginIdentifier) || !isNonEmptyString(password)) {
    return invalidLoginResponse(res);
  }

  const normalizedLoginIdentifier = loginIdentifier.trim().toLowerCase();

  try {
    const user = await findUserByEmail(normalizedLoginIdentifier);

    if (!user || isInactiveUser(user)) {
      await safeCreateAuditLog({
        Employee_ID: getAuthEmployeeId(user),
        Action_Type: 'LOGIN_FAILED',
        Description: 'Login failed with invalid credentials.',
        IP_Address: ipAddress,
        User_Agent: userAgent,
      });

      return invalidLoginResponse(res);
    }

    const employeeId = getAuthEmployeeId(user);

    if (isFutureDate(user.Locked_Until)) {
      await safeCreateAuditLog({
        Employee_ID: employeeId,
        Action_Type: 'LOGIN_BLOCKED_LOCKED_ACCOUNT',
        Description: 'Login blocked because the account is temporarily locked.',
        IP_Address: ipAddress,
        User_Agent: userAgent,
      });

      return res.status(423).json({
        success: false,
        message: LOCKED_ACCOUNT_MESSAGE,
      });
    }

    const passwordMatches = await verifyPassword(user.Password_Hash, password);

    if (!passwordMatches) {
      const failedAttempts = await incrementFailedLoginAttempts(employeeId);

      if (Number(failedAttempts) >= MAX_FAILED_ATTEMPTS) {
        await lockUserAccount(employeeId, LOCK_MINUTES);
        await safeCreateAuditLog({
          Employee_ID: employeeId,
          Action_Type: 'ACCOUNT_LOCKED',
          Description: 'Account locked after repeated failed login attempts.',
          IP_Address: ipAddress,
          User_Agent: userAgent,
        });
      } else {
        await safeCreateAuditLog({
          Employee_ID: employeeId,
          Action_Type: 'LOGIN_FAILED',
          Description: 'Login failed with invalid credentials.',
          IP_Address: ipAddress,
          User_Agent: userAgent,
        });
      }

      return invalidLoginResponse(res);
    }

    await resetFailedLoginAttempts(employeeId);
    await updateLastLogin(employeeId);

    const { token: accessToken, jwtId } = generateAccessToken(user);
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const refreshTokenExpiresAt = getRefreshTokenExpiryDate();

    await createUserSession({
      Employee_ID: employeeId,
      Refresh_Token_Hash: refreshTokenHash,
      JWT_ID: jwtId,
      IP_Address: ipAddress,
      User_Agent: userAgent,
      Expires_At: refreshTokenExpiresAt,
    });

    res.cookie(REFRESH_COOKIE_NAME, refreshToken, getRefreshCookieOptions());

    await safeCreateAuditLog({
      Employee_ID: user.Employee_ID,
      Action_Type: 'LOGIN_SUCCESS',
      Description: 'User login successful.',
      IP_Address: ipAddress,
      User_Agent: userAgent,
    });

    return res.json({
      success: true,
      message: 'Login successful.',
      accessToken,
      user: {
        Employee_ID: user.Employee_ID,
        Email: user.Email,
        Role_ID: user.Role_ID,
        Access_Level: user.Access_Level,
      },
      mustChangePassword: !user.Password_Changed_At,
    });
  } catch (error) {
    console.error('[authController] login failed:', error.message);
    return res.status(500).json({
      success: false,
      message: UNEXPECTED_LOGIN_MESSAGE,
    });
  }
}

module.exports = {
  login,
};
