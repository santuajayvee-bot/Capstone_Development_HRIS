# LGSV HR Security Control Evidence

Date: 2026-06-27
Environment: Local development verification

## Frontend Controls - PASS

- Shared client-side validation is enabled through `public/js/form-validation.js`.
- Shared output encoding and safe text helpers are provided by `public/js/security-utils.js`.
- Client and server upload controls enforce allowed types and size limits.
- `node tests/frontend-output-security.test.js`: PASS
- `node tests/input-validation.test.js`: PASS
- `node tests/upload-security.test.js`: PASS

## Backend Controls - PASS

- Server-side validation is applied before API write routes.
- JWT authentication, database-backed session state, RBAC, and ownership checks are enforced server-side.
- Browser write requests are protected by same-origin/Fetch Metadata validation.
- API and authentication rate limits, security headers, generic errors, and security audit logging are enabled.
- Parameterized MySQL queries are used for request values.
- `node tests/csrf-protection.test.js`: PASS
- `node tests/payroll-piece-rate-auth.test.js`: PASS
- Live cross-site `POST /api/auth/login` check: blocked with HTTP 403.

## Database Controls - PASS (Local)

- Runtime account: `lgsv_app`, restricted to the LGSV HR database.
- Migration account: `lgsv_migrator`, separate from the runtime account and database-scoped.
- MySQL grant enforcement is enabled; `skip-grant-tables` is disabled.
- MySQL listens on `127.0.0.1` in local development.
- AES-256 key and JWT secret configuration checks pass.
- Password storage: 59/59 user hashes use Argon2id.
- Three legacy password credentials were invalidated, sessions revoked, accounts disabled, and audit entries recorded.
- 201-file access auditing uses the healthy `employee_201_file_access_audit` table.
- `node tests/password-storage-security.test.js`: PASS
- `npm run security:verify-db`: PASS

## Regression Summary

Command: `npm run test:security`

Result: PASS

- Frontend output encoding
- Input validation
- Upload security
- CSRF origin protection
- Payroll authorization
- Password storage

Local server health: PASS at `http://localhost:3000/health`.

## Deployment Evidence Still Required

- Capture validation screenshots in an authenticated browser session.
- Capture AWS RDS automated-backup retention and latest snapshot status.
- Run `NODE_ENV=production npm run security:verify-db` on EC2/RDS to prove DB TLS and certificate verification.
- Reset and reactivate the three intentionally disabled legacy accounts through the System Administrator flow if they are still needed.
