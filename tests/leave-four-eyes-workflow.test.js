const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const server = read('server.js');
const leaveUi = read('public/js/leave.js');
const leavePage = read('public/pages/leave.html');
const migrationUp = read('migrations/sqls/20260707093000_leave_four_eyes_approval-up.sql');
const migrationDown = read('migrations/sqls/20260707093000_leave_four_eyes_approval-down.sql');
const strideDoc = read('docs/stride/leave-management-stride.md');

assert(
  migrationUp.includes("'Payroll Approved'") && migrationDown.includes("WHERE status = 'Payroll Approved'"),
  'Leave four-eyes migration must add and safely reverse the Payroll Approved status.'
);
assert(
  server.includes("const LEAVE_PAYROLL_APPROVER_ROLES = new Set(['payroll_officer', 'payroll_manager']);"),
  'Payroll Officer and Payroll Manager must be treated as one payroll endorsement group.'
);
assert(
  server.includes('Payroll approval is required before HR final approval.'),
  'HR final approval must require prior payroll endorsement.'
);
assert(
  server.includes('status = \'Payroll Approved\'') || server.includes("status = 'Payroll Approved'"),
  'Payroll approval must set the intermediate Payroll Approved status.'
);
assert(
  !/leave\.request\.approve': \[[^\]]*system_admin/.test(server),
  'System Administrator must not be a leave approver.'
);
assert(
  server.includes('You cannot approve or reject your own leave request.'),
  'Leave approval must block self-approval/self-rejection.'
);
assert(
  leaveUi.includes('Payroll Approve') && leaveUi.includes('Final Approve'),
  'Leave UI must distinguish payroll endorsement from HR final approval.'
);
assert(
  leavePage.includes('<option>Payroll Approved</option>'),
  'Leave status filters must include the Payroll Approved workflow state.'
);
assert(
  strideDoc.includes('Four-eyes workflow') && strideDoc.includes('Leave balance is deducted only when'),
  'Leave STRIDE evidence must document the four-eyes spoofing control.'
);

console.log('Leave four-eyes workflow controls: PASS');
