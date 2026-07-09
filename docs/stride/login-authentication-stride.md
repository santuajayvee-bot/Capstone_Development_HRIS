# Login and Authentication Module - STRIDE Threat Model

## Scope and trust boundaries

This model covers the browser login form, Google reCAPTCHA, authenticator-app TOTP MFA, the Express authentication API, MySQL account/session records, encrypted TOTP secrets, JWT access tokens, refresh-token cookies, logout, and backend RBAC enforcement.

```text
Browser
  | HTTPS: credentials, reCAPTCHA token, TOTP code
  v
Express authentication boundary
  | parameterized SQL             | server-side Siteverify
  v                               v
MySQL account/session store     Google reCAPTCHA
  |
  | encrypted TOTP secret for privileged accounts
  v
Google Authenticator / Microsoft Authenticator / compatible app
```

TOTP is the only MFA method for privileged accounts. IAM is not used as an employee account directory. The existing Argon2id account directory remains authoritative.

## STRIDE analysis

| STRIDE | Possible threat | Security controls | Implementation evidence | Verification |
|---|---|---|---|---|
| Spoofing | An attacker submits stolen or guessed credentials, automates credential stuffing, or impersonates a privileged employee. | Argon2id password verification; Google reCAPTCHA before account lookup/password hashing; mandatory TOTP MFA for privileged roles; generic login errors; account lockout. | `services/passwordService.js`, `services/recaptchaService.js`, `services/mfaService.js`, `controllers/authController.js` | `tests/password-storage-security.test.js`, `tests/recaptcha-service.test.js`, `tests/mfa-security.test.js`, `tests/auth-stride-controls.test.js` |
| Tampering | Login fields, CAPTCHA tokens, MFA challenge state, JWT claims, or session parameters are modified. | Shared server-side input validation; Google Siteverify; random server-side challenge token hashed in MySQL; TOTP verification generated server-side from encrypted secret; signed JWT with fixed HS256 verification; database-backed `jti`, token version, and revocation checks; same-origin write protection. | `validators/inputValidation.js`, `services/recaptchaService.js`, `services/mfaService.js`, `services/tokenService.js`, `server/middleware.js` | `tests/input-validation.test.js`, `tests/csrf-protection.test.js`, `tests/auth-stride-controls.test.js` |
| Repudiation | A user denies a successful login, failed login attempt, failed challenge, lockout, logout, MFA enrollment, or MFA verification. | Successful and failed login attempts are written to the System Admin Audit Trail with event type, result, timestamp, employee reference when available, masked login identifier for failed attempts, IP address, and user agent; TOTP enrollment, verification, challenge expiry, failure, and logout are also logged. Sensitive values are excluded. | `controllers/authController.js`, `db/authQueries.js`, `server/admin-rbac.js`, `public/pages/system-admin.html`, `public/js/system-admin.js`, `services/mfaService.js` | In System Admin, open Audit Trail, filter Module = Authentication or Action = Authentication; run `tests/auth-stride-controls.test.js` |
| Information Disclosure | Passwords, TOTP secrets, one-time codes, refresh tokens, or internal errors are exposed. | Passwords use Argon2id; TOTP secrets are AES-256 encrypted in `employees.MFA_TOTP_Secret_Encrypted`; TOTP codes are never stored; refresh token is HttpOnly/Secure/SameSite and stored only as a hash; API responses are no-store and generic. | `services/passwordService.js`, `services/mfaService.js`, `services/tokenService.js`, `server/error-response.js`, `migrations/sqls/20260704093000_add_totp_mfa_enrollment-up.sql` | `tests/password-storage-security.test.js`, `tests/mfa-security.test.js`, `tests/error-response.test.js`, `tests/privacy-hardening.test.js` |
| Denial of Service | Bots flood login, force expensive Argon2 work, or repeatedly try MFA codes. | reCAPTCHA is verified before database/password work; per-IP+identifier login rate limit; account lockout; five-attempt MFA limit; short challenge expiry; one active challenge per employee; no per-message SMS cost. | `server.js`, `controllers/authController.js`, `services/mfaService.js` | `tests/recaptcha-service.test.js`, `tests/auth-stride-controls.test.js`; rate-limit integration test |
| Elevation of Privilege | A Level 1 user tampers with role claims, reuses a revoked token, or reaches an admin route without completing MFA. | Roles and permissions are reloaded from MySQL on every protected request; client authority fields are rejected; privileged roles fail closed when MFA is unavailable; session `jti`, token version, password-change time, and revocation are checked; backend RBAC protects routes. | `server/middleware.js`, `controllers/authController.js`, `services/mfaService.js`, `server/admin-rbac.js` | `tests/auth-stride-controls.test.js`, `tests/payroll-piece-rate-auth.test.js`, RBAC endpoint tests |

## Implementation evidence checklist

Use this checklist during documentation, presentation, or system demonstration to show that each STRIDE control is already implemented in the login and authentication module.

