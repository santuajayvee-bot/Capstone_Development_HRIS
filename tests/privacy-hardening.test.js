const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { sanitizeStorageCiphertext } = require('../server/privacy-protection');

const ciphertext = `${'a'.repeat(32)}:${'b'.repeat(32)}:${'c'.repeat(16)}`;
const state = { blocked: 0 };
const sanitized = sanitizeStorageCiphertext({
  id: 1,
  email_encrypted: ciphertext,
  nested: { value: ciphertext, safe: 'visible' },
}, state);

assert.deepStrictEqual(sanitized, { id: 1, nested: { value: null, safe: 'visible' } });
assert.strictEqual(state.blocked, 2);

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const onboarding = fs.readFileSync(path.join(root, 'server', 'onboarding.js'), 'utf8');
const selfService = fs.readFileSync(path.join(root, 'server', 'self-service.js'), 'utf8');
const leaveClient = fs.readFileSync(path.join(root, 'public', 'js', 'leave.js'), 'utf8');
const sensitiveMigration = fs.readFileSync(
  path.join(root, 'migrations', '20260628210000-sensitive-data-hardening.js'),
  'utf8'
);

assert.match(server, /uploadSensitiveSingle\('attachment'\)/);
assert.match(server, /employee_sensitive_fields_revealed/);
assert.match(server, /leave_sensitive_details_revealed/);
assert.match(server, /revealSensitive:\s*true/);
assert.match(server, /function visibleEmployeeDetail\(row\)/);
assert.match(onboarding, /applicants\/:applicantId\/reveal-sensitive/);
assert.match(selfService, /old_value_encrypted, new_value_encrypted/);
assert.doesNotMatch(selfService, /newValue:\s*\{\s*field,\s*value,/);
assert.doesNotMatch(leaveClient, /prompt\s*\(/);
assert.match(sensitiveMigration, /LOWER\(TABLE_NAME\)\s*=\s*LOWER\(\?\)/);
assert.match(sensitiveMigration, /modifyColumn\(connection,\s*'documents',\s*'file_path',\s*'VARCHAR\(500\) NULL'\)/);
assert.match(sensitiveMigration, /modifyColumn\(connection,\s*'user_profile_change_requests',\s*column,\s*'TEXT NULL'\)/);
assert.match(sensitiveMigration, /EMPLOYEE_PII_COLUMN_DEFINITIONS\.email\s*=\s*'VARCHAR\(768\) NULL'/);
assert.match(sensitiveMigration, /tableExists\(connection, 'users'\)\s*&&\s*await columnExists\(connection, 'users', 'email'\)/);
assert.match(sensitiveMigration, /requiredColumns = \[primaryKey, nameColumn, pathColumn, encryptedNameColumn, encryptedPathColumn, encryptedLegacyPathColumn\]/);

console.log('Privacy hardening tests: PASS');
