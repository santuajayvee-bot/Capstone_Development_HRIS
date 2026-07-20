# LGSV HR Authentication Architecture and Token Revocation Evidence

## Panel Question 24

**How are TLS, MFA, cookies, and session tokens secured as one authentication architecture? What type of MFA is used, how long are codes valid, how are secrets protected, and why did logout or session expiration fail to revoke the reused token?**

## Direct Answer

LGSV HR uses a layered authentication architecture:

```text
Browser
  -> HTTPS through Nginx on AWS EC2
  -> reCAPTCHA and rate-limited login
  -> Argon2id password verification
  -> trusted-device risk check
  -> TOTP authenticator MFA for privileged roles
  -> short/controlled JWT access session
  -> server-side USER_SESSION validation and revocation
  -> backend RBAC and ownership checks
```

MFA is **Time-Based One-Time Password (TOTP)** compatible with Google Authenticator, Microsoft Authenticator, Authy, Bitwarden, and other RFC 6238 applications. It is not SMS- or email-based MFA.

The current implementation can immediately reject a reused access token after a successful server-side logout because every protected API request checks the JWT's `jti` against `USER_SESSION.Revoked_At`. However, the browser currently clears its local session even if the logout request times out or fails. In that situation, the server session may remain active, and a previously copied token can still work until its JWT expiration. The production access-token lifetime is currently configured as eight hours, which increases this residual window.

## End-to-End Authentication Flow

1. The browser connects to `https://lgsvhr.com` through Nginx on AWS EC2.
2. HTTP requests are redirected to HTTPS, and HSTS instructs supported browsers to continue using HTTPS.
3. The login endpoint applies reCAPTCHA, authentication rate limiting, and account-lockout controls.
4. The backend verifies the password using Argon2id.
5. The backend evaluates whether the browser is a trusted device or requires device approval.
6. A privileged account must complete TOTP MFA before any access token is issued.
7. After successful MFA, the backend creates a signed JWT access token with a unique `jti` and creates a matching `USER_SESSION` row.
8. The backend also creates an opaque random refresh token, stores only its SHA-256 hash in `USER_SESSION`, and sends the original value in a protected cookie.
9. The browser sends the access JWT in the `Authorization: Bearer` header for API calls.
10. On every protected request, the backend verifies the JWT signature and expiration, reloads the account and role from the database, and verifies the server-side session, account state, token version, password-change timestamp, RBAC permission, and ownership scope.
11. Logout sets `USER_SESSION.Revoked_At`, records the revocation reason, updates the device session, clears the refresh-token cookie, and removes browser session data.

No access JWT is issued after password verification alone when MFA is required.

## TLS Protection

The production domain uses HTTPS terminated by Nginx on AWS EC2 with a certificate for `lgsvhr.com`. Nginx forwards the original protocol to Express using `X-Forwarded-Proto`.

