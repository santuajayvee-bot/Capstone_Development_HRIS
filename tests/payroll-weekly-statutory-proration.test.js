const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  deductionMonthlyProjectionDivisor,
  statutoryPercentageDeductionDetails,
  usesWeeklyStatutoryProration,
  weeklyPayrollCutoffCount,
} = require('../server/statutory-percentage-deduction');

const weeklyContext = {
  payroll_frequency: 'Weekly',
  payroll_period: '2026-06-W1',
  payroll_start_date: '2026-06-01',
};

assert.strictEqual(usesWeeklyStatutoryProration(weeklyContext), true);
assert.strictEqual(usesWeeklyStatutoryProration({
  payroll_frequency: 'Monthly',
  payroll_period: '2026-06',
  payroll_start_date: '2026-06-01',
}), false);

const calendarBasedSetting = {
  proration_mode: 'Calendar-Based Payroll Date Range',
  apply_schedule: 'Every Payroll',
};

assert.strictEqual(weeklyPayrollCutoffCount({
  ...weeklyContext,
  payroll_end_date: '2026-06-06',
}), 4, 'June 2026 has four Saturday payroll cutoffs');
assert.strictEqual(deductionMonthlyProjectionDivisor(calendarBasedSetting, {
  ...weeklyContext,
  payroll_end_date: '2026-06-06',
}), 4);
assert.strictEqual(deductionMonthlyProjectionDivisor(calendarBasedSetting, {
  payroll_frequency: 'Weekly',
  payroll_start_date: '2026-08-03',
  payroll_end_date: '2026-08-08',
}), 5, 'August 2026 has five Saturday payroll cutoffs');

const philHealth = statutoryPercentageDeductionDetails({
  name: 'PhilHealth',
  employee_share_rate: 2.5,
  minimum_salary_base: 10000,
  maximum_salary_ceiling: 100000,
  maximum_contribution_cap: 2500,
  proration_mode: 'Fixed Divisor',
  fixed_divisor: 4,
}, 4163, weeklyContext);

assert.strictEqual(philHealth.divisor, 4);
assert.strictEqual(philHealth.projected_monthly_salary, 16652);
assert.strictEqual(philHealth.monthly_contribution, 416.3);
assert.strictEqual(philHealth.amount, 104.08);

const calendarPhilHealth = statutoryPercentageDeductionDetails({
  name: 'PhilHealth',
  employee_share_rate: 2.5,
  minimum_salary_base: 10000,
  maximum_salary_ceiling: 100000,
  maximum_contribution_cap: 2500,
  ...calendarBasedSetting,
}, 4163, {
  ...weeklyContext,
  payroll_end_date: '2026-06-06',
});

assert.strictEqual(calendarPhilHealth.divisor, 4);
assert.strictEqual(calendarPhilHealth.amount, 104.08);

const pagIbig = statutoryPercentageDeductionDetails({
  name: 'Pag-IBIG',
  employee_share_rate: 2,
  minimum_salary_base: 1500,
  maximum_salary_ceiling: 10000,
  maximum_contribution_cap: 200,
  proration_mode: 'Fixed Divisor',
  fixed_divisor: 4,
}, 4163, weeklyContext);

assert.strictEqual(pagIbig.divisor, 4);
assert.strictEqual(pagIbig.monthly_contribution, 200);
assert.strictEqual(pagIbig.amount, 50);

const payrollPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'pages', 'payroll.html'), 'utf8');
const payrollUi = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'payroll.js'), 'utf8');
const payrollApi = fs.readFileSync(path.join(__dirname, '..', 'server', 'payroll.js'), 'utf8');

assert.match(
  payrollPage,
  /<option value="Calendar-Based Payroll Date Range" selected>Calendar-Based Payroll Date Range<\/option><option value="Fixed Divisor">Manual Divisor<\/option>/,
  'Calendar-based proration must be the form default.'
);
assert.match(payrollUi, /delete data\.fixed_divisor;/, 'Calendar-based submissions must omit a manual divisor.');
assert.match(payrollUi, /Enter a manual divisor before saving\./, 'Manual mode must require a user-entered divisor.');
assert.match(payrollApi, /body\.proration_mode \|\| 'Calendar-Based Payroll Date Range'/, 'The API must default omitted proration modes to calendar-based.');
assert.match(payrollApi, /Manual divisor must be a positive whole number\./, 'The API must reject invalid manual divisors.');
assert.match(payrollUi, /syncWeeklyPayrollEndDate\(\);\s*validateWeeklyPayrollDates\(\);/, 'Changing the weekly start date must synchronize the end date.');
assert.match(payrollUi, /Weekly payroll range must not exceed 7 calendar days\./, 'The UI must reject oversized weekly ranges.');
assert.match(payrollUi, /Payroll end date cannot be in the future\./, 'The UI must reject future payroll end dates before previewing.');
assert.match(payrollApi, /payrollValidationError\(`\$\{label\} cannot be in the future\.`\)/, 'Payroll date validation must return safe 400 errors for future dates.');
assert.match(payrollApi, /Weekly payroll period must not exceed 7 calendar days\./, 'The API must reject oversized weekly ranges.');

console.log('Weekly statutory proration tests passed.');
