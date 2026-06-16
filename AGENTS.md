# AGENTS.md — LGSV HR /Codex Rules

## Project Identity

This project is LGSV HR, a secure web-based Human Resource and Payroll System for Marulas Industrial Corporation.

The system must follow the capstone paper: “A Permissioned Blockchain Integrated Human Resource System for Marulas Industrial Corporation to Enhance Data Security and Payroll Accuracy.” :contentReference[oaicite:1]{index=1}

Primary goals:
- Improve payroll accuracy.
- Protect employee, HR, and payroll data.
- Enforce strict Role-Based Access Control.
- Use permissioned blockchain only for finalized payroll audit trails.
- Follow Secure-by-Design and Zero Trust principles.

## Tech Stack

Use only the approved stack unless the user explicitly asks otherwise:

- Frontend: HTML5, CSS3, JavaScript
- Backend: Node.js with Express.js
- Database: MySQL / Amazon RDS MySQL
- Blockchain: Hyperledger Fabric
- Chaincode: Node.js
- Authentication: Argon2 for password hashing, JWT for sessions
- Security: AES-256 for sensitive off-chain data, TLS 1.3 in transit
- Deployment target: AWS EC2, RDS, S3
- Testing tools: OWASP ZAP, Burp Suite Community, SQLMap, Postman, Hyperledger Explorer

Do not introduce unrelated frameworks, databases, or blockchain platforms without explaining why and asking first.

## Core Security Rules

All code must follow these security requirements:

1. Never store plaintext passwords.
   - Use Argon2id for password hashing.
   - Never use MD5, SHA1, SHA256 alone, bcrypt fallback, or reversible encryption for passwords.

2. Protect sessions properly.
   - Use short-lived JWT access tokens.
   - Use refresh tokens only if stored securely.
   - Store browser tokens in httpOnly, Secure, SameSite cookies when applicable.
   - Add logout and token invalidation logic.
   - Add automatic session expiration.
   - Never expose tokens in URLs.

3. Enforce MFA where applicable.
   - MFA must be included for privileged roles such as System Administrator, Payroll Manager, HR Admin, and Payroll Officer.
   - Do not bypass MFA for admin or payroll actions.

4. Enforce RBAC on the backend.
   - Frontend hiding is not enough.
   - Every protected API route must check authentication and role permission.
   - Never trust client-side role values.
   - Role checks must come from the database or verified token claims.

5. Prevent common web vulnerabilities.
   - Use parameterized SQL queries only.
   - Validate and sanitize all inputs.
   - Escape output to prevent XSS.
   - Add CSRF protection for cookie-based sessions.
   - Prevent IDOR by checking ownership and role access.
   - Rate-limit login and sensitive endpoints.
   - Log failed login attempts and suspicious actions.

6. Encrypt sensitive employee data.
   - Sensitive 201-file data, salary data, bank/payroll data, and PII must be encrypted at rest.
   - AES-256 encryption keys must not be stored in the database.
   - Use environment variables or secure secret management.

7. Log critical actions.
   - Login attempts
   - Failed authentication
   - Role changes
   - Payroll computation
   - Payroll approval
   - Attendance override
   - Payslip release
   - Blockchain recording
   - Backup/restore actions

8. Never allow silent privilege escalation.
   - Only System Administrator can create accounts and assign roles.
   - Payroll Officer must not be able to grant themselves Payroll Manager access.
   - Any RBAC update must generate an audit log.

## RBAC Hierarchy

Use this strict 4-level RBAC model:

### Level 4 — System Administrator
Allowed:
- Manage accounts
- Assign and revoke roles
- Manage RBAC permissions
- Monitor system health
- Perform backup and restore
- Verify blockchain integrity
- View audit logs
- Maintain system security configuration

Not allowed:
- Directly alter finalized payroll amounts without audit trail
- Bypass blockchain verification

### Level 3 — Payroll Manager
Allowed:
- Review payroll runs
- Approve finalized payroll
- Generate and export official financial summary reports
- View payroll reports
- Access finalized payroll records

Not allowed:
- Manage RBAC roles
- Create administrator accounts
- Modify blockchain records
- Access unrelated system configuration

