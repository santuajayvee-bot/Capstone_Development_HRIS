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
  findUserByUserId,
  incrementFailedLoginAttempts,
  resetFailedLoginAttempts,
  lockUserAccount,
  updateLastLogin,
  createUserSession,
  saveUserOtpChallenge,
  incrementUserOtpAttempts,
  clearUserOtpChallenge,
  updateUserMfaVerifiedAt,
  createAuditLog,
} = require('../db/authQueries');
const {
  getUserPermissions,
  getLinkedEmployeeProfile,
} = require('../server/users');
const {
  getTurnstileClientConfig,
  verifyTurnstileToken,
} = require('../services/turnstileService');
const {
  assertCanResend,
  assertCanVerify,
  assertMfaTempTokenReady,
  createMfaTempToken,
  generateOtpCode,
  getMfaPolicy,
  getOtpExpiryDate,
  hashOtp,
  normalizePhoneNumber,
  redactPhoneNumber,
  sendOtpSms,
  verifyMfaTempToken,
  verifyOtpHash,
} = require('../services/smsOtpService');

const INVALID_LOGIN_MESSAGE = 'Invalid email or password.';
const TURNSTILE_FAILED_MESSAGE = 'Verification failed. Please try again.';
const MFA_CODE_FAILED_MESSAGE = 'Invalid verification code.';
const MFA_UNAVAILABLE_MESSAGE = 'Multi-factor authentication could not be completed. Please contact your administrator.';
const LOCKED_ACCOUNT_MESSAGE = 'Account temporarily locked. Please try again later.';
const MISCONFIGURED_ACCOUNT_MESSAGE = 'Account is not fully configured. Please contact your administrator.';
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

function getAccessLevelNumber(user) {
  const raw = user?.Access_Level;
  const direct = Number(raw);
  if (Number.isFinite(direct)) return direct;
  const match = String(raw || '').match(/\d+/);
  return match ? Number(match[0]) : 1;
}

function isDevelopmentMfaBypassEnabled() {
  return process.env.NODE_ENV !== 'production'
    && process.env.DISABLE_SMS_MFA_FOR_LOCAL_DEV === 'true';
}

function isMfaRequiredByPolicy(user) {
  const accessLevel = getAccessLevelNumber(user);
  const method = String(user?.mfa_method || 'sms').toLowerCase();
  const userEnabled = user?.mfa_enabled === undefined || user?.mfa_enabled === null
    ? true
    : Boolean(Number(user.mfa_enabled));

  if (accessLevel >= 2) return true;
  return userEnabled && method === 'sms' && isNonEmptyString(user?.phone_number);
}

function isMfaRequiredForUser(user) {
  if (isDevelopmentMfaBypassEnabled()) return false;
  return isMfaRequiredByPolicy(user);
}

async function buildAuthenticatedUser(user) {
  const role = normalizeRoleName(user.role_name);
  const employeeId = user.employee_table_id || user.Employee_ID;
  const permissions = await getUserPermissions(user.id, role);
  const employeeProfile = await getLinkedEmployeeProfile(employeeId);

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
    passwordChangedAt: user.Password_Changed_At || null,
    permissions,
    employeeProfile,
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

function getTurnstileToken(req) {
  return req.body?.turnstileToken
    || req.body?.cfTurnstileResponse
    || req.body?.['cf-turnstile-response']
    || '';
}

function turnstileFailedResponse(res) {
  return res.status(400).json({
    success: false,
    message: TURNSTILE_FAILED_MESSAGE,
  });
}

async function issueAuthenticatedSession(req, res, user, options = {}) {
  const employeeId = getAuthEmployeeId(user);
  const ipAddress = getRequestIp(req);
  const userAgent = getUserAgent(req);

  await resetFailedLoginAttempts(employeeId);
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
    Description: options.mfaCompleted
      ? 'User login successful after SMS MFA verification.'
      : 'User login successful.',
    IP_Address: ipAddress,
    User_Agent: userAgent,
  });

  return res.json({
    success: true,
    message: 'Login successful.',
    accessToken,
    token: accessToken,
    user: authenticatedUser,
    mfaRequired: false,
    mustChangePassword: Boolean(Number(user.force_password_change)),
  });
}

