const assert = require('assert');
const {
  PAYROLL_SCHEDULE_LABELS,
  normalizePayrollScheduleValue,
} = require('../server/utils/payrollSchedule');

assert.deepStrictEqual(PAYROLL_SCHEDULE_LABELS, [
  'Monthly',
  'Semi-Monthly',
  'Bi-Weekly',
  'Weekly',
]);

for (const input of ['Monthly', 'monthly', ' monthly ']) {
  assert.strictEqual(normalizePayrollScheduleValue(input), 'Monthly');
}

for (const input of ['Semi-Monthly', 'Semi-monthly', 'semi_monthly', 'semimonthly']) {
  assert.strictEqual(normalizePayrollScheduleValue(input), 'Semi-Monthly');
}

for (const input of ['Bi-Weekly', 'Bi-weekly', 'bi_weekly', 'biweekly']) {
  assert.strictEqual(normalizePayrollScheduleValue(input), 'Bi-Weekly');
}

assert.strictEqual(normalizePayrollScheduleValue('Weekly'), 'Weekly');
assert.strictEqual(normalizePayrollScheduleValue('fortnightly'), null);
assert.strictEqual(normalizePayrollScheduleValue(''), null);
assert.strictEqual(normalizePayrollScheduleValue(null), null);

console.log('Payroll schedule normalization tests: PASS');
