const assert = require('assert');
const {
  computeTripPay,
  isTripBasedWageType,
  normalizeTripType,
  normalizeTripRole,
} = require('../server/services/logisticsTripPayroll');

assert.strictEqual(computeTripPay({ baseRate: 1100, multiplier: 1, additionalRate: 300 }), 1400);
assert.strictEqual(computeTripPay({ baseRate: 900, multiplier: 0.5, additionalRate: 0 }), 450);
assert.strictEqual(computeTripPay({ baseRate: 1100, multiplier: 2, additionalRate: 0 }), 2200);
assert.strictEqual(isTripBasedWageType('Per-Trip'), true);
assert.strictEqual(isTripBasedWageType('Trip-Based'), true);
assert.strictEqual(isTripBasedWageType('Logistics'), true);
assert.strictEqual(isTripBasedWageType('Hourly'), false);
assert.strictEqual(normalizeTripType('first trip'), '1st Trip');
assert.strictEqual(normalizeTripType('2nd trip'), '2nd Trip');
assert.strictEqual(normalizeTripRole('helper'), 'Helper');
assert.throws(() => computeTripPay({ baseRate: 100, multiplier: 0, additionalRate: 0 }));
console.log('logistics-trip-payroll tests passed');
