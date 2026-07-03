const assert = require('assert');
const fs = require('fs');
const path = require('path');

const users = fs.readFileSync(path.join(__dirname, '..', 'server', 'users.js'), 'utf8');

assert(
  users.includes('function safeUserDecrypt(value)'),
  'User auth helpers must use safe decrypt fallback.'
);
assert(
  users.includes('row.employee_name = [row.first_name, row.last_name]'),
  'Linked employee profile should expose a safe display name.'
);
assert(
  !/async function getLinkedEmployeeProfile[\s\S]*?return rows\[0\] \|\| null;[\s\S]*?\n\}/.test(users),
  'Linked employee profile must not return raw encrypted employee fields.'
);
assert(
  !/row\.first_name = decryptColumnValue\(row\.first_name\)/.test(users),
  'User profile first_name decrypt must not throw on undecryptable data.'
);

console.log('Auth linked profile decrypt fallback checks passed.');
