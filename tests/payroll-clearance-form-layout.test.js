const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const payrollUi = fs.readFileSync(path.join(root, 'public', 'js', 'payroll.js'), 'utf8');
const mainCss = fs.readFileSync(path.join(root, 'public', 'css', 'main.css'), 'utf8');

assert.match(payrollUi, /class="payroll-clearance-form"/, 'Payroll clearance must use its dedicated form layout.');
assert.match(payrollUi, /Final Pay Inputs[\s\S]*Clearance Checklist/, 'Payroll clearance fields must be grouped for scanning.');
assert.match(payrollUi, /type="checkbox" name="\$\{field\}" value="Yes"/, 'Binary clearance checks must use toggles.');
assert.match(payrollUi, /Save Changes/, 'Payroll clearance must expose a clear save command.');
assert.match(mainCss, /\.payroll-clearance-grid\s*\{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, 'Desktop clearance fields must use a stable two-column grid.');
assert.match(mainCss, /@media \(max-width: 720px\)[\s\S]*\.payroll-clearance-grid\s*\{[\s\S]*grid-template-columns: 1fr/, 'Clearance fields must stack on mobile.');

console.log('Payroll clearance form layout tests: PASS');