async function startSmsMfaChallenge(req, res, user) {
  const employeeId = getAuthEmployeeId(user);
  const ipAddress = getRequestIp(req);
  const userAgent = getUserAgent(req);
  let phoneNumber;

  try {
    phoneNumber = normalizePhoneNumber(user.phone_number);
  } catch (error) {
    await safeCreateAuditLog({
      Employee_ID: employeeId,
      Action_Type: 'LOGIN_MFA_MISCONFIGURED',
      Description: 'SMS MFA login blocked because the account has no valid phone number.',
      IP_Address: ipAddress,
      User_Agent: userAgent,
    });

    return res.status(403).json({
      success: false,
      message: MISCONFIGURED_ACCOUNT_MESSAGE,
    });
  }

  try {
    assertMfaTempTokenReady();
    const otpCode = generateOtpCode();
    const otpHash = hashOtp(phoneNumber, otpCode);
    const otpExpiresAt = getOtpExpiryDate();
    await saveUserOtpChallenge(user.id, otpHash, otpExpiresAt);

    // PhilSMS only delivers the SMS. LGSV HR generates, hashes, stores,
    // expires, and verifies the OTP internally.
    await sendOtpSms(phoneNumber, otpCode);

    const mfaToken = createMfaTempToken({
      userId: user.id,
      employeeId,
      role: normalizeRoleName(user.role_name),
    });

    await safeCreateAuditLog({
      Employee_ID: employeeId,
      Action_Type: 'LOGIN_MFA_CHALLENGE_SENT',
      Description: `SMS MFA challenge sent to ${redactPhoneNumber(phoneNumber)}.`,
      IP_Address: ipAddress,
      User_Agent: userAgent,
    });

    return res.json({
      success: true,
      mfaRequired: true,
      mfaToken,
      mfaMethod: 'sms',
      message: 'Verification code sent.',
      expiresInSeconds: getMfaPolicy().otpExpiresSeconds,
      resendCooldownSeconds: getMfaPolicy().resendCooldownSeconds,
    });
  } catch (error) {
    console.error('[authController] SMS MFA challenge failed:', error.message);
    await clearUserOtpChallenge(user.id).catch(() => {});
    await safeCreateAuditLog({
      Employee_ID: employeeId,
      Action_Type: 'LOGIN_MFA_SEND_FAILED',
      Description: `SMS MFA challenge could not be sent. Code: ${error.code || 'UNKNOWN'}.`,
      IP_Address: ipAddress,
      User_Agent: userAgent,
    });

    return res.status(503).json({
      success: false,
      message: MFA_UNAVAILABLE_MESSAGE,
    });
  }
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
    // CAPTCHA is an added authentication-layer control. It is verified before
    // account lookup/password verification, but it does not replace MFA, RBAC,
    // account lockout, Argon2 password hashing, or audit logging.
    try {
      await verifyTurnstileToken(getTurnstileToken(req), ipAddress);
    } catch (turnstileError) {
      await safeCreateAuditLog({
        Employee_ID: null,
        Action_Type: 'LOGIN_CAPTCHA_FAILED',
        Description: `Turnstile verification failed during login. Code: ${turnstileError.code || 'UNKNOWN'}.`,
        IP_Address: ipAddress,
        User_Agent: userAgent,
      });

      return turnstileFailedResponse(res);
    }

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

    if (isMfaRequiredForUser(user)) {
      return startSmsMfaChallenge(req, res, user);
    }

    if (isMfaRequiredByPolicy(user) && isDevelopmentMfaBypassEnabled()) {
      await safeCreateAuditLog({
        Employee_ID: employeeId,
        Action_Type: 'LOGIN_MFA_BYPASSED_LOCAL_DEV',
        Description: 'SMS MFA was bypassed by local development environment setting.',
        IP_Address: ipAddress,
        User_Agent: userAgent,
      });
    }

    return issueAuthenticatedSession(req, res, user);
  } catch (error) {
    console.error('[authController] login failed:', error.message);
    return res.status(500).json({
      success: false,
      message: UNEXPECTED_LOGIN_MESSAGE,
    });
  }
}

