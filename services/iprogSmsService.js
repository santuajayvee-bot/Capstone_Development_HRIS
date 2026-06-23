const SEND_OTP_URL = 'https://www.iprogsms.com/api/v1/otp/send_otp';
const VERIFY_OTP_URL = 'https://www.iprogsms.com/api/v1/otp/verify_otp';
const SEND_SMS_URL = 'https://www.iprogsms.com/api/v1/sms_messages';
const REQUEST_TIMEOUT_MS = 10000;

class IprogSmsError extends Error {
  constructor(message, code = 'IPROG_REQUEST_FAILED') {
    super(message);
    this.name = 'IprogSmsError';
    this.code = code;
  }
}

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function getIprogConfig() {
  const message = String(process.env.IPROG_OTP_MESSAGE || '').trim();
  return {
    token: String(process.env.IPROG_API_TOKEN || '').trim(),
    expiresInMinutes: positiveInteger(process.env.IPROG_OTP_EXPIRES_IN_MINUTES, 5, 1, 60),
    message: message || 'Your LGSV HR verification code is :otp. It is valid for 5 minutes. Do not share this code with anyone.',
  };
}

function responseIndicatesFailure(payload) {
  if (!payload || typeof payload !== 'object') return true;
  if (payload.success === false || payload.status === false || payload.error === true) return true;

  const status = String(payload.status ?? payload.code ?? '').trim().toLowerCase();
  if (['error', 'failed', 'failure', 'invalid', 'unauthorized'].includes(status)) return true;
  if (/^(4|5)\d\d$/.test(status)) return true;

  const message = String(payload.message ?? payload.error_message ?? payload.error ?? '').toLowerCase();
  return /\b(error|failed|failure|invalid|incorrect|expired|unauthorized)\b/.test(message);
}

async function postIprog(url, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }

    if (!response.ok) {
      throw new IprogSmsError('IPROG OTP service is unavailable.', 'IPROG_HTTP_FAILURE');
    }
    if (responseIndicatesFailure(data)) {
      throw new IprogSmsError('IPROG rejected the OTP request.', 'IPROG_RESPONSE_REJECTED');
    }
    return data;
  } catch (error) {
    if (error instanceof IprogSmsError) throw error;
    throw new IprogSmsError('IPROG OTP service is unavailable.');
  } finally {
    clearTimeout(timeout);
  }
}

function assertIprogConfiguration(config) {
  if (!config.token) {
    throw new IprogSmsError('IPROG MFA is not configured.', 'IPROG_NOT_CONFIGURED');
  }
}

function assertIprogOtpConfiguration(config) {
  assertIprogConfiguration(config);
  if (!config.message.includes(':otp')) {
    throw new IprogSmsError('IPROG OTP message is not configured.', 'IPROG_MESSAGE_INVALID');
  }
}

// IPROG generates and validates the OTP. LGSV HR never logs the code or API token.
async function sendOtp(phoneNumber) {
  const config = getIprogConfig();
  assertIprogOtpConfiguration(config);
  await postIprog(SEND_OTP_URL, {
    api_token: config.token,
    phone_number: phoneNumber,
    message: config.message,
    expires_in_minutes: config.expiresInMinutes,
  });
  return true;
}

async function sendSms(phoneNumber, message) {
  const config = getIprogConfig();
  assertIprogConfiguration(config);
  const text = String(message || '').trim();
  if (!text) {
    throw new IprogSmsError('IPROG SMS message is not configured.', 'IPROG_MESSAGE_INVALID');
  }
  await postIprog(SEND_SMS_URL, {
    api_token: config.token,
    phone_number: phoneNumber,
    message: text,
  });
  return true;
}

async function verifyOtp(phoneNumber, otp) {
  const config = getIprogConfig();
  assertIprogOtpConfiguration(config);

  try {
    await postIprog(VERIFY_OTP_URL, {
      api_token: config.token,
      phone_number: phoneNumber,
      otp,
    });
    return true;
  } catch (error) {
    if (error instanceof IprogSmsError && error.code === 'IPROG_RESPONSE_REJECTED') return false;
    throw error;
  }
}

module.exports = {
  IprogSmsError,
  getIprogConfig,
  sendSms,
  sendOtp,
  verifyOtp,
};
