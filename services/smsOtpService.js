const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const PHILSMS_SEND_URL = 'https://app.philsms.com/api/v3/sms/send';
const MFA_TOKEN_EXPIRES_IN = '5m';
const MFA_TOKEN_PURPOSE = 'sms_mfa';
const OTP_EXPIRES_MS = 5 * 60 * 1000;
const OTP_DIGITS = 6;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_VERIFY_ATTEMPTS = 5;
const PHILSMS_TIMEOUT_MS = 10000;

class SmsOtpError extends Error {
  constructor(message, code = 'SMS_OTP_ERROR') {
    super(message);
    this.name = 'SmsOtpError';
    this.code = code;
    this.smsOtpFailed = true;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getTempTokenSecret() {
  const secret = process.env.MFA_TEMP_TOKEN_SECRET;
  if (!isNonEmptyString(secret)) {
    throw new SmsOtpError('MFA temporary token secret is not configured.', 'MFA_TEMP_SECRET_MISSING');
  }
  return secret;
}

function assertMfaTempTokenReady() {
  getTempTokenSecret();
}

function getPhilSmsConfig() {
  return {
    apiKey: process.env.PHILSMS_API_KEY,
    senderId: process.env.PHILSMS_SENDER_ID,
  };
}

function assertPhilSmsReady() {
  const config = getPhilSmsConfig();
  if (!isNonEmptyString(config.apiKey)) {
    throw new SmsOtpError('PhilSMS API key is not configured.', 'PHILSMS_API_KEY_MISSING');
  }

  if (!isNonEmptyString(config.senderId)) {
    throw new SmsOtpError('PhilSMS sender ID is not configured.', 'PHILSMS_SENDER_ID_MISSING');
  }

  return {
    apiKey: config.apiKey.trim(),
    senderId: config.senderId.trim(),
  };
}

function normalizePhoneNumber(phoneNumber) {
  if (!isNonEmptyString(phoneNumber)) {
    throw new SmsOtpError('MFA phone number is missing.', 'MFA_PHONE_MISSING');
  }

  let digits = phoneNumber.trim().replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);

  if (/^09\d{9}$/.test(digits)) return `63${digits.slice(1)}`;
  if (/^9\d{9}$/.test(digits)) return `63${digits}`;
  if (/^639\d{9}$/.test(digits)) return digits;

  throw new SmsOtpError('MFA phone number must be a valid Philippine mobile number.', 'MFA_PHONE_INVALID');
}

function normalizeOtpCode(code) {
  if (!isNonEmptyString(code)) {
    throw new SmsOtpError('MFA code is missing.', 'MFA_CODE_MISSING');
  }

  const normalized = code.trim();
  if (!new RegExp(`^\\d{${OTP_DIGITS}}$`).test(normalized)) {
    throw new SmsOtpError('MFA code format is invalid.', 'MFA_CODE_INVALID_FORMAT');
  }

  return normalized;
}

function redactPhoneNumber(phoneNumber) {
  const text = normalizePhoneNumber(phoneNumber);
  return `${text.slice(0, 4)}***${text.slice(-2)}`;
}

function generateOtpCode() {
  return String(crypto.randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, '0');
}

function getOtpExpiryDate() {
  return new Date(Date.now() + OTP_EXPIRES_MS);
}

function hashOtp(phoneNumber, otpCode) {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  const normalizedCode = normalizeOtpCode(otpCode);
  return crypto
    .createHmac('sha256', getTempTokenSecret())
    .update(`${normalizedPhone}:${normalizedCode}`)
    .digest('hex');
}

function verifyOtpHash(phoneNumber, otpCode, expectedHash) {
  if (!isNonEmptyString(expectedHash)) return false;
  const actual = Buffer.from(hashOtp(phoneNumber, otpCode), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function sendOtpSms(phoneNumber, otpCode) {
  const config = assertPhilSmsReady();
  const recipient = normalizePhoneNumber(phoneNumber);
  const code = normalizeOtpCode(otpCode);

  // PhilSMS sends the SMS only. LGSV HR owns OTP generation, hashing,
  // expiry, attempt counting, and verification in the backend.
  try {
    const response = await axios.post(
      PHILSMS_SEND_URL,
      {
        recipient,
        sender_id: config.senderId,
        type: 'plain',
        message: `Your LGSV HR verification code is ${code}. This code expires in 5 minutes.`,
      },
      {
        timeout: PHILSMS_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }
    );

    return response.data;
  } catch (error) {
    const smsError = new SmsOtpError('PhilSMS SMS request failed.', 'PHILSMS_SEND_FAILED');
    smsError.status = error.response?.status || null;
    smsError.payload = error.response?.data || null;
    throw smsError;
  }
}

function createMfaTempToken(payload) {
  const userId = payload?.userId;
  const employeeId = payload?.employeeId;

  if (!userId || !employeeId) {
    throw new SmsOtpError('MFA token payload is incomplete.', 'MFA_TOKEN_PAYLOAD_INVALID');
  }

  return jwt.sign(
    {
      purpose: MFA_TOKEN_PURPOSE,
      userId,
      employeeId,
      role: payload.role || null,
      method: 'sms',
    },
    getTempTokenSecret(),
    {
      algorithm: 'HS256',
      expiresIn: MFA_TOKEN_EXPIRES_IN,
    }
  );
}

function verifyMfaTempToken(token) {
  if (!isNonEmptyString(token)) {
    throw new SmsOtpError('MFA temporary token is missing.', 'MFA_TOKEN_MISSING');
  }

  try {
    const payload = jwt.verify(token, getTempTokenSecret(), { algorithms: ['HS256'] });
    if (payload?.purpose !== MFA_TOKEN_PURPOSE || payload?.method !== 'sms' || !payload?.userId) {
      throw new SmsOtpError('MFA temporary token is invalid.', 'MFA_TOKEN_INVALID');
    }
    return payload;
  } catch (error) {
    if (error.smsOtpFailed) throw error;
    throw new SmsOtpError('MFA temporary token is invalid or expired.', 'MFA_TOKEN_INVALID');
  }
}

function secondsSince(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - date.getTime()) / 1000);
}

function getResendWaitSeconds(user) {
  const elapsed = secondsSince(user?.otp_last_sent_at);
  return Math.max(0, RESEND_COOLDOWN_SECONDS - elapsed);
}

function assertCanResend(user) {
  if (!user || !user.id) {
    throw new SmsOtpError('MFA account is not available.', 'MFA_ACCOUNT_MISSING');
  }

  const waitSeconds = getResendWaitSeconds(user);
  if (waitSeconds > 0) {
    const error = new SmsOtpError('MFA resend cooldown is active.', 'MFA_RESEND_COOLDOWN');
    error.waitSeconds = waitSeconds;
    throw error;
  }
}

function assertCanVerify(user) {
  if (!user || !user.id) {
    throw new SmsOtpError('MFA account is not available.', 'MFA_ACCOUNT_MISSING');
  }

  if (!user.otp_hash || !user.otp_expires_at) {
    throw new SmsOtpError('MFA OTP is not available.', 'MFA_OTP_MISSING');
  }

  if (new Date(user.otp_expires_at) <= new Date()) {
    throw new SmsOtpError('MFA OTP expired.', 'MFA_OTP_EXPIRED');
  }

  if (Number(user.otp_attempt_count || 0) >= MAX_VERIFY_ATTEMPTS) {
    throw new SmsOtpError('MFA verify attempt limit reached.', 'MFA_VERIFY_LIMIT');
  }
}

function getMfaPolicy() {
  return {
    tempTokenExpiresIn: MFA_TOKEN_EXPIRES_IN,
    otpExpiresSeconds: OTP_EXPIRES_MS / 1000,
    resendCooldownSeconds: RESEND_COOLDOWN_SECONDS,
    maxVerifyAttempts: MAX_VERIFY_ATTEMPTS,
  };
}

module.exports = {
  SmsOtpError,
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
};
