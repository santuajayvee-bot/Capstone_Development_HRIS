# Leave and Employee Modules - Taglish STRIDE Defense Script

## Pinakasimpleng sagot sa “Nasaan ang STRIDE?”

Sabihin ito bago mag-demo:

> “Ang STRIDE po ay hindi isang menu o anim na buttons sa system. Threat-model
> categories po ito. Hinanap namin kung saan puwedeng magkaroon ng Spoofing,
> Tampering, Repudiation, Information Disclosure, Denial of Service, at
> Elevation of Privilege sa Leave at Employee workflows. Pagkatapos, inilagay
> namin ang controls sa backend authentication, RBAC, validation, encryption,
> audit logs, rate limits, database integrity checks, at automated tests.”

## Suggested 8-10 minute flow

1. **Scope and trust boundary (45 seconds)** - browser, Express API, MySQL/file vault.
2. **Define STRIDE (45 seconds)** - one sentence per letter.
3. **Leave module (3 minutes)** - own-record access, four-eyes approval, balance integrity, audit.
4. **Employee module (3 minutes)** - role-minimized views, masked/encrypted PII, tamper guard, lifecycle audit.
5. **Negative tests (1-2 minutes)** - show `401`, `403`, `409`, and audit evidence.
6. **Closing (30 seconds)** - controls reduce risk; they do not claim that threats are impossible.

## One-line STRIDE definitions

- **S - Spoofing:** pagpapanggap bilang ibang user o role.
- **T - Tampering:** unauthorized na pagbabago ng request o stored data.
- **R - Repudiation:** pagtanggi na ginawa o inapprove ng user ang action.
- **I - Information Disclosure:** paglabas ng sensitibong impormasyon sa unauthorized user.
- **D - Denial of Service:** pag-overload o pag-abuso para hindi magamit ang module.
- **E - Elevation of Privilege:** pagkuha ng mas mataas na access kaysa sa assigned role.

## Trust boundary na iguguhit o ipapakita

```text
User browser
  |  HTTPS + Bearer JWT
  v
Express API
  |  requireAuth -> backend RBAC -> validation/ownership checks
  v
Business workflow
  |  parameterized SQL + transactions + integrity checks
  v
MySQL + AES-256-GCM encrypted PII + encrypted file vault + audit logs
```

Defense line:

> “Every arrow is a trust boundary. Hindi namin pinagkakatiwalaan ang role,
> employee ID, status, amount, filename, o hidden button na galing sa browser.
> Lahat ay nire-recheck ng backend.”

---

# Part 1 - Leave Management

## Normal workflow muna

```text
Employee Portal filing -> Pending
Payroll Officer/Manager endorsement -> Payroll Approved
HR final approver decision -> Approved
Approved -> saka pa lang mababawas ang leave balance
```

Opening script:

> “Sa Leave Management, ang protected assets ay leave balance, leave reason,
> medical or supporting attachment, at approval decision. May owner-scoping at
> two-stage or four-eyes workflow para hindi isang user lang ang makapag-file at
> makapag-final approve nang walang independent review.”

## S - Spoofing sa Leave

Threat:

> “Puwedeng gumamit ang attacker ng forged, expired, revoked, o stolen token at
> magpanggap na employee o approver.”

Controls to explain:

- `requireAuth` validates the JWT using HS256.
- The server reloads account role, active state, session revocation/expiry, and
  token version from MySQL.
- The request cannot nominate its own trusted role.
- Self-approval/self-rejection is blocked.
- Payroll endorsement and HR final approval are separate workflow steps.

Code to show:

- `server/middleware.js:242` - `requireAuth`.
- `server/middleware.js:256` - JWT verification and database session checks.
- `server.js:6726` - self-approval block.
- `server.js:6732` - Payroll Approved before HR Approved.

Demo:

1. Send `GET /api/leave` without an Authorization token -> expected `401`.
2. Login as Payroll Officer; approve a Pending request -> status becomes
   `Payroll Approved`, not final `Approved`.
3. Login as an HR final approver (HR Admin/HR Manager in the current role
   mapping); final approve -> status becomes `Approved`.

Panel line:

> “Four-eyes does not replace authentication. Authentication establishes the
> actor; separation of duties limits what one authenticated actor can finish.”

## T - Tampering sa Leave

Threat:

> “Puwedeng palitan sa DevTools/Postman ang employee ID, status, balance, dates,
> remarks, role, o attachment extension.”

Controls to explain:

- Allowed request fields; unsupported/authority fields are rejected.
- Portal filing derives the employee from `req.user.employeeId`.
- Strict dates, maximum 366-day range, eligibility, overlap, annual-limit, and
  available-balance checks.
