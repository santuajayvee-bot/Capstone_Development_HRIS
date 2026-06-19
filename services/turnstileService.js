const crypto = require('crypto');

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;
const VERIFY_TIMEOUT_MS = 5000;

const DEV_TEST_SITE_KEY = '1x00000000000000000000AA';
const DEV_TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';

class TurnstileVerificationError extends Error {
  constructor(message, code = 'TURNSTILE_VERIFICATION_FAILED', details = null) {
    super(message);
    this.name = 'TurnstileVerificationError';
    this.code = code;
    this.details = details;
    this.turnstileVerificationFailed = true;
  }
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getSiteKey() {
  return process.env.TURNSTILE_SITE_KEY || (isProduction() ? '' : DEV_TEST_SITE_KEY);
}

function getSecretKey() {
  return process.env.TURNSTILE_SECRET_KEY || (isProduction() ? '' : DEV_TEST_SECRET_KEY);
}

function getTurnstileClientConfig() {
  const siteKey = getSiteKey();
  return {
    siteKey,
    enabled: Boolean(siteKey),
    testMode: !isProduction() && siteKey === DEV_TEST_SITE_KEY,
  };
}

function normalizeToken(token) {
  if (!isNonEmptyString(token)) {
    throw new TurnstileVerificationError('Turnstile token is missing.', 'TURNSTILE_TOKEN_MISSING');
  }

  const normalized = token.trim();
  if (normalized.length > MAX_TOKEN_LENGTH) {
    throw new TurnstileVerificationError('Turnstile token is too long.', 'TURNSTILE_TOKEN_INVALID_LENGTH');
  }

  return normalized;
}

async function verifyTurnstileToken(token, remoteIp = null) {
  const secret = getSecretKey();
  if (!isNonEmptyString(secret)) {
    throw new TurnstileVerificationError('Turnstile secret key is not configured.', 'TURNSTILE_SECRET_MISSING');
  }

  const normalizedToken = normalizeToken(token);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        secret,
        response: normalizedToken,
        remoteip: remoteIp || undefined,
        idempotency_key: crypto.randomUUID(),
      }),
    });

    if (!response.ok) {
      throw new TurnstileVerificationError('Turnstile siteverify request failed.', 'TURNSTILE_HTTP_ERROR', {
        status: response.status,
      });
    }

    const result = await response.json();
    if (!result.success) {
      throw new TurnstileVerificationError('Turnstile token was rejected.', 'TURNSTILE_TOKEN_REJECTED', {
        errorCodes: result['error-codes'] || [],
      });
    }

    return result;
  } catch (error) {
    if (error.turnstileVerificationFailed) throw error;
    throw new TurnstileVerificationError(
      'Turnstile verification could not be completed.',
      error.name === 'AbortError' ? 'TURNSTILE_TIMEOUT' : 'TURNSTILE_NETWORK_ERROR'
    );
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  TurnstileVerificationError,
  getTurnstileClientConfig,
  verifyTurnstileToken,
};
