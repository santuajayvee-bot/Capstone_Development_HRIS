const { verifyPassword } = require('../services/passwordService');
const {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  getRefreshTokenExpiryDate,
  getRefreshCookieOptions,
} = require('../services/tokenService');
const {
  findUserById,
  findUserByEmail,
  recordFailedLoginFailureForUser,
  getUserLoginLockState,
  resetFailedLoginAttempts,
  resetFailedLoginAttemptsForUser,
  updateLastLogin,
  createUserSession,
  createAuditLog,
  ensureEmployeeAuthIdentifier,
  revokeSessionByJwtId,
} = require('../db/authQueries');
const {
  getUserPermissions,
  getLinkedEmployeeProfile,
} = require('../server/users');
const {
  getCurrentDpaVersion,
  hasAcceptedCurrentDpa,
} = require('../server/dpa-service');
const {
  MfaServiceError,
  createMfaChallenge,
  isMfaRequiredForRole,
  resendMfaChallenge,
  verifyMfaChallenge,
} = require('../services/mfaService');
const {
  RecaptchaServiceError,
  publicRecaptchaConfig,
  verifyRecaptchaToken,
} = require('../services/recaptchaService');

const INVALID_LOGIN_MESSAGE = 'Invalid email or password.';
const LOCKED_ACCOUNT_MESSAGE = 'Account temporarily locked. Please try again later.';
const MISCONFIGURED_ACCOUNT_MESSAGE = 'Account is not fully configured. Please contact your administrator.';
const UNEXPECTED_LOGIN_MESSAGE = 'Unable to process login request.';
const MAX_FAILED_ATTEMPTS = positiveIntegerFromEnv('AUTH_MAX_FAILED_ATTEMPTS', 5, 20);
const LOCK_MINUTES = positiveIntegerFromEnv('AUTH_LOCKOUT_MINUTES', 15, 1440);
const REFRESH_COOKIE_NAME = 'refreshToken';

function positiveIntegerFromEnv(name, fallback, maximum) {
  const value = Number.parseInt(process.env[name], 10);
  if (!Number.isFinite(value) || value <= 0 || value > maximum) return fallback;
  return value;
}

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

function auditLoginIdentifier(identifier) {
  if (!isNonEmptyString(identifier)) return 'unavailable';
  const normalized = identifier.trim().toLowerCase();
  const [localPart, domain] = normalized.split('@');
  if (domain) {
    const visibleLocal = localPart.length <= 2
      ? `${localPart[0] || '*'}*`
      : `${localPart.slice(0, 2)}***${localPart.slice(-1)}`;
    return `${visibleLocal}@${domain}`;
  }
  return normalized.length <= 3
    ? `${normalized[0] || '*'}***`
    : `${normalized.slice(0, 2)}***${normalized.slice(-1)}`;
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
  return user?.Employee_ID || user?.employee_table_id || null;
}

function normalizeRoleName(roleName) {
  if (roleName === 'admin') return 'system_admin';
  if (roleName === 'manager') return 'hr_manager';
  return roleName || 'employee';
}

function getDefaultRoleLabel(roleName) {
  const labels = {
    system_admin: 'System Administrator (Level 4)',
    hr_admin: 'HR Admin (Level 2)',
    hr_manager: 'HR Manager (Level 2)',
    payroll_officer: 'Payroll Officer (Level 2)',
    payroll_manager: 'Payroll Manager (Level 3)',
    employee: 'Regular Employee (Level 1)',
  };
  return labels[roleName] || 'User';
}

