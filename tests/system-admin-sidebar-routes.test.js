const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const auth = fs.readFileSync(path.join(root, 'public', 'js', 'auth.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

[
  "label: 'System Health'",
  "label: 'Support Center'",
  "label: 'Backup and Restore'",
  "params: { sysAdminTab: 'health' }",
  "params: { sysAdminTab: 'support' }",
  "params: { sysAdminTab: 'backups' }",
].forEach(expected => {
  assert(auth.includes(expected), `System Admin sidebar must include ${expected}.`);
});

[
  "'/admin/health': { page: 'system-admin', params: { sysAdminTab: 'health' } }",
  "'/admin/support': { page: 'system-admin', params: { sysAdminTab: 'support' } }",
  "'/admin/backups': { page: 'system-admin', params: { sysAdminTab: 'backups' } }",
].forEach(expected => {
  assert(app.includes(expected), `App router must include ${expected}.`);
});

assert(index.includes('js/auth.js?v=28'), 'Index must bump auth.js cache version.');
assert(index.includes('js/app.js?v=19'), 'Index must bump app.js cache version.');

console.log('System Admin sidebar route checks: PASS');