async function verifySmsMfa(req, res) {
  const mfaToken = req.body?.mfaToken;
  const code = req.body?.otpCode || req.body?.code;
  const ipAddress = getRequestIp(req);
  const userAgent = getUserAgent(req);

  try {
    const tokenPayload = verifyMfaTempToken(mfaToken);
    const user = await findUserByUserId(tokenPayload.userId);
    if (!user || isInactiveUser(user)) {
      return res.status(401).json({ success: false, message: MFA_CODE_FAILED_MESSAGE });
    }

    assertCanVerify(user);

    let otpMatches = false;
    try {
      otpMatches = verifyOtpHash(user.phone_number, code, user.otp_hash);
    } catch (error) {
      otpMatches = false;
    }

    if (!otpMatches) {
      const attempts = await incrementUserOtpAttempts(user.id);
      if (attempts >= getMfaPolicy().maxVerifyAttempts) {
        await clearUserOtpChallenge(user.id);
      }

      await safeCreateAuditLog({
        Employee_ID: tokenPayload.employeeId || getAuthEmployeeId(user),
        Action_Type: 'LOGIN_MFA_FAILED',
        Description: 'SMS MFA verification failed.',
        IP_Address: ipAddress,
        User_Agent: userAgent,
      });

      return res.status(401).json({
        success: false,
        message: MFA_CODE_FAILED_MESSAGE,
      });
    }

    await clearUserOtpChallenge(user.id);
    await updateUserMfaVerifiedAt(user.id);
    await safeCreateAuditLog({
      Employee_ID: tokenPayload.employeeId || getAuthEmployeeId(user),
      Action_Type: 'LOGIN_MFA_SUCCESS',
      Description: 'SMS MFA verification completed successfully.',
      IP_Address: ipAddress,
      User_Agent: userAgent,
    });

    return issueAuthenticatedSession(req, res, user, { mfaCompleted: true });
  } catch (error) {
    console.error('[authController] SMS MFA verify failed:', error.message);

    if (error.code === 'MFA_VERIFY_LIMIT' || error.code === 'MFA_OTP_EXPIRED') {
      const tokenPayload = (() => {
        try { return verifyMfaTempToken(mfaToken); } catch (_) { return null; }
      })();
      if (tokenPayload?.userId) {
        await clearUserOtpChallenge(tokenPayload.userId).catch(() => {});
      }
    }

    return res.status(401).json({
      success: false,
      message: MFA_CODE_FAILED_MESSAGE,
    });
  }
}

async function resendSmsMfa(req, res) {
  const mfaToken = req.body?.mfaToken;
  const ipAddress = getRequestIp(req);
  const userAgent = getUserAgent(req);
  let userForCleanup = null;

  try {
    const tokenPayload = verifyMfaTempToken(mfaToken);
    const user = await findUserByUserId(tokenPayload.userId);
    if (!user || isInactiveUser(user)) {
      return res.status(401).json({ success: false, message: MFA_CODE_FAILED_MESSAGE });
    }

    userForCleanup = user;
    assertCanResend(user);

    const otpCode = generateOtpCode();
    const otpHash = hashOtp(user.phone_number, otpCode);
    const otpExpiresAt = getOtpExpiryDate();
    await saveUserOtpChallenge(user.id, otpHash, otpExpiresAt);
    await sendOtpSms(user.phone_number, otpCode);

    await safeCreateAuditLog({
      Employee_ID: tokenPayload.employeeId || getAuthEmployeeId(user),
      Action_Type: 'LOGIN_MFA_RESENT',
      Description: `SMS MFA challenge resent to ${redactPhoneNumber(user.phone_number)}.`,
      IP_Address: ipAddress,
      User_Agent: userAgent,
    });

    return res.json({
      success: true,
      message: 'Verification code sent.',
      resendCooldownSeconds: getMfaPolicy().resendCooldownSeconds,
    });
  } catch (error) {
    console.error('[authController] SMS MFA resend failed:', error.message);

    if (error.code === 'PHILSMS_SEND_FAILED' && userForCleanup?.id) {
      await clearUserOtpChallenge(userForCleanup.id).catch(() => {});
    }

    if (error.code === 'MFA_RESEND_COOLDOWN') {
      return res.status(429).json({
        success: false,
        message: 'Please wait before requesting another code.',
        retryAfterSeconds: error.waitSeconds,
      });
    }

    if (error.code === 'MFA_RESEND_LIMIT') {
      return res.status(429).json({
        success: false,
        message: 'Too many verification code requests. Please start login again.',
      });
    }

    return res.status(400).json({
      success: false,
      message: MFA_UNAVAILABLE_MESSAGE,
    });
  }
}

async function turnstileConfig(req, res) {
  const config = getTurnstileClientConfig();
  return res.json({
    enabled: config.enabled,
    siteKey: config.siteKey,
    testMode: config.testMode,
  });
}

module.exports = {
  login,
  resendSmsMfa,
  turnstileConfig,
  verifySmsMfa,
};
