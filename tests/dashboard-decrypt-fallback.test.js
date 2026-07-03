const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dashboard = fs.readFileSync(path.join(__dirname, '..', 'server', 'dashboard.js'), 'utf8');

assert(
  dashboard.includes('function safeDashboardText(value)'),
  'Dashboard must use a safe decrypt helper for employee profile/name fields.'
);
assert(
  dashboard.includes('catch (_error)') && dashboard.includes("row?.employee_code"),
  'Dashboard names must fall back instead of failing the whole dashboard request.'
);
assert(
  !/const first = decryptColumnValue\(row\?\.first_name\)/.test(dashboard),
  'Dashboard employee name helper must not decrypt first_name directly.'
);
assert(
  !/profile\.first_name = decryptColumnValue\(profile\.first_name\)/.test(dashboard),
  'Dashboard profile decrypt must not throw on undecryptable first_name.'
);
assert(
  !/profile\.last_name = decryptColumnValue\(profile\.last_name\)/.test(dashboard),
  'Dashboard profile decrypt must not throw on undecryptable last_name.'
);

console.log('Dashboard decrypt fallback checks passed.');