### Level 2 — HR Admin
Allowed:
- Manage employee lifecycle
- Manage 201-files
- Onboard, offboard, and re-onboard employees
- Validate biometric attendance
- Manage leave requests
- Print payslips for non-technical workers
- View HR reports

Not allowed:
- Export final financial summary reports
- Approve final payroll
- Manage RBAC permissions

### Level 2 — Payroll Officer
Allowed:
- Encode verified production piece-rate logs
- Encode verified logistics trip logs
- Compute draft payroll
- Apply statutory deductions
- View reports in view-only mode
- Resolve pay disputes with proper audit logging

Not allowed:
- Export final financial summary reports
- Approve final payroll as final authority
- Manage employee 201-files
- Manage RBAC permissions

### Level 1 — Regular Employee
Allowed:
- Login securely
- View own attendance
- View/download own payslip
- Submit leave request if eligible
- View own leave status

Not allowed:
- View other employees’ records
- Access payroll computation
- Access 201-files of others
- Access reports
- Access admin functions

## Module Rules

### Employee Lifecycle and 201-File Management
- HR Admin owns this module.
- Store sensitive data encrypted.
- Employees must only access their own basic profile if allowed.
- Do not expose another employee’s 201-file through URL or ID manipulation.

### Attendance Module
- Attendance comes from biometric integration.
- Employees may view their own attendance only.
- HR Admin may validate or correct attendance when needed.
- Any manual correction must create an audit log.
- Do not create geofencing unless explicitly requested.

### Operational Logs
- Payroll Officer encodes verified physical production and trip logs.
- Production piece-rate logs and logistics trip logs must remain separate entities.
- Every encoded log must include who encoded it and when.

### Payroll Computation
The system must support:
- Fixed rate
- Hourly/daily rate
- Piece-rate production
- Per-trip logistics rate
- Manila vs. provincial trip rates
- Shared wage logic for missing logistics helpers
- Non-taxable allowance handling

The system must compute only:
- SSS
- PhilHealth
- Pag-IBIG

Do not implement income tax or withholding tax unless the user explicitly changes the scope. The paper states that income tax processing is handled separately by accounting.

### Payroll Approval
- Payroll Officer may compute and prepare payroll.
- Payroll Manager has final approval authority.
- Final payroll approval must lock the payroll batch.
- After finalization, changes must be handled through correction/dispute flow, not direct editing.

### Payslip Generation
- Employees can view only their own finalized payslips.
- HR Admin may print physical payslips for non-technical workers.
- Payslips must show salary breakdown, deductions, allowances, and net pay.

### Official Financial Summary Report
- Only Payroll Manager can export the official financial summary report.
- Payroll Officer may only view reports if permitted.
- The system is not a banking or disbursement gateway.
- Do not integrate direct bank transfer unless explicitly requested.

### Blockchain Module
Use Hyperledger Fabric only for finalized payroll transaction records and audit verification.

Rules:
- Do not store full employee PII on-chain.
- Store only hashes, transaction references, payroll batch IDs, approval metadata, and integrity proofs.
- Use SHA-256 hashing for finalized payroll payloads.
- Save the blockchain transaction hash/reference in the off-chain PAYROLL_RECORD table.
- Blockchain recording must happen only after final payroll approval.
- Blockchain records must be immutable.
- If off-chain payroll data changes after finalization, integrity verification must detect mismatch.

## Database Rules

Use MySQL-compatible SQL.

General rules:
- Use BIGINT for primary and foreign keys.
- Use DECIMAL(10,2) for all money, rates, deductions, hours, and computed pay.
- Do not use FLOAT or DOUBLE for payroll computation.
- Use created_at and updated_at where appropriate.
- Use audit fields such as created_by, updated_by, approved_by, finalized_by where applicable.
- Use soft delete for employee records unless permanent deletion is explicitly required.

Important entities may include:
- ROLE
- EMPLOYEE
- ATTENDANCE_LOG
- LEAVE_APPLICATION
- PRODUCTION_PIECE_LOG
- LOGISTICS_TRIP_LOG
- PAYROLL_RECORD
- SYSTEM_AUDIT_LOG
- TAX_TABLE or STATUTORY_DEDUCTION_TABLE
- BLOCKCHAIN_TRANSACTION_LOG