async function buildAuthenticatedUser(user) {
  const role = normalizeRoleName(user.role_name);
  const employeeId = user.employee_table_id || user.Employee_ID;
  const permissions = await getUserPermissions(user.id, role);
  const employeeProfile = await getLinkedEmployeeProfile(employeeId);
  const dpaAccepted = await hasAcceptedCurrentDpa(user.id);

  return {
    id: user.id,
    username: user.username || user.Email,
    role,
    roleLabel: user.role_label || getDefaultRoleLabel(role),
    employeeId,
    Employee_ID: user.Employee_ID,
    email: user.Email,
    Role_ID: user.Role_ID,
    Access_Level: user.Access_Level,
    forcePasswordChange: Boolean(Number(user.force_password_change)),
    mustChangePassword: Boolean(Number(user.force_password_change)),
    tokenVersion: Number(user.token_version || 0),
    passwordChangedAt: user.Password_Changed_At || null,
    permissions,
    employeeProfile,
    dpaAccepted,
    dpaRequired: !dpaAccepted,
    dpaAgreementVersion: getCurrentDpaVersion(),
  };
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

function buildLockoutPayload(state = {}) {
  const remainingAttempts = Math.max(MAX_FAILED_ATTEMPTS - Number(state.attempts || 0), 0);
  return {
    success: false,
    message: LOCKED_ACCOUNT_MESSAGE,
    attempts: Number(state.attempts || 0),
    remaining_attempts: remainingAttempts,
    locked: Boolean(state.locked),
    locked_until: state.lockedUntil || null,
    lock_seconds_remaining: Number(state.lockSecondsRemaining || 0),
  };
}

function lockedAccountResponse(res, state = {}) {
  return res.status(423).json(buildLockoutPayload({ ...state, locked: true }));
}

function invalidLoginAttemptResponse(res, failure = {}) {
  const remainingAttempts = Math.max(MAX_FAILED_ATTEMPTS - Number(failure?.attempts || 0), 0);
  return res.status(401).json({
    success: false,
    message: INVALID_LOGIN_MESSAGE,
    attempts: Number(failure?.attempts || 0),
    remaining_attempts: remainingAttempts,
    locked: Boolean(failure?.locked),
    locked_until: failure?.lockedUntil || null,
    lock_seconds_remaining: Number(failure?.lockSecondsRemaining || 0),
  });
}

function mfaErrorResponse(res, error) {
  const knownMfaError = error instanceof MfaServiceError;
  const status = knownMfaError
    ? error.statusCode
    : Number(error?.statusCode || 503);
  return res.status(status || 400).json({
    success: false,
    mfaRequired: true,
    message: knownMfaError ? error.message : 'Unable to process MFA request.',
    code: knownMfaError ? error.code : 'MFA_FAILED',
  });
}

async function issueAuthenticatedSession(req, res, user) {
  const employeeTableId = user.employee_table_id || user.Employee_ID;
  const employeeId = await ensureEmployeeAuthIdentifier(employeeTableId);
  user.Employee_ID = employeeId;
  const ipAddress = getRequestIp(req);
  const userAgent = getUserAgent(req);

  await resetFailedLoginAttemptsForUser(user.id);
  await updateLastLogin(employeeId);

  const authenticatedUser = await buildAuthenticatedUser(user);
  const { token: accessToken, jwtId } = generateAccessToken(authenticatedUser);
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
    token: accessToken,
    user: authenticatedUser,
    mustChangePassword: Boolean(Number(user.force_password_change)),
  });
}

