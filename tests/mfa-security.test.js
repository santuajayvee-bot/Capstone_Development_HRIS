const assert = require('assert');

process.env.NODE_ENV = 'test';
process.env.MFA_ENABLED = 'true';
process.env.JWT_SECRET = 'test-only-jwt-secret-that-is-longer-than-thirty-two-characters';

const {
  _base32DecodeForTest: base32Decode,
  _generateTotpCodeForTest: generateTotpCode,
  _generateTotpSecretForTest: generateTotpSecret,
  _verifyTotpCodeForTest: verifyTotpCode,
  isMfaRequiredForRole,
} = require('../services/mfaService');

for (let index = 0; index < 25; index += 1) {
  const secret = generateTotpSecret();
  assert(/^[A-Z2-7]{32}$/.test(secret), 'TOTP secret must be base32 encoded.');
  assert.strictEqual(base32Decode(secret).length, 20, 'TOTP secret must decode to 160 bits.');
}

const secret = 'JBSWY3DPEHPK3PXP';
const timestamp = 1_719_792_000_000;
const code = generateTotpCode(secret, timestamp);
assert(/^\d{6}$/.test(code), 'Generated TOTP code must contain exactly six digits.');
assert.strictEqual(verifyTotpCode(secret, code, { timestamp, windowSteps: 0 }), true);
assert.strictEqual(verifyTotpCode(secret, code, { timestamp: timestamp + 30_000, windowSteps: 0 }), false);
assert.strictEqual(verifyTotpCode(secret, code, { timestamp: timestamp + 30_000, windowSteps: 1 }), true);
assert.strictEqual(verifyTotpCode(secret, '000000', { timestamp, windowSteps: 1 }), false);

for (const role of ['system_admin', 'payroll_manager', 'payroll_officer', 'hr_admin', 'hr_manager']) {
  assert.strictEqual(isMfaRequiredForRole(role), true, `${role} must require MFA.`);
}
assert.strictEqual(isMfaRequiredForRole('employee'), false);

console.log('TOTP MFA security tests: PASS');
