/*
 * AES-256-GCM middleware for sensitive off-chain API communication.
 *
 * Objective supported:
 * "To safeguard employee, HR, and payroll data from unauthorized exposure by
 * using AES-256 encryption for off-chain communication between client, partner,
 * and system."
 *
 * Normal browser UI requests remain HTTPS JSON. Trusted partner/system clients
 * can opt in by sending { encryptedPayload: { iv, encryptedData, authTag } }
 * and requesting encrypted responses with X-LGSV-Encrypted-Response: true.
 */

const {
  EncryptionConfigurationError,
  EncryptedPayloadError,
  decryptSensitiveData,
  encryptSensitiveData,
} = require('../../utils/aesEncryption');

const SENSITIVE_API_PREFIXES = [
  '/api/account',
  '/api/admin',
  '/api/attendance',
  '/api/auth',
  '/api/biometric',
  '/api/blockchain/payroll',
  '/api/employee',
  '/api/employee-setup',
  '/api/employees',
  '/api/201-files',
  '/api/form-drafts',
  '/api/leave',
  '/api/onboarding',
  '/api/payroll',
  '/api/reports',
  '/api/requests',
  '/api/self-service',
];

function isSensitiveApiPath(path = '') {
  return SENSITIVE_API_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

function hasEncryptedPayload(body) {
  const payload = body?.encryptedPayload || body;
  return Boolean(
    payload
      && typeof payload === 'object'
      && typeof payload.iv === 'string'
      && typeof payload.encryptedData === 'string'
      && typeof payload.authTag === 'string'
  );
}

function wantsEncryptedResponse(req) {
  return String(req.get('X-LGSV-Encrypted-Response') || '').toLowerCase() === 'true'
    || String(req.get('Accept') || '').includes('application/vnd.lgsv.encrypted+json');
}

function safeEncryptedPayloadError(error) {
  if (error instanceof EncryptionConfigurationError) {
    return {
      status: 503,
      body: {
        success: false,
        error: 'Encrypted communication is not configured.',
      },
    };
  }

  if (error instanceof EncryptedPayloadError || error instanceof SyntaxError) {
    return {
      status: 400,
      body: {
        success: false,
        error: 'Invalid or unreadable encrypted payload.',
      },
    };
  }

  return {
    status: 400,
    body: {
      success: false,
      error: 'Invalid or unreadable encrypted payload.',
    },
  };
}

function decryptSensitiveRequest(req, res, next) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
  if (!req.is('application/json')) return next();
  if (!isSensitiveApiPath(req.path)) return next();
  if (!hasEncryptedPayload(req.body)) return next();

  try {
    const decryptedBody = decryptSensitiveData(req.body.encryptedPayload || req.body);
    if (!decryptedBody || typeof decryptedBody !== 'object' || Array.isArray(decryptedBody)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or unreadable encrypted payload.',
      });
    }

    req.body = decryptedBody;
    req.encryptedCommunication = {
      ...(req.encryptedCommunication || {}),
      requestEncrypted: true,
    };
    return next();
  } catch (error) {
    const safe = safeEncryptedPayloadError(error);
    return res.status(safe.status).json(safe.body);
  }
}

function encryptSensitiveResponse(req, res, next) {
  if (!isSensitiveApiPath(req.path) || !wantsEncryptedResponse(req)) return next();

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400) return originalJson(body);

    try {
      res.setHeader('X-LGSV-Encrypted-Response', 'true');
      return originalJson({
        encryptedPayload: encryptSensitiveData(body),
      });
    } catch (error) {
      console.error('Encrypted response failed:', error instanceof EncryptionConfigurationError ? error.message : 'payload encryption failed');
      res.status(503);
      return originalJson({
        success: false,
        error: 'Encrypted communication is not configured.',
      });
    }
  };

  return next();
}

function encryptedCommunicationMiddleware(req, res, next) {
  encryptSensitiveResponse(req, res, (responseError) => {
    if (responseError) return next(responseError);
    return decryptSensitiveRequest(req, res, next);
  });
}

module.exports = {
  decryptSensitiveRequest,
  encryptSensitiveResponse,
  encryptedCommunicationMiddleware,
  isSensitiveApiPath,
};