async function login(req, res) {
  const loginIdentifier = req.body?.email || req.body?.username;
  const password = req.body?.password;
  const captchaToken = req.body?.captchaToken || req.body?.['g-recaptcha-response'];
  const ipAddress = getRequestIp(req);
  const userAgent = getUserAgent(req);

  if (!isNonEmptyString(loginIdentifier) || !isNonEmptyString(password)) {
    return invalidLoginResponse(res);
  }

  const normalizedLoginIdentifier = loginIdentifier.trim().toLowerCase();

  try {
    const captcha = await verifyRecaptchaToken({ token: captchaToken, remoteIp: ipAddress });
    if (!captcha.success) {
      await safeCreateAuditLog({
        Employee_ID: null,
        Action_Type: 'LOGIN_CAPTCHA_FAILED',
        Description: 'Login blocked because human verification failed.',
        IP_Address: ipAddress,
        User_Agent: userAgent,
      });
      return res.status(400).json({
        success: false,
        captchaRequired: true,
        code: captcha.code,
        message: 'Complete the human verification and try again.',
      });
    }

    const user = await findUserByEmail(normalizedLoginIdentifier);

    if (!user || isInactiveUser(user)) {
      await safeCreateAuditLog({
        Employee_ID: getAuthEmployeeId(user),
        Action_Type: 'LOGIN_FAILED',
        Description: `Login failed with invalid credentials for identifier ${auditLoginIdentifier(normalizedLoginIdentifier)}.`,
        IP_Address: ipAddress,
        User_Agent: userAgent,
      });

      return invalidLoginResponse(res);
    }

    const employeeId = getAuthEmployeeId(user);

    if (!employeeId) {
      await safeCreateAuditLog({
        Employee_ID: null,
        Action_Type: 'LOGIN_FAILED',
        Description: 'Login failed because the user account has no linked employee record.',
        IP_Address: ipAddress,
        User_Agent: userAgent,
      });

      return res.status(403).json({
        success: false,
        message: MISCONFIGURED_ACCOUNT_MESSAGE,
      });
    }

    const lockState = await getUserLoginLockState(user.id);
    if (lockState?.locked || isFutureDate(user.Locked_Until)) {
      await safeCreateAuditLog({
        Employee_ID: employeeId,
        Action_Type: 'LOGIN_BLOCKED_LOCKED_ACCOUNT',
        Description: 'Login blocked because the account is temporarily locked.',
        IP_Address: ipAddress,
        User_Agent: userAgent,
      });

      return lockedAccountResponse(res, lockState || { lockedUntil: user.Locked_Until });
    }

    const passwordMatches = await verifyPassword(user.Password_Hash, password);

    if (!passwordMatches) {
      const failure = await recordFailedLoginFailureForUser(user.id, {
        maxAttempts: MAX_FAILED_ATTEMPTS,
        lockMinutes: LOCK_MINUTES,
      });

      if (failure?.locked) {
        await safeCreateAuditLog({
          Employee_ID: employeeId,
          Action_Type: 'ACCOUNT_LOCKED',
          Description: 'Account locked after repeated failed login attempts.',
          IP_Address: ipAddress,
          User_Agent: userAgent,
        });
        return lockedAccountResponse(res, failure);
      } else {
        await safeCreateAuditLog({
          Employee_ID: employeeId,
          Action_Type: 'LOGIN_FAILED',
          Description: `Login failed with invalid credentials for identifier ${auditLoginIdentifier(normalizedLoginIdentifier)}.`,
          IP_Address: ipAddress,
          User_Agent: userAgent,
        });
      }

      return invalidLoginAttemptResponse(res, failure);
    }

    // A correct password resets password-lockout state, but never creates an
    // access token until the MFA challenge has been successfully verified.
    await resetFailedLoginAttemptsForUser(user.id);
    if (isMfaRequiredForRole(user.role_name)) {
      try {
        const challenge = await createMfaChallenge({
          employeeId,
          accountName: user.username || user.Email || normalizedLoginIdentifier,
          req,
        });
        return res.status(202).json({
          success: true,
          mfaRequired: true,
          challengeId: challenge.challengeId,
          mfaToken: challenge.mfaToken,
          codeLength: challenge.codeLength,
          expiresIn: challenge.expiresIn,
          enrollmentRequired: challenge.enrollmentRequired,
          method: challenge.method,
          qrCodeDataUrl: challenge.qrCodeDataUrl,
          manualEntryKey: challenge.manualEntryKey,
          issuer: challenge.issuer,
          accountName: challenge.accountName,
        });
      } catch (error) {
        console.error('[authController] MFA challenge failed:', error.code || error.message);
        return mfaErrorResponse(res, error);
      }
    }

    await safeCreateAuditLog({
      Employee_ID: employeeId,
      Action_Type: 'MFA_NOT_REQUIRED',
      Description: 'MFA is not required for this non-privileged account.',
      IP_Address: ipAddress,
      User_Agent: userAgent,
    });

    return issueAuthenticatedSession(req, res, user);
  } catch (error) {
    if (error instanceof RecaptchaServiceError) {
      await safeCreateAuditLog({
        Employee_ID: null,
        Action_Type: 'LOGIN_CAPTCHA_UNAVAILABLE',
        Description: 'Login blocked because human verification was unavailable.',
        IP_Address: ipAddress,
        User_Agent: userAgent,
      });
      return res.status(error.statusCode).json({
        success: false,
        captchaRequired: true,
        code: error.code,
        message: error.message,
      });
    }
    console.error('[authController] login failed:', error.message);
    return res.status(500).json({
      success: false,
      message: UNEXPECTED_LOGIN_MESSAGE,
    });
  }
}

