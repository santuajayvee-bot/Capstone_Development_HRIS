const assert = require('assert');

const originalFetch = global.fetch;
const originalToken = process.env.IPROG_API_TOKEN;
const originalExpires = process.env.IPROG_OTP_EXPIRES_IN_MINUTES;
const originalMessage = process.env.IPROG_OTP_MESSAGE;
const calls = [];

process.env.IPROG_API_TOKEN = 'test-token-not-a-real-secret';
process.env.IPROG_OTP_EXPIRES_IN_MINUTES = '5';
process.env.IPROG_OTP_MESSAGE = 'Your LGSV HR verification code is :otp. It is valid for 5 minutes. Do not share this code with anyone.';

global.fetch = async (url, options) => {
  calls.push({ url, options });
  if (String(url).includes('/sms_messages')) {
    const body = JSON.parse(options.body);
    assert.strictEqual(body.phone_number, '09913845895');
    assert.strictEqual(body.message, 'Your LGSV HR verification code is 367821.');
    return new Response(JSON.stringify({ status: 200, message: 'SMS queued' }), { status: 200 });
  }

  if (String(url).includes('/otp/send_otp')) {
    return new Response(JSON.stringify({ success: true, message: 'OTP sent' }), { status: 200 });
  }

  const body = JSON.parse(options.body);
  assert.strictEqual(body.phone_number, '09913845895');
  if (body.otp === '000000') {
    return new Response(JSON.stringify({ success: false, message: 'Invalid OTP' }), { status: 200 });
  }
  assert.strictEqual(body.otp, '123456');
  return new Response(JSON.stringify({ success: true, message: 'OTP verified' }), { status: 200 });
};

const { sendSms, sendOtp, verifyOtp } = require('../services/iprogSmsService');
const { maskPhoneNumber, normalizePhilippineMobileNumber } = require('../utils/phoneNumberUtil');

(async () => {
  assert.strictEqual(normalizePhilippineMobileNumber('09913845895'), '09913845895');
  assert.strictEqual(normalizePhilippineMobileNumber('+639913845895'), '09913845895');
  assert.strictEqual(normalizePhilippineMobileNumber('639913845895'), '09913845895');
  assert.strictEqual(normalizePhilippineMobileNumber('12345'), null);
  assert.strictEqual(maskPhoneNumber('09913845895'), '*******5895');

  await sendOtp('09913845895');
  const requestBody = JSON.parse(calls[0].options.body);
  assert.strictEqual(calls[0].options.headers['Content-Type'], 'application/json');
  assert.strictEqual(requestBody.api_token, 'test-token-not-a-real-secret');
  assert.strictEqual(requestBody.phone_number, '09913845895');
  assert.strictEqual(requestBody.expires_in_minutes, 5);
  assert.ok(requestBody.message.includes(':otp'));

  await sendSms('09913845895', 'Your LGSV HR verification code is 367821.');
  assert.ok(String(calls[1].url).includes('/sms_messages'));

  const valid = await verifyOtp('09913845895', '000000');
  assert.strictEqual(valid, false);
  const verified = await verifyOtp('09913845895', '123456');
  assert.strictEqual(verified, true);
  console.log('IPROG SMS and phone-number tests: PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  global.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.IPROG_API_TOKEN; else process.env.IPROG_API_TOKEN = originalToken;
  if (originalExpires === undefined) delete process.env.IPROG_OTP_EXPIRES_IN_MINUTES; else process.env.IPROG_OTP_EXPIRES_IN_MINUTES = originalExpires;
  if (originalMessage === undefined) delete process.env.IPROG_OTP_MESSAGE; else process.env.IPROG_OTP_MESSAGE = originalMessage;
});
