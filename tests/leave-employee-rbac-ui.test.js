const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const server = read('server.js');
const leaveUi = read('public/js/leave.js');
const leavePage = read('public/pages/leave.html');

assert(
  server.includes("if (!hasLeavePermission(req.user, 'leave.request.view_all'))") &&
    server.includes("q += ' WHERE lr.employee_id = ?';") &&
    server.includes('p.push(req.user.employeeId);'),
  'Employee leave API access must be scoped to req.user.employeeId unless view_all permission is present.'
);

assert(
  leavePage.includes('id="leave-manager-filters"') &&
    leavePage.includes('data-leave-manager-only'),
  'Manager-only leave filters and columns must be marked for employee-mode hiding.'
);

assert(
  leaveUi.includes("classList.toggle('leave-employee-mode', employeeMode)") &&
    leaveUi.includes("document.querySelectorAll('[data-leave-manager-only]')"),
  'Leave UI must toggle employee mode and hide manager-only controls for employee accounts.'
);

assert(
  leaveUi.includes("const search = employeeMode ? ''") &&
    leaveUi.includes("const dept = employeeMode ? ''") &&
    leaveUi.includes("const source = employeeMode ? ''"),
  'Hidden manager filters must not affect employee leave results.'
);

assert(
  leaveUi.includes('<td data-leave-manager-only><strong>${leave.employee_name') &&
    leavePage.includes('<th data-leave-manager-only>Employee</th>'),
  'Employee leave table should not expose manager-style employee columns in employee mode.'
);

console.log('Leave employee RBAC UI checks: PASS');
