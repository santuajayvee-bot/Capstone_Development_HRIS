const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  generateSessionBindingSecret,
  hashSessionBindingSecret,
} = require('../services/tokenService');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const controller = read('controllers/authController.js');
const authQueries = read('db/authQueries.js');
const middleware = read('server/middleware.js');
const authClient = read('public/js/auth.js');
const loginClient = read('public/js/login.js');
const appClient = read('public/js/app.js');
const migrationUp = read('migrations/sqls/20260720120000_session_token_binding-up.sql');
const migrationDown = read('migrations/sqls/20260720120000_session_token_binding-down.sql');

const firstSecret = generateSessionBindingSecret();
const secondSecret = generateSessionBindingSecret();
assert.notStrictEqual(firstSecret, secondSecret, 'Each authenticated session needs a unique binding secret.');
assert.strictEqual(hashSessionBindingSecret(firstSecret).length, 64, 'The stored binding digest must be SHA-256.');
assert.notStrictEqual(firstSecret, hashSessionBindingSecret(firstSecret), 'The raw binding secret must not be stored as its digest.');

assert(controller.includes('generateSessionBindingSecret()'), 'Login must create a per-session binding secret.');
assert(controller.includes('Session_Binding_Hash: sessionBindingHash'), 'Login must store only the binding digest.');
assert(controller.includes('sessionBinding,'), 'The raw binding secret must be returned once with the authenticated session.');
assert(authQueries.includes('Session_Binding_Hash'), 'USER_SESSION writes must persist the binding digest.');

assert(middleware.includes("req.get('x-session-binding')"), 'Protected requests must read the session-binding header.');
assert(middleware.includes('crypto.timingSafeEqual'), 'Binding digests must use timing-safe comparison.');
assert(middleware.includes("revokeSessionByJwtId(verifiedToken.jti, 'session_binding_mismatch')"), 'A swapped token must be revoked after a binding mismatch.');
assert(middleware.includes("code: 'SESSION_BINDING_MISMATCH'"), 'A binding mismatch must return a stable client error code.');
assert(middleware.includes("action: 'blocked_session_binding_mismatch'"), 'Blocked token swaps must be audited.');

assert(loginClient.includes('data.sessionBinding'), 'The login client must save the issued session binding.');
assert(authClient.includes("sessionStorage.setItem('vp_session_binding', sessionBinding)"), 'The browser must retain the session binding separately from the JWT.');
assert(authClient.includes("'X-Session-Binding': sessionBinding"), 'Authenticated API requests must include the session binding.');
assert(authClient.includes("apiFetch('/api/auth/me', { cache: 'no-store' })"), 'The browser must refresh identity from the authenticated server session.');
assert(authClient.includes("sessionStorage.setItem('vp_user', JSON.stringify(user))"), 'The cached UI identity must be replaced by the server identity.');
assert(appClient.includes('await window.authReady'), 'Routing must wait for server-side identity synchronization.');

assert(migrationUp.includes('ADD COLUMN IF NOT EXISTS Session_Binding_Hash CHAR(64)'), 'The up migration must add the session-binding digest.');
assert(migrationDown.includes('DROP COLUMN IF EXISTS Session_Binding_Hash'), 'The down migration must reverse the session-binding schema change.');

console.log('Session token binding and identity synchronization tests: PASS');
