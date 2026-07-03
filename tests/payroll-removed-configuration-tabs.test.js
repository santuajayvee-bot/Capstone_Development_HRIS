const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const payrollPage = fs.readFileSync(path.join(root, 'public', 'pages', 'payroll.html'), 'utf8');
const payrollUi = fs.readFileSync(path.join(root, 'public', 'js', 'payroll.js'), 'utf8');

assert.doesNotMatch(payrollPage, /data-payroll-tab="allowances"|id="payroll-tab-allowances"/, 'Allowance configuration must not appear in the Payroll module.');
assert.doesNotMatch(payrollPage, /data-payroll-tab="employee-deductions"|id="payroll-tab-employee-deductions"/, 'Cash advance configuration must not appear in the Payroll module.');
assert.doesNotMatch(payrollPage, /id="allowance-setting-form"|id="cash-advance-form"|id="employee-loan-form"/, 'Removed configuration forms must not remain in the Payroll page.');
assert.match(payrollUi, /\['allowances', 'employee-deductions'\]\.includes\(requestedTab\) \? 'deductions'/, 'Legacy routes must redirect to the Deductions tab.');

console.log('Removed payroll configuration tab tests: PASS');
