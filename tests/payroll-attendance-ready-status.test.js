const assert = require('assert');
const fs = require('fs');
const path = require('path');

const payrollSource = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'payroll.js'),
  'utf8'
);

const readyStatusQueries = payrollSource.match(
  /verification_status IN \('PAYROLL_READY', 'VALIDATED'\)/g
) || [];

assert.ok(
  readyStatusQueries.length >= 3,
  'Payroll validation, dashboard, and source selection must accept both ready statuses.'
);
assert.doesNotMatch(
  payrollSource,
  /verification_status = 'PAYROLL_READY'/,
  'Payroll must not silently exclude legacy VALIDATED attendance.'
);
assert.match(
  payrollSource,
  /Keep source-backed employees with missing\/unsupported wage configuration/,
  'Payroll preview must report source-backed employees with missing wage configuration as skipped.'
);
assert.match(
  payrollSource,
  /SELECT allowances FROM employees WHERE id = \? LIMIT 1/,
  'Payroll generation must include the allowance assigned to the employee instead of silently returning zero.'
);
assert.match(
  payrollSource,
  /computeConfiguredAllowances\(pool, emp\.id, baseGross, period\.end\)/,
  'Payroll preview must resolve allowances for the employee being processed.'
);
assert.match(
  payrollSource,
  /const deductionAvailablePay = statutoryDeductionBaseAmount\(grossPay, deductionContext\)/,
  'Employee deductions must be capped against Basic Pay instead of gross pay with allowances.'
);
assert.match(
  payrollSource,
  /statutory_base_pay: Math\.max\(0, numeric\(record\.gross_pay\) - numeric\(record\.total_allowances\)\)/,
  'Approval-time deduction recalculation must exclude non-taxable allowances from the deduction base.'
);

console.log('Payroll attendance ready-status compatibility tests: PASS');