| STRIDE category | Evidence that can be shown | System/code location | Demo or verification step |
|---|---|---|---|
| Spoofing | The login flow requires valid credentials, Google reCAPTCHA, account lockout after repeated failures, and TOTP MFA for privileged users. Passwords are verified using Argon2id instead of plaintext or reversible encryption. | `public/js/login.js`, `controllers/authController.js`, `services/passwordService.js`, `services/recaptchaService.js`, `services/mfaService.js` | Show the login page with reCAPTCHA, attempt privileged login and show the MFA step, then run `tests/password-storage-security.test.js`, `tests/recaptcha-service.test.js`, and `tests/mfa-security.test.js`. |
| Tampering | CAPTCHA tokens, MFA challenges, JWT sessions, and client-supplied authority fields are verified on the backend. The server checks signed tokens, `jti`, token version, revocation status, and rejects role/permission fields supplied by the client. | `services/tokenService.js`, `server/middleware.js`, `services/mfaService.js`, `validators/inputValidation.js` | Use Postman/browser dev tools to modify role/session data and show that protected API routes still reject unauthorized access. Run `tests/input-validation.test.js` and `tests/csrf-protection.test.js`. |
| Repudiation | Successful logins, failed logins, CAPTCHA failures, account lockouts, logout, MFA enrollment, MFA verification, and MFA failures are recorded in the System Admin Audit Trail. Authentication logs include timestamp, result, IP address, user agent, action type, and masked failed-login identifier. | `controllers/authController.js`, `db/authQueries.js`, `services/mfaService.js`, `server/admin-rbac.js`, `public/pages/system-admin.html`, `public/js/system-admin.js` | Login successfully, perform one failed login, then open System Admin > Audit Trail and filter Module = Authentication or Action = Authentication. Confirm `LOGIN_SUCCESS` and `LOGIN_FAILED` entries appear. |
| Information Disclosure | Password hashes use Argon2id, refresh tokens are stored as hashes, refresh-token cookies are HttpOnly/Secure/SameSite, TOTP secrets are AES-256 encrypted, TOTP setup keys are not displayed in production UI, and API errors are generic. | `services/passwordService.js`, `services/tokenService.js`, `services/mfaService.js`, `server/error-response.js`, `public/js/login.js`, `migrations/sqls/20260704093000_add_totp_mfa_enrollment-up.sql` | Inspect the database fields for `$argon2id$` password hashes and encrypted `MFA_TOTP_Secret_Encrypted` values. Show that failed login responses do not reveal whether the username or password was wrong. |
| Denial of Service | reCAPTCHA is checked before expensive password verification, login endpoints are rate-limited, repeated failed attempts trigger account lockout, MFA challenges expire, and MFA verification has a limited attempt count. | `server.js`, `controllers/authController.js`, `services/mfaService.js`, `public/js/login.js` | Trigger repeated failed logins and show the remaining-attempt/lockout message. Run `tests/recaptcha-service.test.js` and `tests/auth-stride-controls.test.js`. |
| Elevation of Privilege | Backend RBAC protects routes, roles and permissions are loaded from trusted session/database state, privileged roles require MFA before completing login, revoked sessions cannot be reused, and unauthorized admin access is logged. | `server/middleware.js`, `services/tokenService.js`, `controllers/authController.js`, `services/mfaService.js`, `server/admin-rbac.js` | Login as a Regular Employee and attempt to access a System Admin or Payroll Manager endpoint. Show the request is denied even if frontend values are changed. |

## Privileged MFA roles

MFA is mandatory for System Administrator, Payroll Manager, Payroll Officer, HR Admin, and HR Manager aliases. `MFA_REQUIRE_ALL_USERS=true` can extend MFA to Level 1 employees. A privileged login fails closed if TOTP MFA is disabled, unsupported, or not verifiable.

## TOTP deployment controls

1. Set `MFA_ENABLED=true`, `MFA_REQUIRE_ALL_USERS=false`, and `MFA_TOTP_ISSUER=LGSV HR`.
2. Keep `AES_ENCRYPTION_KEY` outside the database and set it only through production secrets.
3. Register production reCAPTCHA keys for `lgsvhr.com`; set the secret only on EC2.
4. Require each privileged user to scan the first-login QR code with Google Authenticator, Microsoft Authenticator, Authy, Bitwarden, or another RFC 6238-compatible app.
5. Reset MFA only through an administrator-reviewed recovery flow with audit logging.

## Residual risks

- TOTP depends on the user's device time being reasonably accurate. The server accepts a small adjacent-step window to tolerate clock drift.
- If a privileged user's phone is lost, recovery must be handled by an administrator and logged before generating a new TOTP secret.
- Google reCAPTCHA is an external dependency. Login intentionally fails closed when human verification is required but unavailable.
- The short-lived access token is still available to browser JavaScript for the current API client. Migrating it to an HttpOnly access-token cookie is a future defense-in-depth improvement; the refresh token is already HttpOnly and server-side sessions remain revocable.