- Parameterized SQL (`?` placeholders), transaction, and `FOR UPDATE` locking.
- Leave balance has a SHA-256 integrity hash and approval stops on `TAMPERED`.
- Files are limited to 5 MB and checked by extension, MIME type, and magic bytes.

Code to show:

- `server.js:6447` - leave submission validation.
- `server.js:6465` - server-selected employee ID for Portal filing.
- `server.js:6528` - overlapping-request query.
- `server.js:6547` - balance integrity verification during filing.
- `server.js:6692` - status route with transaction and allowed transitions.
- `server.js:6774` - locked balance verification before final approval.
- `server/security-controls.js:326` - upload validation.

Safe negative demos:

- An HR final approver tries to approve a `Pending` request without Payroll endorsement ->
  expected `409` with “Payroll approval is required before HR final approval.”
- Submit an overlapping request -> expected `400`.
- Rename an executable to `medical.pdf` -> expected `400` because content does
  not match the extension. Use a harmless text test file, not real malware.

## R - Repudiation sa Leave

Threat:

> “Maaaring sabihin ng approver na hindi siya ang nag-endorse, nag-reject, o
> nag-view ng sensitive reason at attachment.”

Controls to explain:

- `leave_audit_trail` stores actor user ID, action, old/new status, and time.
- Remarks and metadata are encrypted in the audit trail.
- Sensitive reveal, failed step-up, attachment download, and blocked
  self-approval also create audit events.
- General write auditing also captures the API action and HTTP result.

Code/UI to show:

- `server.js:6155` - `writeLeaveAudit`.
- `server.js:6631` - password step-up and sensitive reveal audit.
- `server.js:6853` - approval/rejection action audit.
- Leave page -> **Audit & Reports** tab.

Demo:

1. Show one request's `Pending -> Payroll Approved -> Approved` history.
2. Point out actor, action, old status, new status, and timestamp.
3. Explain that sensitive remarks are not dumped as plaintext in the normal
   audit-list response.

## I - Information Disclosure sa Leave

Threat:

> “Puwedeng palitan ng employee ang leave ID sa URL/API para makita ang reason,
> medical attachment, o balance ng ibang employee.”

Controls to explain:

- Employees without `view_all` are queried using their authenticated
  `req.user.employeeId`.
- Normal leave list removes reasons, remarks, raw file paths, and encrypted
  storage columns.
- Sensitive reveal and attachment download check ownership/permission and
  require the current password as step-up authentication.
- Reasons, remarks, filenames, and files are encrypted with AES-256-GCM.
- Encrypted files are stored outside the public upload directory.

Code to show:

- `server.js:6311` - own-record query scope.
- `server.js:6324` - sensitive fields removed from normal response.
- `server.js:6628` - sensitive-detail owner check.
- `server.js:6664` - attachment owner check.
- `server/encrypted-file-vault.js:14` - prevents paths outside the secure vault.

Demo:

1. Login as Regular Employee A.
2. Try Employee B's sensitive leave endpoint -> expected `403`.
3. Open Employee A's own reason; wrong/no password -> expected `403`.
4. Correct password -> allowed and the reveal is audited.

## D - Denial of Service sa Leave

Threat:

> “Puwedeng paulit-ulit na mag-submit, mag-request ng reports, mag-upload ng
> malalaking files, o gumawa ng sobrang habang date ranges.”

Controls to explain:

- API read/write limits are per authenticated principal/IP and return `429`.
- JSON/urlencoded request body limit is 1 MB.
- Upload limit is 5 MB.
- Leave range is capped at 366 days.
- Overlapping active requests and annual-limit violations are rejected.

Code to show:

- `server.js:97` - API read/write rate-limit configuration.
- `server.js:845` - 1 MB body limit.
- `server.js:435` - 5 MB sensitive-upload limit.
- `server.js:6516` - 366-day maximum.

Demo guidance:

> “For DoS, code and automated-test evidence ang ipapakita namin. Hindi kami
> magfa-flood ng live defense environment.”

## E - Elevation of Privilege sa Leave

Threat:

> “Iu-unhide ng employee ang Approve button o papalitan ang client-side role at
> tatawag diretso sa status endpoint.”

Controls to explain:

- `requireLeavePermission('leave.request.approve')` is enforced by the API.
- Regular Employee and System Admin are not leave approvers.
- Payroll can endorse Pending; HR can final-approve only Payroll Approved.
- Client-provided `role`, `permissions`, and similar authority fields are
  rejected before the route handler.

Demo:

