const assert = require('assert');

const originalFetch = global.fetch;
const originalToken = process.env.MOCEAN_API_TOKEN;
const originalBrand = process.env.MOCEAN_BRAND;
const originalCodeLength = process.env.MOCEAN_CODE_LENGTH;
const originalPinValidity = process.env.MOCEAN_PIN_VALIDITY;
const calls = [];

process.env.MOCEAN_API_TOKEN = 'test-token-not-a-real-secret';
process.env.MOCEAN_BRAND = 'LGSVHR';
process.env.MOCEAN_CODE_LENGTH = '6';
process.env.MOCEAN_PIN_VALIDITY = '300';

global.fetch = async (url, options) => {
  calls.push({ url, options });
  const body = new URLSearchParams(options.body);
  if (String(url).includes('/verify/req/sms')) {
    return new Response(JSON.stringify({ status: 0, reqid: 'test-request-id' }), { status: 200 });
  }
  assert.strictEqual(body.get('mocean-reqid'), 'test-request-id');
  assert.strictEqual(body.get('mocean-code'), '000000');
  return new Response(JSON.stringify({ status: 1, err_msg: 'Invalid code' }), { status: 200 });
};

const { checkSmsVerification, requestSmsVerification } = require('../services/moceanService');

(async () => {
  const sent = await requestSmsVerification('639171234567');
  assert.strictEqual(sent.providerRequestId, 'test-request-id');

  const requestBody = new URLSearchParams(calls[0].options.body);
  assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer test-token-not-a-real-secret');
  assert.strictEqual(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.strictEqual(requestBody.get('mocean-to'), '639171234567');
  assert.strictEqual(requestBody.get('mocean-brand'), 'LGSVHR');
  assert.strictEqual(requestBody.get('mocean-code-length'), '6');
  assert.strictEqual(requestBody.get('mocean-pin-validity'), '300');
  assert.strictEqual(requestBody.get('mocean-resp-format'), 'json');

  const valid = await checkSmsVerification('test-request-id', '000000');
  assert.strictEqual(valid, false);
  console.log('Mocean service transport tests: PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  global.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.MOCEAN_API_TOKEN; else process.env.MOCEAN_API_TOKEN = originalToken;
  if (originalBrand === undefined) delete process.env.MOCEAN_BRAND; else process.env.MOCEAN_BRAND = originalBrand;
  if (originalCodeLength === undefined) delete process.env.MOCEAN_CODE_LENGTH; else process.env.MOCEAN_CODE_LENGTH = originalCodeLength;
  if (originalPinValidity === undefined) delete process.env.MOCEAN_PIN_VALIDITY; else process.env.MOCEAN_PIN_VALIDITY = originalPinValidity;
});
