const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const controller = read('controllers/authController.js');
const routes = read('routes/authRoutes.js');
const mfa = read('services/mfaService.js');
const login = read('public/js/login.js');
const server = read('server.js');
const authQueries = read('db/authQueries.js');
const adminRbac = read('server/admin-rbac.js');
const systemAdminPage = read('public/pages/system-admin.html');
const systemAdminJs = read('public/js/system-admin.js');

assert(
  controller.indexOf('verifyRecaptchaToken') < controller.indexOf('findUserByEmail(normalizedLoginIdentifier)'),
  'CAPTCHA must be verified before account lookup and Argon2 password work.'
);
assert(/router\.post\('\/logout', requireAuth, authController\.logout\)/.test(routes), 'Logout must require authentication.');
assert(/revokeSessionByJwtId\(req\.user\.jti/.test(controller), 'Logout must revoke the server-side JWT session.');
for (const role of ['system_admin', 'payroll_manager', 'payroll_officer', 'hr_admin', 'hr_manager']) {
  assert(mfa.includes(`'${role}'`), `Privileged MFA role missing: ${role}`);
}
const retiredProviderPattern = new RegExp([
  ['ip', 'rog'].join(''),
  ['s', 'ms'].join(''),
  ['MFA', '_PROVIDER'].join(''),
].join('|'), 'i');
assert(!retiredProviderPattern.test(mfa), 'MFA service must be TOTP-only and must not depend on retired provider switching.');
assert(mfa.includes("VALUES (?, 'totp', ?, 'PENDING'"), 'MFA challenges must be created as TOTP challenges.');
assert(mfa.includes("crypto.createHmac('sha1'"), 'TOTP codes must be generated with HMAC-SHA1 per RFC 6238.');
assert(mfa.includes('MFA_TOTP_Secret_Encrypted'), 'TOTP secrets must be stored encrypted at rest.');
assert(login.includes('mfa-qr-code'), 'The login client must support first-time TOTP QR enrollment.');
assert(login.includes('captchaToken'), 'The login client must submit the reCAPTCHA token.');
assert(server.includes('https://www.google.com'), 'CSP must explicitly allow Google reCAPTCHA resources.');
for (const authPath of ['/api/auth/login', '/api/auth/mfa/verify', '/api/auth/mfa/resend', '/api/auth/lockout-status']) {
  assert(server.includes(`'${authPath}'`), `Auth rate-limit path missing: ${authPath}`);
}
assert(
  controller.includes('remaining_attempts: MAX_FAILED_ATTEMPTS'),
  'Unknown lockout-status lookups must return a non-enumerating generic state.'
);
assert(controller.includes("Action_Type: 'LOGIN_SUCCESS'"), 'Successful logins must write an audit event.');
assert(controller.includes("Action_Type: 'LOGIN_FAILED'"), 'Failed logins must write an audit event.');
assert(controller.includes('auditLoginIdentifier'), 'Failed-login audit details must use a masked identifier.');
assert(authQueries.includes("'AUTH'"), 'Authentication audit rows must use the AUTH module.');
assert(adminRbac.includes("if (normalized === 'auth')"), 'System Admin audit API must support authentication filtering.');
assert(adminRbac.includes('AS action_type'), 'System Admin audit API must expose audit event type metadata.');
assert(systemAdminPage.includes('<option value="AUTH">Authentication</option>'), 'System Admin Audit Trail must expose the Authentication module filter.');
assert(systemAdminPage.includes('<option value="auth">Authentication</option>'), 'System Admin Audit Trail must expose the Authentication action filter.');
assert(systemAdminJs.includes("LOGIN_SUCCESS: 'Successful login recorded'"), 'System Admin Audit Trail must label successful login events.');
assert(systemAdminJs.includes("LOGIN_FAILED: 'Failed login attempt recorded'"), 'System Admin Audit Trail must label failed login events.');

console.log('Login and authentication STRIDE control tests: PASS');
