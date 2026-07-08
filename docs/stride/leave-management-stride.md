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
| Spoofing | A single stolen or unattended payroll/manager session fully approves leave. | Four-eyes workflow: Payroll Officer and Payroll Manager are treated as one payroll endorsement group, then HR Manager gives final approval. The same employee cannot approve or reject their own leave. | `/api/leave/:id/status` changes `Pending` to `Payroll Approved` for payroll roles, then only HR final approver can change `Payroll Approved` to `Approved`. | Login as Payroll Officer or Payroll Manager and approve a leave: status becomes `Payroll Approved`. Login as HR Manager and final approve: status becomes `Approved`. |
| Tampering | User changes status, leave balance, employee ID, or remarks through dev tools/Postman. | Backend allowed-field validation, parameterized SQL, owner-scoped filing, overlap checks, balance checks, and restricted status transitions. | `LEAVE_STATUS_ALLOWED_FIELDS`, `LEAVE_REQUEST_ALLOWED_FIELDS`, overlap query, balance validation, and transition checks in `server.js`. | Try to send unsupported fields or skip directly to HR approval; show `400/409/403`. |
| Repudiation | Payroll or HR denies approving, rejecting, or viewing sensitive leave details. | Leave audit trail records actor, action, old status, new status, timestamp, and encrypted remarks/metadata. | `writeLeaveAudit` logs `leave_payroll_approved`, `leave_approved`, `leave_rejected`, `leave_cancelled`, and sensitive-detail access. | Open System Admin Audit Trail or Leave Audit and show the payroll endorsement followed by HR final approval. |
| Information Disclosure | Employee views another employee's leave reason, attachment, or balance. | Owner checks for employees; broader access only for authorized leave roles; sensitive remarks and attachment metadata are encrypted. | `/api/leave/:id/reveal-sensitive`, `/api/leave/:id/attachment`, encrypted leave fields, and view-all permission checks. | Login as Regular Employee and try another employee's leave detail endpoint; show `403`. |
| Denial of Service | Repeated or overlapping leave submissions flood the queue or exhaust balances. | Authenticated API access, date validation, maximum date range, overlap blocking, annual limit checks, and pagination/filtering. | Leave creation rejects overlapping `Pending`, `Payroll Approved`, and `Approved` requests and validates range/duration. | File an overlapping leave request while the first is `Payroll Approved`; show it is blocked. |
| Elevation of Privilege | Employee or System Admin tries to approve leave by changing client-side role/status. | Backend RBAC excludes System Admin from the leave approval permission and only permits payroll endorsement plus HR final approval. | `LEAVE_PERMISSION_ROLES['leave.request.approve']` excludes `admin/system_admin`; leave approval logic checks payroll and HR approver groups. | Login as System Admin or Regular Employee and attempt `/api/leave/:id/status`; show `403`. |

## Approval Workflow

```text
Pending
  -> Payroll Approved   Payroll Officer or Payroll Manager endorsement
  -> Approved           HR Manager final approval

Pending / Payroll Approved
  -> Rejected           Payroll or HR Manager with remarks
```

Leave balance is deducted only when the request reaches final `Approved` status.