PAYROLL_RECORD must include:
- Payroll_ID
- Employee_ID
- Gross_Pay
- Total_Statutory_Deductions
- Net_Pay
- Non_Taxable_Allowance
- Approval_Status
- Transaction_Hash

## SQL Migration Rules

All database schema changes must be written as migrations with both `up` and `down` logic.

The project uses an up/down migration pattern:

- `up` = applies the database change.
- `down` = safely reverses the database change.

Every migration must be reversible unless the user explicitly says it is irreversible.

### Migration File Naming

Use clear timestamp-based migration filenames:

```txt
YYYYMMDDHHMMSS_create_employees_table.sql
YYYYMMDDHHMMSS_add_transaction_hash_to_payroll_record.sql
YYYYMMDDHHMMSS_create_system_audit_log_table.sql

## API Rules

All APIs must follow this pattern:

- Validate request body.
- Authenticate user.
- Authorize user by role.
- Execute using parameterized queries.
- Log critical action.
- Return safe response.
- Never expose stack traces or raw SQL errors.

Use consistent route style:

- `/api/auth/login`
- `/api/auth/logout`
- `/api/auth/mfa/verify`
- `/api/employees`
- `/api/attendance`
- `/api/leaves`
- `/api/production-logs`
- `/api/trip-logs`
- `/api/payroll`
- `/api/payroll/:id/finalize`
- `/api/payslips`
- `/api/reports/financial-summary`
- `/api/admin/rbac`
- `/api/audit-logs`
- `/api/blockchain/verify`

## Coding Standards

- Keep code modular.
- Separate controllers, services, middleware, routes, models, and utilities.
- Do not put business logic directly inside routes.
- Use environment variables for secrets.
- Never hardcode database credentials, JWT secrets, encryption keys, or Fabric certificates.
- Add comments for security-sensitive logic.
- Prefer clear readable code over clever code.
- Avoid unnecessary dependencies.
- Keep changes focused on the user’s request.

Suggested backend structure:

```txt
src/
  config/
  controllers/
  middleware/
  routes/
  services/
  models/
  validators/
  utils/
  blockchain/
  tests/


Error Handling Rules
Return generic error messages to users.
Log detailed errors internally.
Never expose:
SQL queries
stack traces
encryption keys
JWT secrets
password hashes
Fabric private keys
AWS credentials

Example:

User response: Invalid login credentials.
Internal log: detailed reason, timestamp, IP, user agent, and failed identifier.
Testing Rules

Before considering a task complete, check or add tests for:

Login
Logout
Session expiration
RBAC enforcement
Password hashing
MFA flow if affected
Payroll computation
Statutory deductions
Employee-only payslip access
Payroll finalization
Blockchain transaction recording
Blockchain integrity verification
SQL injection prevention
IDOR prevention
XSS-safe input/output handling

Security target:

0 successful SQL injection
0 successful unauthorized access
0 critical/high vulnerabilities before final acceptance
100% detection of altered finalized payroll hashes
Forbidden Actions

Do not:

Store plaintext passwords.
Use insecure password hashing.
Disable RBAC checks.
Trust frontend-only authorization.
Allow Payroll Officer to export final financial reports.
Allow employees to access other employees’ records.
Store full PII on blockchain.
Implement income tax unless requested.
Implement direct bank disbursement unless requested.
Add public blockchain platforms unless requested.
Use FLOAT/DOUBLE for money.
Hardcode secrets.
Remove audit logging from sensitive actions.
Modify finalized payroll directly without correction flow.
Skip validation because “frontend already validates.”
When Unsure

If a requested change conflicts with the capstone paper, do not silently implement it.

Instead:

Explain the conflict briefly.
Suggest the safest paper-aligned implementation.
Ask for confirmation only if the decision changes system scope.

Default decision:

Follow the paper.
Prioritize security.
Preserve RBAC.
Preserve auditability.
Keep blockchain as finalization/audit layer only.