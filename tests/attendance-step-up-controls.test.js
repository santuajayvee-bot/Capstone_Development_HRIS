const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const attendanceApi = read('server/attendance.js');
const attendanceUi = read('public/js/attendance.js');
const attendanceStrideDoc = read('docs/stride/attendance-management-stride.md');

assert(
  attendanceApi.includes("const { verifyPassword } = require('../services/passwordService');"),
  'Attendance step-up authentication must use the shared Argon2id password verifier.'
);
assert(
  attendanceApi.includes("'currentPassword'") && attendanceApi.includes("'current_password'"),
  'Attendance verification allowlist must accept currentPassword without rejecting the request.'
);
assert(
  attendanceApi.includes("['PAYROLL_READY', 'REJECTED'].includes(verificationStatus)"),
  'Attendance validate/reject actions must require step-up authentication.'
);
assert(
  attendanceApi.includes('attendance_step_up_authentication_failed'),
  'Failed attendance step-up authentication must be audited.'
);
assert(
  attendanceApi.includes('attendance_step_up_authentication_verified'),
  'Successful attendance step-up authentication must be audited.'
);
assert(
  attendanceUi.includes('requestAttendanceStepUpPassword') && attendanceUi.includes('type="password"'),
  'Attendance UI must collect a masked current password before validate/reject.'
);
assert(
  attendanceUi.includes('currentPassword') && attendanceUi.includes("verification_status: verificationStatus, reason, currentPassword"),
  'Attendance UI must send currentPassword to the verification API.'
);
assert(
  attendanceStrideDoc.includes('step-up password re-authentication') && attendanceStrideDoc.includes('Try the API without `currentPassword` and show `401`.'),
  'Attendance STRIDE evidence must document step-up authentication.'
);

console.log('Attendance step-up controls: PASS');