- Login as Regular Employee or System Admin and send
  `PATCH /api/leave/{id}/status` with `{"status":"Approved"}` -> expected `403`.
- Explain: “Unhiding the UI button does not modify backend permissions.”

---

# Part 2 - Employee Management

## Normal workflow muna

```text
HR creates/updates employee -> validated and encrypted storage -> integrity sealed
Authorized roles read -> server creates role-minimized response
HR offboards -> clearance/payroll/final checks -> account/session revocation
Every critical write -> audit trail
```

Opening script:

> “Sa Employee module, ang protected assets ay identity, contact information,
> addresses, government IDs, bank details, documents, employment status, at
> linked account access. Mas mataas ang privacy impact kaya may encryption,
> masking, least-privilege responses, integrity hashes, at lifecycle audit.”

## S - Spoofing sa Employee

Threat:

> “Puwedeng magpanggap na HR ang user gamit ang forged/stale token.”

Controls:

- Same JWT and database-backed session checks used by Leave.
- Employee CRUD requires authenticated HR staff-management role.
- Inactive/offboarded accounts are blocked and sessions are revoked.

Code to show:

- `server/middleware.js:242` - authentication.
- `server.js:3603` - create employee route requires HR role.
- `server.js:4028` - update employee route requires HR role.
- `server.js:1626` - offboarding session revocation.

Demo:

- `GET /api/employees` without token -> `401`.
- Payroll Officer or Regular Employee calls `PUT /api/employees/{id}` -> `403`.

## T - Tampering sa Employee

Threat:

> “Puwedeng magdagdag sa request ng role, permissions, password hash, salary,
> invalid status, SQL payload, o fake document extension.”

Controls:

- `EMPLOYEE_PARAMETER_TAMPER_GUARD` blocks authority/payroll fields.
- Separate create/update allowlists reject unknown fields.
- Field-level HR/payroll ownership and enum/date/text validation.
- Parameterized SQL and transactions.
- Authorized writes reseal a SHA-256 integrity hash; mismatches show `TAMPERED`.
- Delete is a logged soft delete, not silent physical deletion.

Code to show:

- `server.js:124` - forbidden employee fields.
- `server.js:2303` - allowlist and field-level validation.
- `server.js:1408` - employee SHA-256 integrity hash.
- `server.js:4962` - status allowlist and parameterized update.
- `server.js:5020` - soft-delete route.

Best Postman demo:

```json
{
  "first_name": "Demo",
  "last_name": "Employee",
  "email": "demo.employee@example.test",
  "role": "system_admin"
}
```

Expected result: `403 Request contains unauthorized fields.`

Panel line:

> “Even an authorized HR user cannot turn employee creation into account-role
> assignment by adding a hidden field.”

## R - Repudiation sa Employee

Threat:

> “Puwedeng itanggi ng HR user ang pag-edit, pag-view ng government ID,
> offboarding, document deletion, o status change.”

Controls:

- General write audit covers successful and failed API writes.
- `writeEmployeeLifecycleAudit` records actor, target employee, old/new state,
  IP, user agent, and timestamp.
- Sensitive-field reveal has its own privacy audit event.

Code/UI to show:

- `server.js:2743` - employee lifecycle audit.
- `server.js:3572` - audited sensitive-field reveal.
- `server.js:4177` - employee ID-change audit.
- `server.js:5052` - soft-delete audit.
- System Admin -> **Audit Logs**, filter Employee/Employee Lifecycle.

## I - Information Disclosure sa Employee

Threat:

> “Puwedeng makita ng employee o payroll user ang full PII, government IDs,
> bank account, 201-file, o raw document ng iba.”

Controls:

- Regular Employee directory response contains only the authenticated linked
  employee.
- HR, Payroll, and System Admin receive different server-built payloads.
- Full employee detail is HR-protected and checks target access.
- SSS, PhilHealth, Pag-IBIG, TIN, and bank account are masked by default.
- Sensitive reveal is audited.
- PII and secure files use AES-256-GCM; raw storage ciphertext/path fields are
  stripped from API responses.

Code to show:

- `server.js:3524` - Regular Employee own-record result.
- `server.js:3525` - role-minimized directory payloads.
- `server.js:3544` - HR-only employee detail.
- `server.js:1542` - masked identifiers.
- `server/crypto.js:20` - AES-256-GCM.
- `server/privacy-protection.js:46` - blocks ciphertext/storage paths in API responses.

UI demo:

1. Login as HR and open an employee profile.
2. Point out masked SSS/PhilHealth/Pag-IBIG/TIN/bank account.
3. Click the eye/reveal action.
4. Open Audit Logs and show `employee_sensitive_fields_revealed`.
5. Login as Regular Employee and show that another employee's full detail is denied.

