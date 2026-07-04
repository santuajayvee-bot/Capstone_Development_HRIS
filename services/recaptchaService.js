const GOOGLE_SITEVERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';
const DEFAULT_VERIFY_TIMEOUT_MS = 5000;

class RecaptchaServiceError extends Error {
  constructor(message, code = 'RECAPTCHA_FAILED', statusCode = 400) {
    super(message);
    this.name = 'RecaptchaServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function booleanEnv(name, fallback = false) {
  const value = String(process.env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function recaptchaConfig() {
  const production = process.env.NODE_ENV === 'production';
  const configuredTimeout = Number(process.env.RECAPTCHA_VERIFY_TIMEOUT_MS);
  return {
    enabled: booleanEnv('RECAPTCHA_ENABLED', production),
    siteKey: String(process.env.RECAPTCHA_SITE_KEY || '').trim(),
    secretKey: String(process.env.RECAPTCHA_SECRET_KEY || '').trim(),
    allowedHostnames: allowedHostnames(),
    timeoutMs: Number.isFinite(configuredTimeout) && configuredTimeout >= 1000 && configuredTimeout <= 10000
      ? configuredTimeout
      : DEFAULT_VERIFY_TIMEOUT_MS,
    production,
  };
}

function allowedHostnames() {
  const hostnames = new Set(
    String(process.env.RECAPTCHA_ALLOWED_HOSTNAMES || '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
  );

  try {
    const publicUrl = new URL(String(process.env.APP_PUBLIC_URL || '').trim());
    if (publicUrl.hostname) hostnames.add(publicUrl.hostname.toLowerCase());
  } catch (_) {}

  if (process.env.NODE_ENV !== 'production') {
    hostnames.add('localhost');
    hostnames.add('127.0.0.1');
  }
  return hostnames;
}

function assertRecaptchaConfiguration(config) {
  if (!config.enabled) {
    if (config.production) {
      throw new RecaptchaServiceError('Human verification is not configured.', 'RECAPTCHA_DISABLED', 503);
    }
    return;
  }
  if (!config.siteKey || !config.secretKey) {
    throw new RecaptchaServiceError('Human verification is not configured.', 'RECAPTCHA_NOT_CONFIGURED', 503);
  }
  if (config.production && !config.allowedHostnames.size) {
    throw new RecaptchaServiceError('Human verification is not configured.', 'RECAPTCHA_HOSTNAME_NOT_CONFIGURED', 503);
  }
}

function publicRecaptchaConfig() {
  const config = recaptchaConfig();
  assertRecaptchaConfiguration(config);
  return {
    enabled: config.enabled,
    siteKey: config.enabled ? config.siteKey : null,
  };
}

async function verifyRecaptchaToken({ token, remoteIp }) {
  const config = recaptchaConfig();
  assertRecaptchaConfiguration(config);
  if (!config.enabled) return { success: true, skipped: true };
  if (!token || typeof token !== 'string') {
    return { success: false, code: 'RECAPTCHA_TOKEN_REQUIRED' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const body = new URLSearchParams({
      secret: config.secretKey,
      response: token,
    });
    if (remoteIp) body.set('remoteip', remoteIp);

    const response = await fetch(GOOGLE_SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new RecaptchaServiceError('Human verification is temporarily unavailable.', 'RECAPTCHA_PROVIDER_UNAVAILABLE', 503);
    }

    const result = await response.json();
    const hostname = String(result.hostname || '').trim().toLowerCase();
    const hostnameAllowed = !result.success || config.allowedHostnames.has(hostname);
    return {
      success: result.success === true && hostnameAllowed,
      code: result.success && !hostnameAllowed ? 'RECAPTCHA_HOSTNAME_MISMATCH' : 'RECAPTCHA_FAILED',
    };
  } catch (error) {
    if (error instanceof RecaptchaServiceError) throw error;
    throw new RecaptchaServiceError('Human verification is temporarily unavailable.', 'RECAPTCHA_PROVIDER_UNAVAILABLE', 503);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  RecaptchaServiceError,
  publicRecaptchaConfig,
  recaptchaConfig,
  verifyRecaptchaToken,
};
