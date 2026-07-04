const assert = require('assert');

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  APP_PUBLIC_URL: process.env.APP_PUBLIC_URL,
  RECAPTCHA_ENABLED: process.env.RECAPTCHA_ENABLED,
  RECAPTCHA_SITE_KEY: process.env.RECAPTCHA_SITE_KEY,
  RECAPTCHA_SECRET_KEY: process.env.RECAPTCHA_SECRET_KEY,
  RECAPTCHA_ALLOWED_HOSTNAMES: process.env.RECAPTCHA_ALLOWED_HOSTNAMES,
};
const originalFetch = global.fetch;

function restore() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  global.fetch = originalFetch;
}

(async () => {
  try {
    process.env.NODE_ENV = 'test';
    process.env.RECAPTCHA_ENABLED = 'true';
    process.env.RECAPTCHA_SITE_KEY = 'test-site-key';
    process.env.RECAPTCHA_SECRET_KEY = 'test-secret-key';
    process.env.RECAPTCHA_ALLOWED_HOSTNAMES = 'localhost,lgsvhr.com';

    const { publicRecaptchaConfig, verifyRecaptchaToken } = require('../services/recaptchaService');
    assert.deepStrictEqual(publicRecaptchaConfig(), { enabled: true, siteKey: 'test-site-key' });

    let capturedBody = '';
    global.fetch = async (_url, options) => {
      capturedBody = String(options.body);
      return { ok: true, json: async () => ({ success: true, hostname: 'localhost' }) };
    };
    const passed = await verifyRecaptchaToken({ token: 'one-time-token', remoteIp: '127.0.0.1' });
    assert.strictEqual(passed.success, true);
    assert(capturedBody.includes('secret=test-secret-key'));
    assert(capturedBody.includes('response=one-time-token'));

    global.fetch = async () => ({ ok: true, json: async () => ({ success: true, hostname: 'attacker.example' }) });
    const hostnameMismatch = await verifyRecaptchaToken({ token: 'token' });
    assert.strictEqual(hostnameMismatch.success, false);
    assert.strictEqual(hostnameMismatch.code, 'RECAPTCHA_HOSTNAME_MISMATCH');

    const missing = await verifyRecaptchaToken({ token: '' });
    assert.strictEqual(missing.success, false);
    assert.strictEqual(missing.code, 'RECAPTCHA_TOKEN_REQUIRED');

    console.log('Google reCAPTCHA service tests: PASS');
  } finally {
    restore();
  }
})().catch(error => {
  restore();
  console.error(error);
  process.exit(1);
});