The application adds these relevant response protections:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains`;
- `X-Content-Type-Options: nosniff`;
- `X-Frame-Options: DENY`;
- `Referrer-Policy: same-origin`;
- a Content Security Policy; and
- `Cache-Control: no-store` for API responses.

Production tests successfully negotiated both TLS 1.3 and TLS 1.2 with valid certificate verification. Therefore, the current accurate statement is that TLS 1.3 is supported, but the public server is not TLS-1.3-only because TLS 1.2 is also accepted.

TLS protects credentials, TOTP codes, cookies, and bearer tokens while they travel over the network. It does not replace password hashing, MFA, cookie controls, or server-side token revocation.

## MFA Design

### MFA Type

```text
Method:       TOTP / RFC 6238
Algorithm:    HMAC-SHA1, as specified in the enrolled otpauth profile
Digits:       6
Period:       30 seconds
Secret size:  20 random bytes / 160 bits, Base32 encoded
Issuer:       LGSV HR
```

Use of HMAC-SHA1 here is part of the standard TOTP profile and is not the same as storing passwords with SHA-1. Passwords remain protected with Argon2id.

### Who Must Use MFA

MFA is enforced for these privileged roles:

- System Administrator;
- Payroll Manager;
- Payroll Officer;
- HR Admin; and
- HR Manager.

Regular Employee accounts require MFA only if the production setting is changed to require it for all users.

### Code and Challenge Validity

Each authenticator code changes every **30 seconds**. Production allows a window of one step before and one step after the current step for clock drift. Consequently, the server considers the previous, current, and next 30-second steps during verification, representing a maximum three-step or 90-second acceptance window around the server clock.

The login MFA challenge is a separate control and expires after **300 seconds or five minutes**. A valid TOTP code must be submitted while this challenge remains pending. A newer challenge supersedes an older pending challenge, a verified challenge cannot be reused, and verification is limited to five failed attempts.

### MFA Secret Protection

The TOTP secret is:

1. generated from 20 cryptographically random bytes;
2. shown as an `otpauth` QR code only during enrollment;
3. encrypted with AES-256-GCM before storage in `employees.MFA_TOTP_Secret_Encrypted`;
4. accompanied by a SHA-256 hash for integrity/reference purposes; and
5. decrypted only on the backend when verifying an MFA code.

The MFA challenge contains a separate random token. Only the SHA-256 hash of that challenge token is stored in `MFA_CHALLENGE`, preventing a database read from revealing a usable challenge token.

## Access Token Security

The access token is a signed JWT:

```text
Signing algorithm:  HS256
Production lifetime: 8 hours
Unique identifier:  jti
Browser storage:     sessionStorage
Transport:           Authorization: Bearer <token> over HTTPS
```

The token contains identity and authorization context, but the backend does not blindly trust stale role claims. Protected requests reload current account status, role, access level, permissions, and employee linkage from the database.

The middleware rejects a token when:

- its signature is invalid;
- its JWT `exp` has passed;
- its `jti` has no matching `USER_SESSION` row;
- the matching session is revoked or expired;
- the account or employee is inactive;
- the token predates a password change; or
- its `tokenVersion` no longer matches the user record.

Although the token service defaults to 15 minutes when no environment override is present, production currently sets `JWT_EXPIRES_IN=8h`. The production deployment should use `JWT_ACCESS_EXPIRES_IN=15m` to meet the project's short-lived access-token requirement.

Because the access token is stored in `sessionStorage`, browser JavaScript can read it. This limits persistence to the current browser tab/session but does not provide the XSS resistance of an HttpOnly cookie. The Content Security Policy and output controls reduce risk, but moving the access token to a carefully designed HttpOnly cookie architecture would provide stronger token-theft protection.

## Refresh Token Cookie

The refresh token is an opaque 64-byte random value. Only its SHA-256 hash is stored in `USER_SESSION`. The browser receives it under the `refreshToken` cookie with:

```text
HttpOnly:  true
Secure:    true in production
SameSite:  Strict
Path:      /api/auth
Lifetime:  7 days by default
```

`HttpOnly` prevents browser JavaScript from reading the token, `Secure` restricts it to HTTPS, `SameSite=Strict` reduces cross-site request risk, and the restricted path limits where the browser sends it.

The current route set issues and clears this refresh cookie but does not expose a completed `/api/auth/refresh` route. The architecture should either implement refresh-token rotation through such an endpoint or stop issuing an unused refresh token. A refresh endpoint must rotate both the opaque token and access-token `jti` and reject reuse of the previous refresh token.

## Server-Side Session Revocation

Every successful login creates a `USER_SESSION` row containing:

- employee identifier;
- SHA-256 refresh-token hash;
- access-token `jti`;
- IP address and user agent;
- creation, activity, and expiration timestamps; and
- revocation timestamp and reason.

On a successful logout, the backend executes a database update equivalent to:

```sql
UPDATE USER_SESSION
SET Revoked_At = NOW(), Revocation_Reason = 'user_logout'
WHERE JWT_ID = ? AND Revoked_At IS NULL;
```

Any later use of the same access token against a protected endpoint should return HTTP `401` because the middleware finds `Revoked_At` for its `jti`.

Production currently contains server-side `user_logout` revocation records, proving that the revocation path has executed successfully for some sessions.

## Why a Reused Token Could Still Work

The observed behavior can occur for the following implementation-specific reasons:

1. **Client-side logout is allowed to finish without confirmed server revocation.** The browser gives the logout API three seconds. If the request times out or the server/network is unavailable, the error is ignored and `sessionStorage` is still cleared.
2. **Clearing browser storage does not revoke a copied JWT.** It removes the browser's copy only. A token copied before local logout remains cryptographically valid unless the server session was revoked.
3. **Production access tokens last eight hours.** If server revocation did not occur, the token can remain usable until its `exp` value.
4. **There is no server-enforced inactivity timeout.** `USER_SESSION.Last_Activity` exists, but the primary authentication middleware does not currently reject a session based on inactivity or continuously update that field.
5. **Closing a tab is not a reliable logout event.** The server cannot depend on a browser close event to revoke a token; server-side idle and absolute expiration policies are required.
6. **The test may have targeted a public endpoint.** Revocation can only be demonstrated using an endpoint protected by `requireAuth`.

If the logout endpoint returned HTTP `200` and reported that a session was revoked, but the exact same token was still accepted by a protected API, that would be a security defect. The expected test result is HTTP `401` after logout.

## Cross-Account Token-Swap Finding

Testing two Regular Employee accounts by manually exchanging their access tokens demonstrates an additional limitation of the current bearer-token design. An access token is the credential presented to the API. Therefore, when Employee A's still-valid token is inserted into Employee B's browser session, the server authenticates that request as **Employee A**, regardless of which person or browser is presenting it.

This result must be interpreted in two separate ways:

1. If `/api/auth/me` identifies the request as Employee A and all attendance, 201-file, leave, and payslip responses contain only Employee A's records, the ownership controls are working, but the copied bearer token is replayable.
2. If Employee A's token can retrieve Employee B's records by supplying Employee B's identifier, or if `/api/auth/me` reports Employee B while A's token is used, that is broken object-level authorization or IDOR and must be treated as a critical defect.

The inspected self-service implementation derives the employee identifier from the authenticated server context (`req.user.employeeId`) rather than trusting an employee identifier supplied by the browser. The employee dashboard, personal attendance, 201-file, leave, and payslip queries are scoped using that value. The project's static self-service RBAC, payroll authorization, profile masking, and HR compensation-access tests currently pass. These checks support ownership enforcement, but they do not replace a real two-account integration test against production.

The token-swap test can still succeed as bearer replay because the access token is stored in `sessionStorage`, sent through the `Authorization` header, remains valid for up to eight hours in the current production configuration, and is not cryptographically bound to the original browser or device. Trusted-device approval is evaluated during login, but the primary `requireAuth` middleware does not require proof from the approved device on every later API request.

### Required Two-Account Verification

1. Log in as Employee A and Employee B in separate browser profiles and record each access token only in a controlled test environment.
2. Call `GET /api/auth/me` with token A and require Employee A's account and employee identifier.
3. Call Employee A's dashboard, attendance, 201-file, leave, and payslip endpoints with token A and confirm that every returned record belongs to Employee A.
4. Attempt to request Employee B's records while using token A. The API must ignore a client-supplied employee identifier for self-service routes or return HTTP `403`.
5. Log out Employee A and require a successful server response.
6. Reuse token A against `GET /api/auth/me`. The required result is HTTP `401`.
7. Repeat the test in the opposite direction using token B.

This test must use protected API responses as evidence, not only the name displayed by the frontend, because cached browser content can create a misleading result.

## Required Remediation

1. Set production access-token lifetime to `JWT_ACCESS_EXPIRES_IN=15m`.
2. Do not silently treat a timed-out logout request as confirmed server logout; show an appropriate warning while still clearing local state.
3. Send logout with `keepalive` and allow sufficient time for the server revocation transaction.
4. Permit secure logout revocation using the hashed refresh-cookie value when the access JWT is already expired.
5. Add a server-enforced idle timeout and update `USER_SESSION.Last_Activity` at a controlled interval.
6. Implement refresh-token rotation and reuse detection, or remove the unused refresh-token issuance.
7. Add an integration test: login, access a protected endpoint, logout, reuse the same token, and require HTTP `401`.
8. Restrict Nginx to `ssl_protocols TLSv1.3;` if the manuscript requires TLS 1.3 exclusively.
9. Confirm that every active privileged account has completed TOTP enrollment.
10. Move the access credential out of JavaScript-readable `sessionStorage` and into a carefully designed HttpOnly, Secure, SameSite cookie flow, with CSRF protection and refresh-token rotation.
11. For stronger resistance to copied-token replay, bind each server session to a registered device session and require a per-request proof-of-possession mechanism. A client-supplied device identifier alone is not sufficient because it can also be copied or spoofed.
12. Add a production-safe two-account authorization test that confirms token A can access only Employee A's records and token B can access only Employee B's records.

## Production Verification Snapshot

Evidence checked on July 20, 2026:

| Control | Production observation |
|---|---|
| Public origin | `https://lgsvhr.com` |
| TLS termination | Nginx on AWS EC2 |
| HTTPS redirect | Configured |
| HSTS | One year with subdomains |
| TLS 1.3 | Successfully negotiated |
| TLS 1.2 | Also accepted |
| MFA | Enabled |
| MFA method | TOTP |
| MFA challenge lifetime | 300 seconds |
| TOTP drift window | One 30-second step before and after |
| Privileged accounts found | 5 |
| Privileged accounts with enrolled TOTP | 4 |
| Access-token production lifetime | 8 hours |
| Refresh-token default lifetime | 7 days |
| Server-side sessions | Implemented through `USER_SESSION` |
| Active sessions at evidence time | 5 |
| Recorded `user_logout` revocations | 14 |

## Short Defense Answer

> LGSV HR combines HTTPS, Argon2id password verification, TOTP MFA, JWT access tokens, protected refresh-token cookies, and database-backed session revocation. Privileged users use a six-digit RFC 6238 authenticator code that changes every 30 seconds. The server allows one adjacent step on each side for clock drift, while the login MFA challenge expires after five minutes and allows at most five failed attempts. TOTP secrets are encrypted with AES-256-GCM, and only hashed challenge and refresh tokens are stored. Each JWT has a unique `jti` that is checked against `USER_SESSION` on every protected request. A successful logout revokes that `jti`, so reuse should return HTTP 401. The observed token reuse was possible when the client cleared local storage after a logout timeout without confirming server revocation, combined with the current eight-hour access-token lifetime and absence of a server-enforced inactivity timeout. These are identified remediation items, not behavior that should be described as secure token revocation.
