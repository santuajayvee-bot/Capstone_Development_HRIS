const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const payrollJs = fs.readFileSync(path.join(root, 'public', 'js', 'payroll.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

assert(
  payrollJs.includes('function payrollLooksEncryptedText(value)'),
  'Payroll UI must detect AES-GCM ciphertext-shaped employee values.'
);
assert(
  payrollJs.includes('function payrollReadableEmployeeName(employee = {})'),
  'Payroll UI must centralize safe employee display name rendering.'
);
assert(
  !payrollJs.includes("row.employee_name || row.first_name || row.last_name"),
  'Payroll attendance employee dropdown must not fall back to raw encrypted name fields.'
);
assert(
  !payrollJs.includes("String(a.last_name || '').localeCompare"),
  'Payroll employee sorting must not use raw encrypted last_name values.'
);
assert(
  !payrollJs.includes("String(a.first_name || '').localeCompare"),
  'Payroll employee sorting must not use raw encrypted first_name values.'
);
assert(
  indexHtml.includes('js/payroll.js?v=66'),
  'Payroll JS cache version must be bumped after employee label safety changes.'
);

console.log('Payroll employee label safety checks passed.');
