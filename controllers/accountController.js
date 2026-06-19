const {
  AccountPasswordError,
  adminResetPassword,
  changeOwnPassword,
} = require('../services/accountPasswordService');

const REFRESH_COOKIE_NAME = 'refreshToken';

function getRequestIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.ip
    || req.socket?.remoteAddress
    || null;
}

function getUserAgent(req) {
  return String(req.headers['user-agent'] || '').slice(0, 500) || null;
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/auth',
  });
}

function accountPasswordErrorResponse(res, error) {
  const status = error instanceof AccountPasswordError ? error.statusCode : 500;
  const body = {
    success: false,
    message: error instanceof AccountPasswordError
      ? error.message
      : 'Password request could not be completed.',
  };

  if (error instanceof AccountPasswordError) {
    body.code = error.code;
    if (Array.isArray(error.details)) body.requirements = error.details;
  }

  return res.status(status).json(body);
}

function readPasswordBody(req) {
  return {
    currentPassword: req.body?.currentPassword || req.body?.current_password || '',
    newPassword: req.body?.newPassword || req.body?.new_password || '',
    confirmPassword: req.body?.confirmPassword || req.body?.confirm_password || '',
  };
}

async function changeOwnAccountPassword(req, res) {
  try {
    const result = await changeOwnPassword({
      userId: req.user?.id,
      employeeId: req.user?.employeeId || req.user?.Employee_ID,
      ...readPasswordBody(req),
      ipAddress: getRequestIp(req),
      userAgent: getUserAgent(req),
    });

    clearRefreshCookie(res);

    return res.json({
      success: true,
      message: result.wasForced
        ? 'Password changed successfully. Please log in again.'
        : 'Password changed successfully.',
      requiresRelogin: true,
    });
  } catch (error) {
    console.error('[accountController] change password failed:', error.message);
    return accountPasswordErrorResponse(res, error);
  }
}

async function resetUserPassword(req, res) {
  try {
    const result = await adminResetPassword({
      actorUserId: req.user?.id,
      actorEmployeeId: req.user?.employeeId || req.user?.Employee_ID,
      targetUserId: req.params.id || req.params.userId,
      temporaryPassword: req.body?.temporaryPassword
        || req.body?.temporary_password
        || req.body?.password
        || '',
      ipAddress: getRequestIp(req),
      userAgent: getUserAgent(req),
    });

    const response = {
      success: true,
      message: 'Temporary password set; user must change it on next login.',
      forcePasswordChange: true,
      generatedTemporaryPassword: result.generated,
    };

    if (result.generated && result.temporaryPassword) {
      response.temporaryPassword = result.temporaryPassword;
    }

    return res.json(response);
  } catch (error) {
    console.error('[accountController] admin reset password failed:', error.message);
    return accountPasswordErrorResponse(res, error);
  }
}

module.exports = {
  changeOwnAccountPassword,
  resetUserPassword,
};
