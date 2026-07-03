const assert = require('assert');
const fs = require('fs');
const path = require('path');

const leaveSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'leave.js'),
  'utf8'
);

const setupLeaveUi = leaveSource.match(
  /function setupLeaveUi\(\) \{([\s\S]*?)\n\}/
)?.[1] || '';

assert.match(
  setupLeaveUi,
  /const currentEmployeeId = employeeSelect\.value;/,
  'Refreshing leave data must capture the selected manual employee before rebuilding options.'
);
assert.match(
  setupLeaveUi,
  /employeeSelect\.value = currentEmployeeId;/,
  'Refreshing leave data must restore the selected manual employee.'
);
assert.match(
  leaveSource,
  /requestId !== MANUAL_BALANCE_PREVIEW_REQUEST_ID/,
  'Stale manual balance requests must not overwrite the current preview.'
);
assert.match(
  leaveSource,
  /leaveBalancePreviewBound/,
  'Leave balance change listeners must be bound only once.'
);

console.log('Leave employee selection persistence tests: PASS');
