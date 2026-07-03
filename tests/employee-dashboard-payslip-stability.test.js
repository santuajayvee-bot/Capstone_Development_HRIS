const assert = require('assert');
const fs = require('fs');
const path = require('path');

const frontend = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'employee-dashboard.js'), 'utf8');
const realtime = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'attendance-realtime.js'), 'utf8');

const loadDashboardBody = frontend.match(/async function loadEmpDashboard\(\) \{([\s\S]*?)\n\}/);
assert(loadDashboardBody, 'Employee dashboard loader must exist.');
assert(
  !/resetEmpDashboardPayslipUi\(\);[\s\S]*apiFetch\('\/api\/employee\/dashboard'\)/.test(loadDashboardBody[1]),
  'Latest payslip card must not be hidden before a background dashboard refresh completes.'
);
assert.match(
  loadDashboardBody[1],
  /else \{\s*resetEmpDashboardPayslipUi\(\);\s*\}/,
  'Latest payslip card should still clear when the API confirms there is no payslip.'
);
assert.match(
  realtime,
  /page === 'employee-dashboard'[\s\S]*initEmployeeDashboard\(\)/,
  'Attendance realtime refresh still updates the active employee dashboard.'
);

console.log('Employee dashboard payslip stability tests: PASS');
