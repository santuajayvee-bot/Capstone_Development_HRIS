const assert = require('assert');
process.env.NODE_ENV = 'test';

const { _getEmployeeMfaProfileForTest } = require('../services/mfaService');

(async () => {
  const calls = [];
  const executor = {
    async execute(sql, params) {
      calls.push({ sql, params });
      return [[{
        Employee_ID: 64,
        MFA_TOTP_Secret_Encrypted: 'JBSWY3DPEHPK3PXP',
        MFA_TOTP_Secret_Hash: 'hash',
        MFA_TOTP_Enrolled_At: '2026-07-04 10:00:00',
      }]];
    },
  };

  const profile = await _getEmployeeMfaProfileForTest(64, executor);

  assert.strictEqual(profile.secret, 'JBSWY3DPEHPK3PXP');
  assert.strictEqual(profile.enrolledAt, '2026-07-04 10:00:00');
  assert.deepStrictEqual(calls[0].params, [64]);
  assert.match(calls[0].sql, /WHERE Employee_ID = \?/);
  assert.doesNotMatch(calls[0].sql, /\bOR\b/i);

  console.log('MFA account TOTP profile tests: PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
