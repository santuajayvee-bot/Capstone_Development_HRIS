const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'scripts', 'update-mfa-phone-numbers.js'), 'utf8');
const seed = fs.readFileSync(path.join(root, 'database', 'seed-users.js'), 'utf8');

const expectedMappings = [
  ['hr.admin', '09192017325'],
  ['sys.admin', '09085528852'],
  ['payroll.officer', '09913845895'],
];

for (const [username, phoneNumber] of expectedMappings) {
  assert(script.includes(`username: '${username}'`), `Missing ${username} in MFA update script`);
  assert(script.includes(`phoneNumber: '${phoneNumber}'`), `Missing ${phoneNumber} in MFA update script`);
  assert(seed.includes(phoneNumber), `Missing ${phoneNumber} in seed users`);
}

assert(script.includes('encryptColumnValue'), 'MFA update script must encrypt contact numbers before saving');
assert(script.includes('decryptColumnValue'), 'MFA update script must verify encrypted contact numbers');
assert(script.includes('normalizePhilippineMobileNumber'), 'MFA update script must validate PH mobile numbers');
assert(script.includes('maskPhoneNumber'), 'MFA update script must mask phone numbers in output/audit logs');
assert(script.includes("process.argv.includes('--apply')"), 'MFA update script must require explicit --apply');
assert(script.includes('INSERT INTO system_audit_log'), 'MFA update script must create an audit log');
assert(!script.includes('UPDATE users SET'), 'MFA update script must not modify account roles or credentials');
assert(!script.includes('password_hash'), 'MFA update script must not modify passwords');

console.log('MFA phone-number update script checks passed.');
