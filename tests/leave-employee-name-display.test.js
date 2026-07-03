const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const leaveJs = fs.readFileSync(path.join(root, 'public', 'js', 'leave.js'), 'utf8');
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

assert(
  serverJs.includes('employee_name: employeeName || employee.employee_code || `Employee #${employee.id}`'),
  '/api/employees reference payload must include a decrypted employee_name field.'
);
assert(
  leaveJs.includes('function leaveReadableEmployeeName(emp = {})'),
  'Leave UI must centralize readable employee name rendering.'
);
assert(
  leaveJs.includes('option.textContent = leaveEmployeeLabel(emp);'),
  'Manual leave dropdown must render employees through the safe label helper.'
);
assert(
  !leaveJs.includes('`${emp.first_name} ${emp.last_name} (${emp.employee_code})`'),
  'Manual leave dropdown must not depend only on raw first_name/last_name.'
);
assert(
  indexHtml.includes('js/leave.js?v=14'),
  'Leave JS cache version must be bumped after dropdown name changes.'
);

console.log('Leave employee name display checks passed.');