## D - Denial of Service sa Employee

Threat:

> “Puwedeng ulit-ulitin ang directory/CRUD requests o mag-upload ng oversized
> employee document/photo.”

Controls:

- Per-principal API read/write rate limits.
- 1 MB request body limit.
- 5 MB upload limit and strict allowed formats/content signatures.
- Field lengths and enums are bounded before database work.
- Employee directory uses indexed identifiers/status fields. UI pagination helps
  browser rendering, but it is not presented as server-side DoS protection.

Demo:

- Show code/test evidence for rate limits.
- Optional disposable-test upload above 5 MB -> expected `400`.
- Do not perform a live request flood.

## E - Elevation of Privilege sa Employee

Threat:

> “Regular Employee or Payroll Officer calls HR endpoints, changes a hidden role,
> or makes their own account an administrator.”

Controls:

- Backend `requireRole(ROLES.staff_management)` protects employee CRUD/detail.
- Authority fields such as role, permissions, access level, passwords, and token
  version are forbidden in employee requests.
- Lifecycle update fields are separated between HR and IT processors.
- Regular Employee responses are self-scoped; frontend visibility is not trusted.

Demo:

1. As Regular Employee or Payroll Officer: `PUT /api/employees/{id}` -> `403`.
2. As HR: same authorized profile update -> success.
3. As HR: add `role: system_admin` -> still `403`.

---

# Postman negative-test card

Use only disposable records. Replace IDs and token placeholders.

| Test | Account | Request | Expected |
|---|---|---|---|
| No authentication | None | `GET /api/leave` | `401` |
| Leave privilege escalation | Employee/System Admin | `PATCH /api/leave/{id}/status` -> Approved | `403` |
| Skip Payroll endorsement | HR final approver | Approve a Pending leave | `409` |
| Leave IDOR | Employee A | Reveal/download Employee B leave | `403` |
| Missing reveal step-up | Authorized owner/manager | Reveal sensitive leave without current password | `403` |
| Employee CRUD privilege escalation | Employee/Payroll | `PUT /api/employees/{id}` | `403` |
| Authority-field tampering | HR | Employee request with `role: system_admin` | `403` |
| Invalid employee status | HR | Status outside the allowlist | `400` |
| Oversized upload | Authorized test user | File larger than 5 MB | `400` |

## Automated evidence to run before the defense

```powershell
node tests/leave-four-eyes-workflow.test.js
node tests/leave-employee-rbac-ui.test.js
node tests/employee-profile-masking.test.js
node tests/self-service-rbac-security.test.js
node tests/privacy-hardening.test.js
node tests/upload-security.test.js
node tests/unexpected-field-guard.test.js
node tests/csrf-protection.test.js
```

Do not say “secure because the tests passed.” Say:

> “These tests provide repeatable evidence that the selected controls remain in
> the code. We combine them with role-based live negative tests and audit-log
> evidence.”

## Pre-demo checklist

- Prepare four test accounts: Regular Employee, Payroll Officer, an HR final
  approver, and System Administrator. Never display real passwords.
- Prepare two disposable employees and one Pending leave request with a valid
  balance.
- Make sure the Payroll approver is not the employee who filed the leave.
- Open Postman with tokens stored as environment variables, not pasted on screen.
- Clear unrelated browser tabs and hide `.env`, database credentials, JWTs,
  password hashes, and real PII.
- Test the full sequence once: Pending -> Payroll Approved -> Approved -> audit.
- Keep screenshots of expected `401/403/409` results as fallback.
- Do not modify production data directly to demonstrate hash tampering. Use a
  disposable/local test database if the panel specifically requests it.

## Closing script

> “In summary, Spoofing is handled by database-backed authentication and session
> validation; Tampering by allowlists, validation, parameterized SQL, workflow
> rules, and integrity hashes; Repudiation by actor-linked audit trails;
> Information Disclosure by ownership checks, least-privilege responses,
> masking, and AES-256-GCM encryption; Denial of Service by rate and size limits;
> and Elevation of Privilege by backend RBAC and forbidden authority fields.
> The key point is that these controls are enforced at the API and data layers,
> not only by hidden frontend buttons.”

## If the panel asks “Is every threat eliminated?”

Answer:

> “No security design can honestly claim zero risk. STRIDE helps us identify and
> reduce specific threats. Residual risks such as endpoint compromise, stolen
> unlocked sessions, infrastructure outages, or key compromise still require
> TLS, secure secret management, backups, monitoring, patching, access reviews,
> and incident response.”
