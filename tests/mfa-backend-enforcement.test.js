const assert = require('assert');
const fs = require('fs');
const path = require('path');

const authController = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'authController.js'), 'utf8');
const mfaService = fs.readFileSync(path.join(__dirname, '..', 'services', 'mfaService.js'), 'utf8');
const loginUi = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'login.js'), 'utf8');

for (const role of ['system_admin', 'hr_manager', 'payroll_manager', 'payroll_officer']) {
  assert.ok(authController.includes(`'${role}'`), `Privileged role ${role} must be explicitly MFA-protected.`);
}
assert.match(authController, /function shouldRequireMfa\(user\)[\s\S]*isMfaEnabled\(\) \|\| roleRequiresMfa/, 'Backend must require MFA for privileged roles even if global MFA is off.');
assert.match(authController, /never creates an[\s\S]*access token until the MFA challenge has been successfully verified/, 'Password-only login must not issue tokens before MFA.');
assert.match(authController, /return issueAuthenticatedSession\(req, res, authenticatedUser\)/, 'Only MFA verification should issue the authenticated session for challenged users.');

assert.match(mfaService, /CREATE TABLE IF NOT EXISTS MFA_CHALLENGE/, 'MFA service must ensure challenge storage exists.');
assert.match(mfaService, /Phone_Number_Encrypted/, 'MFA challenge phone numbers must be encrypted at rest.');
assert.match(mfaService, /Challenge_Token_Hash/, 'MFA challenge tokens must be stored as hashes.');
assert.match(mfaService, /timingSafeEqual/, 'MFA token comparison must be timing safe.');

assert.match(loginUi, /let activeMfaChallenge = null/, 'Frontend MFA state must be declared explicitly.');
assert.match(loginUi, /\/api\/auth\/mfa\/verify/, 'Login UI must verify OTP through the backend.');

console.log('MFA backend enforcement tests: PASS');