function captchaConfig(_req, res) {
  try {
    return res.json(publicRecaptchaConfig());
  } catch (error) {
    console.error('[authController] CAPTCHA config failed:', error.code || error.message);
    return res.status(Number(error.statusCode || 503)).json({
      success: false,
      enabled: true,
      message: 'Human verification is unavailable.',
    });
  }
}

async function logout(req, res) {
  try {
    const revoked = req.user?.jti
      ? await revokeSessionByJwtId(req.user.jti, 'user_logout')
      : 0;
    const { maxAge: _maxAge, ...cookieOptions } = getRefreshCookieOptions();
    res.clearCookie(REFRESH_COOKIE_NAME, cookieOptions);
    await safeCreateAuditLog({
      Employee_ID: req.user?.Employee_ID || req.user?.employeeId || null,
      Action_Type: 'LOGOUT_SUCCESS',
      Description: `User logout completed; ${Number(revoked || 0)} session revoked.`,
      IP_Address: getRequestIp(req),
      User_Agent: getUserAgent(req),
    });
    return res.json({ success: true, message: 'Logout successful.' });
  } catch (error) {
    console.error('[authController] logout failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to process logout.' });
  }
}

async function verifyMfa(req, res) {
  try {
    const result = await verifyMfaChallenge({
      challengeId: req.body?.challengeId,
      mfaToken: req.body?.mfaToken,
      code: req.body?.code,
      req,
    });
    const authenticatedUser = await findUserById(result.employeeId);
    if (!authenticatedUser || isInactiveUser(authenticatedUser)) {
      return res.status(401).json({ success: false, message: 'MFA challenge is no longer valid.' });
    }
    return issueAuthenticatedSession(req, res, authenticatedUser);
  } catch (error) {
    console.error('[authController] MFA verification failed:', error.code || error.message);
    return mfaErrorResponse(res, error);
  }
}

async function resendMfa(req, res) {
  try {
    const result = await resendMfaChallenge({
      challengeId: req.body?.challengeId,
      mfaToken: req.body?.mfaToken,
      req,
    });
    return res.json({ success: true, mfaRequired: true, ...result });
  } catch (error) {
    console.error('[authController] MFA resend failed:', error.code || error.message);
    return mfaErrorResponse(res, error);
  }
}

async function lockoutStatus(req, res) {
  const loginIdentifier = req.query?.username || req.query?.email;
  if (!isNonEmptyString(loginIdentifier)) {
    return res.status(400).json({ success: false, message: 'Username is required.' });
  }

  try {
    const user = await findUserByEmail(loginIdentifier.trim().toLowerCase());
    if (!user || isInactiveUser(user)) {
      return res.json({
        success: true,
        locked: false,
        attempts: 0,
        remaining_attempts: MAX_FAILED_ATTEMPTS,
        locked_until: null,
        lock_seconds_remaining: 0,
      });
    }
    const state = await getUserLoginLockState(user.id);
    return res.json({
      success: true,
      locked: Boolean(state?.locked),
      attempts: Number(state?.attempts || 0),
      remaining_attempts: Math.max(MAX_FAILED_ATTEMPTS - Number(state?.attempts || 0), 0),
      locked_until: state?.lockedUntil || null,
      lock_seconds_remaining: Number(state?.lockSecondsRemaining || 0),
    });
  } catch (error) {
    console.error('[authController] lockout status failed:', error.message);
    return res.status(500).json({ success: false, message: UNEXPECTED_LOGIN_MESSAGE });
  }
}

module.exports = {
  login,
  captchaConfig,
  logout,
  verifyMfa,
  resendMfa,
  lockoutStatus,
};
