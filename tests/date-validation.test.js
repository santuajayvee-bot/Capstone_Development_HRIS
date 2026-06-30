const assert = require('assert');

const {
  databaseDateOnly,
  isStrictDateOnly,
} = require('../server/utils/dateValidation');

assert.strictEqual(isStrictDateOnly('2026-06-30'), true);
assert.strictEqual(isStrictDateOnly('06/30/2026'), false);
assert.strictEqual(isStrictDateOnly('2026-02-31'), false);

// mysql2 returns a DATE as a Date object using the configured +08:00 DB timezone.
const mysqlDate = new Date('2026-06-29T16:00:00.000Z');
assert.strictEqual(databaseDateOnly(mysqlDate), '2026-06-30');
assert.strictEqual(databaseDateOnly('2026-06-30'), '2026-06-30');

assert.throws(
  () => databaseDateOnly('Jun 30, 2026'),
  /YYYY-MM-DD/
);

console.log('Date validation regression tests passed.');
