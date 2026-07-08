# Payroll Management Module - STRIDE Evidence

## Scope and trust boundaries

This model covers payroll source logs, salary calculation, statutory deductions, payroll processing by authorized payroll roles, Payroll Manager approval/finalization, payslip release, payroll locking, audit trail writing, and the finalized payroll integrity snapshot used by the permissioned blockchain layer.

```text
Payroll Officer / Payroll Manager browser
  | HTTPS: source data, calculation requests, approval requests
  v
Express payroll API boundary
  | parameterized SQL + backend RBAC + step-up password verification
  v
MySQL payroll records, payslips, audit trail
  |
  | finalized payroll hash/reference only
  v
Hyperledger Fabric payroll audit layer
```

Payroll computation remains off-chain. Hyperledger Fabric stores only finalized payroll hashes, references, approval metadata, and integrity proofs.

## STRIDE analysis

| STRIDE | Possible threat | Security control | Implementation evidence | How to show it |
|---|---|---|---|---|
| Spoofing | Someone uses an unattended Payroll Manager session to approve, release, or lock payroll. | Backend step-up authentication requires the Payroll Manager to re-enter the current password before high-risk payroll status changes. Password is verified server-side using Argon2id. | `server/payroll.js` requires `currentPassword` for `Approved`, `Released`, `Locked`, and `Paid`; `services/passwordService.js` verifies with Argon2id; `public/js/payroll.js` shows a password modal before sensitive actions. | Login as Payroll Manager, approve a payroll record, and show the password confirmation. Try the API without `currentPassword` and show `401`. |
| Tampering | A client modifies gross pay, net pay, deductions, source IDs, or finalized status directly. | Backend rejects computed-field tampering, validates status transitions, blocks changes to finalized records, recalculates deductions server-side, and updates finalized hashes. | `PAYROLL_COMPUTED_FIELD_GUARD`, `LOCKED_PAYROLL_STATUSES`, status transition checks, `calculateSalaryDeductionSnapshot`, and `syncFinalizedPayrollRecord` in `server/payroll.js`. | Use browser dev tools/Postman to submit a computed pay field or invalid status transition and show blocked response plus audit entry. |
| Repudiation | Payroll Officer or Payroll Manager denies submission, approval, release, lock, or failed re-auth attempt. | Payroll audit trail and security audit events record actor, role, action, target record, timestamp, IP, result, and status request. Password values are never logged. | `logPayrollAudit` records `payroll_submitted_for_approval`, `payroll_approved`, `payroll_released`, `payroll_locked`, `payroll_step_up_authentication_verified`, and failed step-up attempts; `auditSecurityEvent` records blocked attempts. | Open Payroll Audit or System Audit after approval and show the successful action and failed re-auth evidence. |
| Information Disclosure | Salary, deductions, bank/payroll details, payslips, and government identifiers are exposed to unauthorized users. | Backend RBAC separates Payroll Officer, Payroll Manager, Employee, HR, and Admin access; employee payslip access is owner-scoped; sensitive values use encryption/masking helpers. | `requireRole(PAYROLL_PERMISSIONS.view/approve/settings)`, `canAccessPayslip`, encrypted payslip storage helpers, `decryptColumnValue`, and `maskSensitiveValue`. | Login as Regular Employee and show only own finalized payslip. Attempt another employee's payslip endpoint and show `403`. |
| Denial of Service | Expensive payroll generation or approval requests are repeatedly triggered. | Authenticated routes, RBAC, request validation, performance logging, and source-data readiness checks reduce repeated invalid work. Login and sensitive API rate limits protect authentication entry points. | `requireAuth`, `requireRole`, `startPerformanceTimer`, `completePerformanceLog`, generation preview/readiness validation, and global API/auth rate limit configuration in `server.js`. | Submit invalid payroll generation data and show validation stops processing. Use security tests/rate limit evidence for authenticated API controls. |
| Elevation of Privilege | Payroll Officer approves final payroll, or a lower-privilege user attempts payroll processing by changing client-side role/status. | Backend role enforcement allows authorized payroll roles to compute/process payroll; only Payroll Manager can approve, release, lock, or mark paid. Client role values are rejected by middleware. | `server/payroll.js` uses `ROLES.payroll_any` for calculation/generation routes and `PAYROLL_PERMISSIONS.approve` for final approval actions; `server/middleware.js` rejects client authority fields and reloads roles from trusted session/database state. | Login as Regular Employee and attempt payroll generation: show `403`. Login as Payroll Officer and attempt `Approved` status through Postman: show `403 Only Payroll Manager can approve, release, or lock payroll.` |

## Step-Up Authentication Evidence

Payroll Manager may process or compute payroll through the same authenticated payroll processing routes used by authorized payroll staff. Sensitive final-authority actions still require re-authentication:

- `Approved` - final payroll approval/finalization by Payroll Manager
- `Released` - payslip release to employee
- `Locked` - read-only payroll lock
- `Paid` - finalized paid/released state

The password is sent only in the protected request body as `currentPassword`, verified on the backend against the stored Argon2id hash, and excluded from audit metadata.

## Residual risks

- Password re-entry protects against unattended active sessions but does not replace MFA. Privileged accounts should still complete TOTP MFA at login.
- Until the access token is moved fully to HttpOnly cookies, browser JavaScript still handles the access token for API calls. Server-side session revocation and step-up checks reduce the impact of active-session misuse.
- Payroll approval depends on source attendance, production, and logistics logs being validated before submission. Those source modules must keep their own STRIDE controls active.
