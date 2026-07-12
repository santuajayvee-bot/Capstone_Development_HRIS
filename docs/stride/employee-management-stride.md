# Employee Management Module - STRIDE Evidence

## Scope and trust boundaries

This model covers the employee directory, employee profile and 201-file data,
employee creation and updates, employee status changes, documents and photos,
offboarding/re-onboarding, and role-specific employee views.

```text
Regular Employee / HR / Payroll / System Admin browser
  | HTTPS: employee request or profile operation
  v
Express API security boundary
  | JWT/session validation + backend RBAC + field allowlists + IDOR checks
  v
Employee service and lifecycle rules
  | parameterized MySQL queries + transactions + integrity verification
  v
MySQL encrypted PII / encrypted file vault / system audit log
```

STRIDE controls are not a single page or button. They are implemented across
the API middleware, employee routes, encryption utilities, database schema,
audit trail, and automated tests.

## STRIDE analysis

| STRIDE | Possible threat | Security control | Implementation evidence | How to demonstrate safely |
|---|---|---|---|---|
| Spoofing | An attacker uses a forged, expired, revoked, inactive-account, or stale JWT to impersonate HR. | `requireAuth` verifies an HS256 JWT, reloads the account/session state from MySQL, checks inactive accounts, session expiry/revocation, password-change time, and token version. Employee roles and permissions come from the server-side account record, not the request body. | `server/middleware.js` `requireAuth`; employee routes start with `requireAuth`. | Send `GET /api/employees` without a token and show `401`. A fabricated or expired token is also rejected. |
| Tampering | A user injects `role`, `permissions`, `password_hash`, `salary`, or an invalid status into an employee update; an attacker changes employee rows directly in the database. | Backend forbidden-field guard, route allowlists, enum/date/text validation, parameterized queries, transaction/row-lock lifecycle operations, SHA-256 employee integrity hashes, upload extension/MIME/magic-byte validation, and soft deletion. | `EMPLOYEE_PARAMETER_TAMPER_GUARD`, `validateEmployeeRequestBody`, `employeeIntegrityStatus`, `sealEmployeeIntegrity`, and employee CRUD/lifecycle routes in `server.js`; `server/security-controls.js` for uploads. | As HR, add `"role":"system_admin"` to an otherwise valid employee request and show `403`. Send an invalid status and show `400`. Show `integrity_status: VALID` on an untampered record. |
| Repudiation | A user denies creating, editing, revealing, offboarding, re-onboarding, or deleting an employee record. | General write auditing plus employee lifecycle auditing records the authenticated actor, target employee, action, old/new state, IP address, user agent, and timestamp. Sensitive-field reveal is separately audited. | `generalWriteAuditMiddleware`, `writeEmployeeLifecycleAudit`, `auditEmployeeSensitiveField`, and `employee_sensitive_fields_revealed` in `server.js`; records go to `system_audit_log`. | Update a disposable employee record, reveal one masked identifier, then show the corresponding Employee/Employee Lifecycle entries in System Audit Logs. |
| Information Disclosure | A Regular Employee, Payroll Officer, or unrelated role views full PII, government numbers, bank account data, another employee's profile, or a raw uploaded document. | Role-minimized response payloads, own-record scoping, backend IDOR checks, masked government IDs/bank account by default, audited reveal, AES-256-GCM encryption at rest, encrypted file vault, safe vault-path enforcement, and API ciphertext filtering. | `/api/employees` response shaping and `/api/employees/:id` RBAC in `server.js`; `maskEmployeeDetail`; `server/crypto.js`; `server/encrypted-file-vault.js`; `server/privacy-protection.js`. | Login as a Regular Employee and show that `/api/employees` returns only the linked employee. Attempt another employee's detail route and show `403`. As HR, open a profile and show masked SSS/PhilHealth/Pag-IBIG/TIN/bank account before using the audited eye/reveal action. |
| Denial of Service | Repeated directory requests, oversized JSON bodies, or oversized/malicious documents consume CPU, memory, storage, or database connections. | Per-principal API read/write rate limiting, 1 MB JSON/urlencoded limits, 5 MB file limit, upload type/content validation, bounded input lengths, and database indexes. | API rate limits and body limits in `server.js`; file limits and validation in `server.js` and `server/security-controls.js`. | Show the configured limits in code. Optionally upload a file larger than 5 MB in a disposable test environment and show `400`; do not flood the live defense server. |
| Elevation of Privilege | A Regular Employee or Payroll Officer uses DevTools/Postman to call HR CRUD routes or adds admin fields to the request. | Backend `requireRole(ROLES.staff_management)` on employee create/update/delete/detail routes, route-specific permissions for lifecycle work, forbidden authority fields, and field-level HR/payroll ownership checks. Frontend hiding is only UX and is not treated as authorization. | Employee route declarations and `validateEmployeeRequestBody` in `server.js`; `requireRole` in `server/middleware.js`. | As Payroll Officer or Regular Employee, send `PUT /api/employees/:id` and show `403`. As authorized HR, repeat an allowed update and show success. |

## Role-minimized employee directory

```text
Regular Employee -> only the employee record linked to the authenticated account
HR Admin/Manager -> employee directory and authorized HR/payroll-setup fields
Payroll roles    -> reference/payroll fields, not the complete HR profile
System Admin     -> reference fields; not automatic access to the full HR profile
```

The important defense point is that the API builds these views on the server.
Changing a role value in JavaScript or unhiding a button does not change API
authorization.

## Lifecycle integrity and session revocation

Employee records are soft deleted by changing their status to `Inactive`; they
are not silently removed. Offboarding uses allowed state transitions and must
complete clearance, payroll review, and final-pay checks before final approval.
When the linked employee account is deactivated, its token version is increased
and active sessions are revoked. Authorized employee writes reseal the employee
SHA-256 integrity hash, while an out-of-band database modification produces a
`TAMPERED` integrity result.

## Existing automated evidence

Run these from the project root:

```powershell
node tests/employee-profile-masking.test.js
node tests/self-service-rbac-security.test.js
node tests/privacy-hardening.test.js
node tests/upload-security.test.js
node tests/unexpected-field-guard.test.js
node tests/csrf-protection.test.js
```

