# Leave Management Module - STRIDE Evidence

## Scope and trust boundaries

This model covers employee leave filing, HR/manual leave encoding, leave balances, payroll endorsement, HR final approval, rejection, attachment access, audit trail writing, and leave reports.

```text
Employee / Payroll / HR browser
  | HTTPS: leave request, status update, attachment request
  v
Express leave API boundary
  | backend RBAC + owner checks + four-eyes approval workflow
  v
MySQL leave requests, balances, encrypted remarks/attachments, audit trail
```

## STRIDE analysis

| STRIDE | Possible threat | Security control | Implementation evidence | How to show it |
|---|---|---|---|---|
| Spoofing | An attacker uses a forged, expired, revoked, or stolen session to impersonate an employee or approver. | Database-backed JWT/session validation establishes the actor. Four-eyes workflow then limits what one authenticated actor can finish: Payroll endorses, HR gives final approval, and the same employee cannot approve or reject their own leave. | `requireAuth` validates the token and current account/session state. `/api/leave/:id/status` changes `Pending` to `Payroll Approved` for payroll roles, then only an HR final approver can change `Payroll Approved` to `Approved`. | Call the Leave API without a token and show `401`. Then show Payroll endorsement followed by HR final approval. |
| Tampering | User changes status, leave balance, employee ID, or remarks through dev tools/Postman. | Backend allowed-field validation, parameterized SQL, owner-scoped filing, overlap checks, balance checks, and restricted status transitions. | `LEAVE_STATUS_ALLOWED_FIELDS`, `LEAVE_REQUEST_ALLOWED_FIELDS`, overlap query, balance validation, and transition checks in `server.js`. | Try to send unsupported fields or skip directly to HR approval; show `400/409/403`. |
| Repudiation | Payroll or HR denies approving, rejecting, or viewing sensitive leave details. | Leave audit trail records actor, action, old status, new status, timestamp, and encrypted remarks/metadata. | `writeLeaveAudit` logs `leave_payroll_approved`, `leave_approved`, `leave_rejected`, `leave_cancelled`, and sensitive-detail access. | Open System Admin Audit Trail or Leave Audit and show the payroll endorsement followed by HR final approval. |
| Information Disclosure | Employee views another employee's leave reason, attachment, or balance. | Owner checks for employees; broader access only for authorized leave roles; current-password step-up for sensitive reveal/download; AES-256-GCM encryption for reasons, remarks, filenames, and attachments. | `/api/leave/:id/reveal-sensitive`, `/api/leave/:id/attachment`, encrypted leave fields, and view-all permission checks. | Login as Regular Employee and try another employee's leave detail endpoint; show `403`. For an owned request, omit the current password and show the step-up block. |
| Denial of Service | Repeated submissions, oversized requests/uploads, or extreme date ranges consume API, storage, or database resources. | Per-principal API rate limiting, 1 MB JSON limit, 5 MB upload limit, 366-day range cap, overlap blocking, and annual limit checks. | Global API limits in `server.js`; leave creation rejects excessive ranges and overlapping `Pending`, `Payroll Approved`, and `Approved` requests. | Show rate/size-limit code or a safe oversized-file rejection; file an overlapping leave request and show it is blocked. Do not flood the live server. |
| Elevation of Privilege | Employee or System Admin tries to approve leave by changing client-side role/status. | Backend RBAC excludes System Admin from the leave approval permission and only permits payroll endorsement plus HR final approval. | `LEAVE_PERMISSION_ROLES['leave.request.approve']` excludes `admin/system_admin`; leave approval logic checks payroll and HR approver groups. | Login as System Admin or Regular Employee and attempt `/api/leave/:id/status`; show `403`. |

## Approval Workflow

```text
Pending
  -> Payroll Approved   Payroll Officer or Payroll Manager endorsement
  -> Approved           HR final approver (HR Admin/HR Manager role group)

Pending / Payroll Approved
  -> Rejected           Payroll or an HR final approver with remarks
```

Leave balance is deducted only when the request reaches final `Approved` status.
