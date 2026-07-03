const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const payrollHtml = fs.readFileSync(path.join(root, 'public', 'pages', 'payroll.html'), 'utf8');
const payrollJs = fs.readFileSync(path.join(root, 'public', 'js', 'payroll.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

assert(
  /<form[^>]+id="weekly-payroll-form"[^>]+novalidate/.test(payrollHtml),
  'Payroll Run form must disable native browser validation bubbles.'
);
assert(
  payrollJs.includes('weeklyPayrollForm.noValidate = true'),
  'Payroll module must force noValidate when initialized.'
);
assert(
  payrollJs.includes("startInput.removeAttribute('max')") && payrollJs.includes("endInput.removeAttribute('min')"),
  'Payroll date validator must not leave stale native min/max constraints.'
);
assert(
  payrollJs.includes('Select a payroll start date.') && payrollJs.includes('Select a payroll end date.'),
  'Payroll date validator must show app-level missing-date messages.'
);
assert(!payrollJs.includes('reportValidity('), 'Payroll Run must not call native reportValidity().');
assert(indexHtml.includes('pages/payroll.html?v=24'), 'Payroll page include cache version must be bumped.');
assert(indexHtml.includes('js/payroll.js?v=66'), 'Payroll JS cache version must be bumped.');

console.log('Payroll Run date validation checks passed.');
