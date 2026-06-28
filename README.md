# LGSV HR Consolidated Documentation

This file consolidates the project setup, security, payroll, blockchain, onboarding, and biometric attendance documentation into one place. AGENTS.md remains separate because it is used by Codex/project tooling as implementation instructions.

## Table of Contents

1. [Project Overview and Security](#project-overview-and-security)
2. [Team Local Setup](#team-local-setup)
3. [Blockchain Setup](#blockchain-setup)
4. [Payroll Setup](#payroll-setup)
5. [Permissioned Blockchain Payroll Integrity](#permissioned-blockchain-payroll-integrity)
6. [Onboarding Setup](#onboarding-setup)
7. [Attendance Biometric Setup](#attendance-biometric-setup)
8. [Biometric Background Service Setup](#biometric-background-service-setup)
9. [AWS Biometric Deployment](docs/aws-biometric-deployment.md)


---

## Project Overview and Security

_Source: README.md_

## LGSV HR

LGSV HR is a secure Human Resource and Payroll System for Marulas Industrial Corporation. It uses Node.js, Express.js, MySQL, and Hyperledger Fabric. Fabric is used only as a permissioned audit ledger for finalized payroll hashes; employee PII and full payroll breakdowns remain in MySQL.

### Team Setup

New contributors should begin with the complete local setup manual:

- [Team Local Setup Guide](#team-local-setup)
- [Blockchain Reference](#blockchain-setup)

Do not commit `.env`, generated Fabric identities, channel artifacts, database dumps containing real data, or private keys.

### AES-256-GCM Off-Chain Payload Encryption

LGSV HR supports optional AES-256-GCM application-layer encryption for sensitive off-chain API communication between trusted clients, partner systems, and the Node.js/Express backend. This supports the security objective: to safeguard employee, HR, and payroll data from unauthorized exposure by using AES-256 encryption for off-chain communication between client, partner, and system.

- Algorithm: `aes-256-gcm` from the built-in Node.js `crypto` module.
- Key storage: `AES_256_SECRET_KEY` in the backend `.env` or AWS runtime secret configuration only. It must be 32 random bytes encoded as base64.
- Payload format:

```json
{
  "encryptedPayload": {
    "iv": "base64-12-byte-random-iv",
    "encryptedData": "base64-ciphertext",
    "authTag": "base64-gcm-auth-tag"
  }
}
```

Sensitive API clients may send encrypted request bodies in this wrapper. They may request encrypted JSON responses with `X-LGSV-Encrypted-Response: true`. Covered sensitive areas include employee personal information, government requirement details, education/training data, attendance records, leave records, payroll and compensation records, user account administration, role management, and login payloads when submitted by trusted system clients.

Limits: normal browser UI requests are not forced into this shared-key scheme because the AES key must never be exposed to frontend JavaScript. HTTPS/TLS is still required; AES-256-GCM is additional application-layer protection, not a replacement for TLS.

### Strict Database Encryption

For stricter at-rest protection, the system stores high-risk database values in encrypted columns and keeps hashes for lookup where needed.

- `users.email_encrypted` and `users.email_hash` protect account email lookup data.
- `employees.encrypted_pii` stores a protected PII snapshot for employee records.
- `sensitive_employee_data.*_encrypted` and `*_hash` protect 201-file sensitive values such as SSN/tax ID, bank account data, and emergency contact phone.
- `employee_family_members.pii_encrypted` protects family relationship, names, date of birth, phone, address, occupation, and employer details.
- `employee_work_experiences.pii_encrypted` protects previous employer, position, supervisor, address, employment dates, and reason for leaving.
- `employee_certifications.pii_encrypted` and `employee_trainings.pii_encrypted` protect education/training details while file paths remain operational metadata.
- `password_hash` remains a password hash, not AES encryption. Passwords must never be decryptable.

After deploying migrations to an existing database, run:

```bash
npm run backfill:strict-encryption
```

The backfill encrypts existing plaintext values and clears nullable plaintext columns where the application now uses encrypted storage. Keep `AES_ENCRYPTION_KEY` stable; encrypted database values cannot be decrypted if this key changes.

---

## Team Local Setup

_Consolidated section._

## LGSV HR Team Local Setup Guide

This guide lets a teammate run LGSV HR locally after cloning the repository, including the permissioned Hyperledger Fabric payroll-audit network.

Use only sanitized development data. Never commit `.env`, database dumps with real employee data, generated Fabric identities, channel artifacts, or private keys.

### What This Starts

- LGSV HR web server at `http://localhost:3000`
- MySQL database used for HR and payroll data
- Three main Fabric nodes:
  - `orderer.lgsvhr.com`
  - `peer0.hr.lgsvhr.com`
  - `peer0.payroll.lgsvhr.com`
- Channel: `lgsvhr-payroll-channel`
- Chaincode: `payroll-audit`

Fabric stores only finalized payroll hashes, anonymized employee references, approval metadata, timestamps, record type, and adjustment links. Full payroll data and PII stay in MySQL.

### Prerequisites

Install these before cloning:

- Git
- Node.js 18 or newer
- MySQL 8.x or MariaDB compatible with MySQL
- Docker Desktop with Docker Compose enabled
- Git Bash or WSL for Fabric shell scripts on Windows

Start Docker Desktop before the Fabric commands. Allow Docker enough memory to run the orderer, two peers, CLI support container, and chaincode containers.

Check the tools:

```powershell
node --version
npm --version
mysql --version
docker --version
docker compose version
```

### 1. Clone And Install Dependencies

```powershell
git clone <YOUR-GITHUB-REPOSITORY-URL>
cd Capstone_Development_HRIS
npm ci
cd chaincode/payroll-audit
npm ci
cd ../..
```

Use `npm install` only when intentionally updating dependencies. Do not commit `node_modules`.

### 2. Create Local Environment Settings

Create a local `.env` from the template.

```powershell
Copy-Item .env.example .env
```

For Git Bash or WSL:

```bash
cp .env.example .env
```

Set at least these local values in `.env`:

```env
PORT=3000
NODE_ENV=development

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=lgsv_hr_db
DB_SSL=false

JWT_SECRET=<generate-a-long-random-secret>
AES_ENCRYPTION_KEY=<generate-64-random-hex-characters>
AES_256_SECRET_KEY=<generate-32-random-bytes-base64>
BLOCKCHAIN_EMPLOYEE_REF_PEPPER=<generate-a-long-random-secret>
AUTH_MAX_FAILED_ATTEMPTS=5
AUTH_LOCKOUT_MINUTES=15

FABRIC_ENABLED=true
FABRIC_CHANNEL_NAME=lgsvhr-payroll-channel
FABRIC_CHAINCODE_NAME=payroll-audit
FABRIC_MSP_ID=PayrollMSP
FABRIC_PEER_ENDPOINT=localhost:7051
FABRIC_PEER_HOST_ALIAS=peer0.payroll.lgsvhr.com
FABRIC_TLS_CERT_PATH=./fabric-network/organizations/peerOrganizations/payroll.lgsvhr.com/peers/peer0.payroll.lgsvhr.com/tls/ca.crt
FABRIC_CERT_PATH=./fabric-network/organizations/peerOrganizations/payroll.lgsvhr.com/users/User1@payroll.lgsvhr.com/msp/signcerts/User1@payroll.lgsvhr.com-cert.pem
FABRIC_KEY_DIRECTORY_PATH=./fabric-network/organizations/peerOrganizations/payroll.lgsvhr.com/users/User1@payroll.lgsvhr.com/msp/keystore
```

Generate a secure local `JWT_SECRET` and `BLOCKCHAIN_EMPLOYEE_REF_PEPPER` with Node.js:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Run it separately for `JWT_SECRET` and `BLOCKCHAIN_EMPLOYEE_REF_PEPPER`. `AES_ENCRYPTION_KEY` must be exactly 64 hexadecimal characters, so generate it with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`AES_256_SECRET_KEY` protects sensitive off-chain request/response payloads between trusted clients, partners, and the backend. It must be exactly 32 random bytes encoded as base64:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Do not share or commit the resulting `.env` file. Local Fabric certificates are generated by the next step and are intentionally ignored by Git.

#### Secret Compatibility Notes

- Each teammate may use a different local `JWT_SECRET`. It is used to sign that teammate's login sessions; changing it simply invalidates existing local login tokens.
- A fresh local database with seeded development data may use a newly generated `AES_ENCRYPTION_KEY`, `AES_256_SECRET_KEY`, and `BLOCKCHAIN_EMPLOYEE_REF_PEPPER`.
- A shared database export that already contains AES-encrypted applicant, employee, or payroll values **must** use the same `AES_ENCRYPTION_KEY` that encrypted those rows. Otherwise those values cannot be authenticated or decrypted. Transfer that key privately through the team lead or approved secret manager; never commit it to GitHub.
- A partner/system client using encrypted API payloads must share the same `AES_256_SECRET_KEY` through an approved secret manager. Do not send this key to browser JavaScript.
- Existing finalized payroll proofs are tied to the original payroll data, employee-reference pepper, and Fabric ledger. For a clean local Fabric network, create and record a fresh local test payroll instead of expecting another developer's old receipt to exist.

### 3. Prepare MySQL

Create an empty development database if needed:

```powershell
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS lgsv_hr_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

LGSV HR currently uses versioned migrations for incremental schema changes. They expect the team-approved LGSV HR baseline schema to already exist. Ask the project lead for the sanitized development database export or the approved baseline setup process, import it locally, then run migrations.

Do not use a production database or export real employee data into GitHub.

After the approved baseline is present:

```powershell
npm run migrate
npm run seed
```

`npm run seed` creates development-only accounts. Never use their default passwords in staging or production.

If `npm run migrate` cannot connect, check `database.json`. The current migration runner uses its `dev` connection configuration, while the application server reads database credentials from `.env`. Keep any local credential changes private and do not commit passwords.

### 4. Start The Fabric Network

Run these commands from **Git Bash or WSL** at the project root:

```bash
bash fabric-network/scripts/network-up.sh
bash fabric-network/scripts/create-channel.sh
bash fabric-network/scripts/deploy-chaincode.sh
```

The first command generates local Fabric identities and channel artifacts, then starts the orderer, two peer nodes, and CLI support container. The next commands create the channel and deploy `payroll-audit` chaincode.

Check the containers:

```bash
docker compose -f fabric-network/docker-compose.fabric.yml ps
```

Expected main nodes:

```txt
orderer.lgsvhr.com
peer0.hr.lgsvhr.com
peer0.payroll.lgsvhr.com
```

Expected chaincode deployment result:

```txt
Chaincode payroll-audit committed on lgsvhr-payroll-channel.
```

Do not run `network-up.sh --regenerate` unless you intentionally want a new local Fabric identity set and a fresh local ledger. It invalidates the local generated identities and channel artifacts.

### 5. Start LGSV HR

From the project root:

```powershell
npm start
```

Open `http://localhost:3000` and confirm:

```txt
http://localhost:3000/health
```

The browser should show the login page. If Fabric environment values were added after the server started, restart `npm start` so Node.js reloads `.env`.

### 6. Development Test Accounts

After `npm run seed`, local-only development accounts include:

| Role | Username | Password |
| --- | --- | --- |
| Payroll Manager | `payroll.manager` | `manager123` |
| Payroll Officer | `payroll.officer` | `officer123` |
| System Administrator | `sys.admin` | `sys123admin` |
| HR Admin | `hr.admin` | `hr123admin` |

These are known development credentials from `database/seed-users.js`. Change them immediately in any non-local environment.

### 7. Payroll Blockchain Test Flow

1. Log in as **Payroll Manager**.
2. Create or open a submitted payroll calculation.
3. Approve it. Its local ledger state becomes `Finalized / PENDING`.
4. In **Payroll Records**, click **Record on Blockchain**.
5. Refresh the Blockchain page. The record should show `RECORDED` and a transaction receipt/hash.
6. Log in as **System Administrator**.
7. In **Blockchain**, click **Verify**. Expected result: `Payroll record integrity verified.`
8. Use **View audit** to see `FINALIZE_RECORD / RECORDED` and `VERIFY_INTEGRITY / VERIFIED`.

The action is intentionally idempotent. Trying to record the same finalized payroll again returns an "already recorded" message because Fabric records are immutable.

### 8. Direct Fabric Check

The application verification call is normally enough. For a capstone demonstration, the project lead can also query the chaincode directly through the local CLI container. Do not paste private credentials into a terminal recording or presentation.

```bash
docker compose -f fabric-network/docker-compose.fabric.yml exec -T cli bash
```

Inside the container, set the PayrollMSP identity and use `peer chaincode query` against `lgsvhr-payroll-channel` and `payroll-audit`. The record should contain an anonymized employee reference and payroll hash only, never full employee or payroll PII.

### 9. Troubleshooting

#### `Fabric Gateway credentials are incomplete`

- Run `network-up.sh` first so local certificates exist.
- Confirm the three `FABRIC_*_PATH` values in `.env` match this guide.
- Restart the Node.js server.

#### `unknown service gateway.Gateway`

- Pull the latest repository changes.
- Run `bash fabric-network/scripts/network-up.sh` again.
- Confirm both peers are running with `docker compose ... ps`.

#### Payroll shows `PENDING_ANCHOR`

- Confirm Docker is running and channel/chaincode setup completed.
- Run `create-channel.sh` and `deploy-chaincode.sh` again; the deployment script is safe to rerun.
- Use **Record on Blockchain** again after Fabric is healthy. The deterministic hash is reused; Fabric rejects only a successfully recorded duplicate.

#### `npm run migrate` fails to connect

- Confirm MySQL is running.
- Confirm the development database exists.
- Review the local migration connection configuration in `database.json`.
- Ensure the approved baseline schema was imported before applying incremental migrations.

#### Docker port already in use

Check for another Fabric network or local process using ports `7050`, `7051`, `8051`, `9443`, `9444`, or `9445`, then stop that process before restarting the network.

### 10. Shut Down Or Reset

Stop Fabric while keeping local ledger volumes:

```bash
bash fabric-network/scripts/network-down.sh
```

Remove local Fabric containers and volumes only when intentionally resetting the local ledger:

```bash
bash fabric-network/scripts/network-down.sh --volumes
```

After a volume reset, rerun all three Fabric setup commands from section 4. A reset does not change MySQL payroll records; previously recorded local receipts may no longer exist in the new local Fabric ledger, so use a fresh local test database or test payroll data when demonstrating a reset.

### AWS Deployment Environment

Set the same account lockout and encrypted-communication variables in the AWS runtime environment, not only in the local `.env` file:

```env
AUTH_MAX_FAILED_ATTEMPTS=5
AUTH_LOCKOUT_MINUTES=15
AES_256_SECRET_KEY=<32-random-bytes-base64>
```

For EC2, add them to the process manager or deployment environment that starts Node.js. For Elastic Beanstalk/App Runner, add them as application environment properties. If AWS Systems Manager Parameter Store or Secrets Manager is used for configuration, create matching entries there and make sure the app loads them before startup.

For strict database encryption on an existing AWS database, keep the existing `AES_ENCRYPTION_KEY`, pull the latest code, then run:

```bash
npm run migrate
npm run backfill:strict-encryption
```

The backfill encrypts existing plaintext values into encrypted columns and clears nullable plaintext fields where the application now uses encrypted storage. Do not rotate `AES_ENCRYPTION_KEY` after data has been encrypted unless a planned key-rotation process decrypts and re-encrypts the data.

### What Belongs In Git

Commit:

- Application and chaincode source code
- Versioned migrations
- Fabric Compose/config/scripts
- `.env.example` with placeholders only
- Documentation

Never commit:

- `.env`
- Generated `fabric-network/organizations/`
- Generated `fabric-network/channel-artifacts/`
- `node_modules/`
- Real database dumps, payroll exports, certificates, private keys, JWT secrets, or AWS credentials

---

## Blockchain Setup

_Consolidated section._

## LGSV HR Permissioned Payroll Blockchain Setup

> New teammates should follow the complete [Team Local Setup Guide](#team-local-setup) first. This section remains the blockchain-specific reference.

LGSV HR uses Hyperledger Fabric only as a permissioned audit layer for finalized payroll hashes. Sensitive employee files, bank data, payroll breakdowns, addresses, and other PII remain off-chain in MySQL.

The configured Fabric network has three main blockchain nodes:

- `orderer.lgsvhr.com`
- `peer0.hr.lgsvhr.com`
- `peer0.payroll.lgsvhr.com`

The `cli` container is only a support container for channel and chaincode commands.

### Prerequisites

- Docker Desktop with Docker Compose
- Node.js 18 or newer
- MySQL or MariaDB running with the LGSV HR database
- Bash shell for the Fabric scripts, such as Git Bash or WSL

### Install Dependencies

From the project root:

```bash
npm install
npm install @hyperledger/fabric-gateway @grpc/grpc-js
cd chaincode/payroll-audit
npm install
cd ../..
```

### Configure `.env`

Copy `.env.example` to `.env` if needed, then set:

```env
FABRIC_ENABLED=true
FABRIC_CHANNEL_NAME=lgsvhr-payroll-channel
FABRIC_CHAINCODE_NAME=payroll-audit
FABRIC_MSP_ID=PayrollMSP
FABRIC_PEER_ENDPOINT=localhost:7051
FABRIC_PEER_HOST_ALIAS=peer0.payroll.lgsvhr.com
FABRIC_TLS_CERT_PATH=./fabric-network/organizations/peerOrganizations/payroll.lgsvhr.com/peers/peer0.payroll.lgsvhr.com/tls/ca.crt
FABRIC_CERT_PATH=./fabric-network/organizations/peerOrganizations/payroll.lgsvhr.com/users/User1@payroll.lgsvhr.com/msp/signcerts/User1@payroll.lgsvhr.com-cert.pem
FABRIC_KEY_DIRECTORY_PATH=./fabric-network/organizations/peerOrganizations/payroll.lgsvhr.com/users/User1@payroll.lgsvhr.com/msp/keystore
BLOCKCHAIN_EMPLOYEE_REF_PEPPER=replace-with-a-long-random-pepper
```

For local development without Fabric running, keep `FABRIC_ENABLED=false`. The backend will store the payroll hash locally and mark the blockchain state as `PENDING_ANCHOR`.

### Apply the Database Migration

Using the standalone migration:

```bash
mysql -u root -p lgsv_hr_db < database/migrate-permissioned-blockchain-payroll.sql
```

Or with the project migration runner:

```bash
npm run migrate
```

The migration creates or updates:

- `PAYROLL_RECORD.Transaction_Hash`
- `PAYROLL_RECORD.Blockchain_Status`
- `PAYROLL_RECORD.Finalized_At`
- `PAYROLL_RECORD.Approved_By`
- `BLOCKCHAIN_AUDIT_LOG`
- `system_audit_log` compatibility columns used by critical audit events

### Start the Fabric Network

From the project root:

```bash
cd fabric-network
bash ./scripts/network-up.sh
bash ./scripts/create-channel.sh
bash ./scripts/deploy-chaincode.sh
cd ..
```

To confirm containers:

```bash
docker compose -f fabric-network/docker-compose.fabric.yml ps
docker ps --filter "name=orderer.lgsvhr.com"
docker ps --filter "name=peer0.hr.lgsvhr.com"
docker ps --filter "name=peer0.payroll.lgsvhr.com"
```

### Run the LGSV HR Server

```bash
npm start
```

The blockchain payroll routes are mounted at:

```txt
/api/blockchain/payroll
```

### API Test Commands

Login as Payroll Manager and System Administrator:

```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"payroll.manager","password":"manager123"}'

curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"sys.admin","password":"sys123admin"}'
```

Set tokens from the JSON `token` value:

```bash
PAYROLL_MANAGER_TOKEN="paste-token-here"
SYSTEM_ADMIN_TOKEN="paste-token-here"
```

Create or inspect a finalized payroll row in MySQL:

```sql
SELECT Payroll_ID, Employee_ID, Approval_Status, Blockchain_Status, Transaction_Hash
FROM PAYROLL_RECORD
ORDER BY Payroll_ID DESC
LIMIT 5;
```

Finalize and record a payroll hash:

```bash
curl -s -X POST http://localhost:3000/api/blockchain/payroll/finalize/1 \
  -H "Authorization: Bearer ${PAYROLL_MANAGER_TOKEN}" \
  -H "Content-Type: application/json"
```

Verify payroll integrity:

```bash
curl -s http://localhost:3000/api/blockchain/payroll/verify/1 \
  -H "Authorization: Bearer ${SYSTEM_ADMIN_TOKEN}"
```

View audit trail:

```bash
curl -s http://localhost:3000/api/blockchain/payroll/audit/1 \
  -H "Authorization: Bearer ${SYSTEM_ADMIN_TOKEN}"
```

View finalized blockchain records:

```bash
curl -s http://localhost:3000/api/blockchain/payroll/finalized \
  -H "Authorization: Bearer ${PAYROLL_MANAGER_TOKEN}"
```

### Tamper Detection Test

After a finalized payroll has been recorded on Fabric, change a payroll integrity field directly in MySQL:

```sql
UPDATE PAYROLL_RECORD
SET Net_Pay = Net_Pay + 1.00
WHERE Payroll_ID = 1;
```

Then verify again:

```bash
curl -s http://localhost:3000/api/blockchain/payroll/verify/1 \
  -H "Authorization: Bearer ${SYSTEM_ADMIN_TOKEN}"
```

Expected result when Fabric is connected: the API returns a critical tampering warning because the recomputed off-chain hash no longer matches the ledger hash.

Expected result when Fabric is disabled or unavailable: the API returns `pending_anchor` and this message:

```txt
Blockchain network is not currently connected. Local audit records are available, but Fabric verification is disabled.
```

### Shut Down the Network

```bash
cd fabric-network
bash ./scripts/network-down.sh
```

To remove Docker volumes too:

```bash
bash ./scripts/network-down.sh --volumes
```

Keep generated certificates and channel artifacts unless you intentionally need to regenerate identities.

---

## Payroll Setup

_Consolidated section._

## Payroll System Setup Guide

### If You're Getting "Unexpected Token <" Error When Running Payroll

This error means the database tables for payroll don't exist. Follow these steps to fix it:

#### Step 1: Apply Database Migration

Run this command from your project root:

```bash
node database/apply-migration.js
```

This will create all required payroll tables:
- `wage_types` - Types of wage structures (Base Salary, Hourly, Per-Piece, Per-Trip)
- `sewing_types` - Production sewing types with rates
- `logistics_regions` - Delivery regions with rates
- `employee_wage_rates` - Custom rates per employee
- `production_transactions` - Track pieces produced
- `logistics_transactions` - Track trips completed
- `payroll_runs` - Monthly batch containers
- `payslips` - Individual paychecks
- `employee_deductions` - SSS, PhilHealth, Pag-IBIG, custom deductions

#### Step 2: Restart Your Server

After the migration completes, restart your Express server:

```bash
npm start
```

#### Step 3: Try Running Payroll Again

1. Login as Payroll Officer
2. Go to Payroll Page
3. Click "+ Run Payroll" button
4. Select month and dates
5. Click "Generate Payroll"

---

### Payroll Generation Process

#### What Happens When You Run Payroll:

1. **Validates Input**: Checks month_year, start_date, end_date
2. **Creates Payroll Run**: Inserts record in `payroll_runs` table
3. **Fetches Active Employees**: Gets all employees with wage_type_id
4. **Calculates Earnings** (for each employee):
   - **Per-Piece**: Sums `production_transactions` for the month
   - **Per-Trip**: Sums `logistics_transactions` for the month
   - **Base/Hourly**: Fixed amount (configurable)
5. **Calculate Deductions**: Sums all active deductions from `employee_deductions`
6. **Creates Payslips**: Inserts payslip with (total_earning - total_deduction = net_pay)

#### Response Format (Success):
```json
{
  "success": true,
  "payrollRunId": 1,
  "employeesProcessed": 5,
  "totalEmployees": 5,
  "message": "Payroll generated for 2026-03 - 5 employees processed"
}
```

#### Response Format (Error):
```json
{
  "error": "...",
  "details": "...",
  "message": "..."
}
```

---

### Troubleshooting

#### Error: "Payroll already generated for this month"
**Solution**: You've already created payroll for that month. Try a different month or delete the previous payroll run from the database.

#### Error: "Database tables may not exist"
**Solution**: Run `node database/apply-migration.js` again. Check if all tables were created successfully.

#### Error: "Failed to create payroll run"
**Solution**: Check database connection. Make sure your `.env` file has correct `DB_HOST`, `DB_USER`, `DB_PASSWORD`.

#### Payroll Processes but Shows 0 Employees
**Solution**: 
- Check if any employees have `status = 'Active'`
- Check if employees have `wage_type_id` assigned
- Verify production/logistics transactions exist for that month

---

### Permission Requirements

- ✅ **Admin**: Can run payroll
- ✅ **Payroll Officer**: Can run payroll
- ✅ **Payroll Manager**: Can run payroll  
- ❌ **Employee**: Cannot run payroll

---

### Database Tables Reference

#### `payroll_runs`
- `id` - Primary key
- `month_year` - Format: YYYY-MM
- `start_date` - Period start
- `end_date` - Period end
- `created_by` - User ID who generated it
- `created_at` - Timestamp

#### `payslips`
- `id` - Primary key
- `payroll_run_id` - Foreign key to payroll_runs
- `employee_id` - Foreign key to employees
- `wage_type_id` - Foreign key to wage_types
- `total_earning` - Sum of transactions or base salary
- `total_deduction` - Sum of employee deductions
- `net_pay` - total_earning - total_deduction
- `generated_at` - Timestamp

---

## Permissioned Blockchain Payroll Integrity

_Consolidated section._

## Permissioned Blockchain Payroll Integrity Module

LGSV HR uses Hyperledger Fabric as a permissioned audit and integrity layer. MySQL remains the source of operational payroll data. The ledger stores only finalized payroll hashes, references, approval metadata, timestamps, and adjustment links.

### Fabric Client Dependencies

Install these in the Express app when connecting to a real Fabric network:

```bash
npm install @hyperledger/fabric-gateway @grpc/grpc-js
```

Install chaincode dependencies inside `chaincode/payroll-audit` before packaging/deploying chaincode:

```bash
cd chaincode/payroll-audit
npm install
```

### API Endpoints

- `POST /api/payroll/:payrollId/finalize-blockchain`
  - System Administrator only, Level 4 exact role.
  - Reads `PAYROLL_RECORD`, recomputes SHA-256, submits hash to Fabric, then stores the Fabric transaction ID in `Transaction_Hash`.

- `GET /api/admin/verify-integrity/:payrollId`
  - System Administrator only, Level 4 exact role.
  - Recomputes the current off-chain hash and compares it to the ledger hash.

- `POST /api/payroll/:payrollId/blockchain-adjustments`
  - System Administrator only, Level 4 exact role.
  - Creates a new adjustment ledger transaction. The original finalized ledger entry is never edited or deleted.

### Example Finalized Payroll Data Before Hashing

This deterministic payload is generated from `PAYROLL_RECORD`. Fields such as `Transaction_Hash`, `Blockchain_Status`, `created_at`, and `updated_at` are excluded because recording the blockchain receipt would otherwise change the hash.

```json
{
  "Payroll_ID": "10000042",
  "Employee_ID": "501",
  "Gross_Pay": "25000.00",
  "Total_Statutory_Deductions": "3100.00",
  "Net_Pay": "21900.00",
  "Non_Taxable_Allowance": "1000.00",
  "Approval_Status": "Finalized",
  "Finalized_At": "2026-06-10T08:30:00.000Z",
  "Approved_By": "13"
}
```

### Example Blockchain Ledger Record

```json
{
  "Payroll_ID": "10000042",
  "Employee_ID": "EMP_REF_5e1ca25d2bfdd0bdf54aab21",
  "Payroll_Hash": "6e86d2f0b92f4cf5bfe470fb685d7ec698f57e5f93fcaec9c52e141dbe88c8e8",
  "Approval_Status": "Finalized",
  "Approved_By": "13",
  "Approved_At": "2026-06-10T08:30:00.000Z",
  "Recorded_At": "2026-06-10T08:31:04.250Z",
  "Record_Type": "FINALIZED_PAYROLL",
  "Previous_Transaction_Hash": null
}
```

### Example Successful Verification Response

```json
{
  "status": "success",
  "message": "Payroll record integrity verified",
  "payroll_id": "10000042",
  "computed_hash": "6e86d2f0b92f4cf5bfe470fb685d7ec698f57e5f93fcaec9c52e141dbe88c8e8",
  "blockchain_hash": "6e86d2f0b92f4cf5bfe470fb685d7ec698f57e5f93fcaec9c52e141dbe88c8e8"
}
```

### Example Tampering Detection Response

```json
{
  "status": "critical",
  "message": "Tampering detected: off-chain payroll record does not match blockchain ledger",
  "payroll_id": "10000042",
  "computed_hash": "f7390d4b1a9d5375b70e9a6d3d9e8dc9505ac2a968dc14f78b96a81a0d8d03f3",
  "blockchain_hash": "6e86d2f0b92f4cf5bfe470fb685d7ec698f57e5f93fcaec9c52e141dbe88c8e8"
}
```

### Security Notes

- SHA-256 hashes are built from deterministic JSON ordering in `server/utils/payrollHash.js`.
- No full 201-file data, bank details, home addresses, or complete payroll breakdowns are written to Fabric.
- `Employee_ID` on-chain is an anonymized reference using `BLOCKCHAIN_EMPLOYEE_REF_PEPPER`.
- All blockchain actions enforce System Administrator-only RBAC before controller execution.
- SQL queries are parameterized.
- Finalized Fabric records are immutable by chaincode design. Corrections use `CreatePayrollAdjustmentRecord`.
- Finalize, verify, and adjustment actions write to `system_audit_log`; blockchain-specific receipts also write to `BLOCKCHAIN_AUDIT_LOG` when available.

---

## Onboarding Setup

_Consolidated section._

## Secure Onboarding Module Setup

The onboarding module keeps applicants outside the official Employee Directory until HR approval and transfer. It stores biometric reference IDs only. It does not store fingerprint templates or fingerprint images.

### 1. Apply the schema

```powershell
npm run migrate:onboarding
```

The migration is idempotent and creates:

- `onboarding_position_route`
- `onboarding_applicant`
- `onboarding_applicant_document`
- `onboarding_applicant_activity`
- `onboarding_integrity_chain`

### 2. Workflow and RBAC

Only `hr_admin` and the legacy `admin` role can manage applicants.

- Direct-hire office roles such as Manager and HR Staff proceed to HR approval.
- Factory and operational roles such as Operator, Production Worker, and Driver enter screening and training first.
- Agency-hired applicants require agency deployment and contract details.
- Applicants are created in `employees` only after approval and an explicit transfer reason.
- Transfer prepares payroll wage configuration and activates the encrypted biometric reference mapping when configured.

`system_admin` can submit queued onboarding integrity hashes to the blockchain adapter but cannot read or modify applicant records.

### Initial Payroll Rate

The onboarding form uses **Initial payroll rate** instead of the ambiguous term **base rate**. It initializes the employee's payroll configuration during transfer:

- `Base Salary`: fixed monthly salary
- `Hourly`: default amount paid per hour
- `Per-Piece`: fallback amount paid per produced item
- `Per-Trip`: fallback amount paid per delivery trip

Detailed overtime, sewing-type, and logistics-region rates can be refined in Payroll after transfer.

### 3. Security

Production deployments must use TLS 1.3:

- Set `TLS_CERT_PATH` and `TLS_KEY_PATH` when Node terminates HTTPS directly.
- Alternatively, terminate TLS 1.3 at a trusted reverse proxy and forward only over the private application network.
- Set `DB_SSL=true` and provide the MySQL CA and client certificate paths when the database supports TLS.
- Enable database, tablespace, disk, or managed-service encryption at rest.

Applicant contact information, addresses, email, optional biometric user references, and prepared document bytes are encrypted with AES-256-GCM. Prepared documents are stored under `secure_uploads/onboarding`, outside the public web root.

### 4. Permissioned Blockchain Adapter

Every onboarding activity is SHA-256 chained in `onboarding_integrity_chain`. Configure the HTTPS adapter:

```text
BLOCKCHAIN_API_URL=https://your-permissioned-ledger-adapter
BLOCKCHAIN_API_TOKEN=replace-with-adapter-token
```

When required, configure the mTLS certificate paths in `.env`.

Submit queued onboarding hashes as `system_admin`:

```text
POST /api/onboarding/integrity/anchor-pending
```

The external adapter must accept:

```text
POST /api/onboarding/anchors
```

The returned `transaction_id`, `reference`, or `id` is stored as the blockchain reference.

### 5. Verify

Run the repeatable integration test while the local server is running:

```powershell
npm run test:onboarding
```

---

## Attendance Biometric Setup

_Consolidated section._

## Attendance Biometric Integration Setup

The attendance module stores biometric reference IDs and attendance metadata only. It does not store fingerprint templates, fingerprint images, or vendor biometric payloads.

### 1. Apply the schema

```powershell
npm run migrate:attendance-biometric
```

The migration is idempotent. Existing legacy attendance records are preserved, summarized for payroll, and added to the local integrity chain.

### 2. Configure transport security

Production deployments must use TLS 1.3:

- Set `TLS_CERT_PATH` and `TLS_KEY_PATH` when Node terminates HTTPS directly.
- Alternatively, terminate TLS 1.3 at a trusted reverse proxy and forward only to the private application network.
- Set `DB_SSL=true` and provide the MySQL CA and client certificate paths when the database supports TLS.
- Enable MySQL tablespace, disk, or managed-service encryption at rest using AES-256 for structured employee and attendance data.

Outbound biometric and blockchain API adapters reject non-HTTPS URLs unless the development-only `ALLOW_INSECURE_BIOMETRIC_API=true` flag is set outside production.

### 3. Register a biometric device

Sign in as `system_admin`, open **Attendance Sync**, and register the device. Supported authentication modes are:

- `API_KEY`
- `BEARER`
- `HMAC`
- `OAUTH2`
- `MTLS`

API secrets and tokens are encrypted with AES-256-GCM before storage.

Map each vendor biometric user reference to an active employee. The mapping stores:

- `device_id`
- `employee_id`
- encrypted biometric user reference
- SHA-256 lookup hash

### 4. Webhook contract

Vendor devices or middleware can push attendance events to:

```text
POST /api/attendance/biometric/webhook/:deviceReference
```

Example payload:

```json
{
  "events": [
    {
      "external_event_id": "scan-10001",
      "biometric_user_id": "vendor-user-42",
      "scan_timestamp": "2026-05-31T08:03:00+08:00",
      "attendance_type": "TIME_IN"
    }
  ]
}
```

`attendance_type` accepts `TIME_IN`, `TIME_OUT`, or `AUTO`. Common aliases such as `IN`, `OUT`, `CLOCK_IN`, and `CLOCK_OUT` are normalized.

For `API_KEY`, send the configured header, which defaults to:

```text
x-biometric-api-key: your-secret
```

For `HMAC`, send:

```text
x-biometric-timestamp: Unix timestamp in seconds
x-biometric-signature: sha256=<hex HMAC>
```

The HMAC input is:

```text
<timestamp>.<raw JSON request body>
```

Requests older than five minutes are rejected.

### 5. Pull synchronization

When a vendor API exposes attendance logs, configure its HTTPS base URL and logs endpoint. A system administrator can trigger synchronization from **Attendance Sync** or call:

```text
POST /api/attendance/biometric/sync/:deviceId
```

Failed requests, rejected events, duplicate scans, and synchronization status are recorded for monitoring.

### 6. Payroll and blockchain adapter

Only validated attendance with both a time-in and time-out becomes payroll eligible.

Each attendance version is SHA-256 chained in `attendance_integrity_chain`. To submit queued hashes to the permissioned blockchain adapter, configure `BLOCKCHAIN_API_URL` and trigger:

```text
POST /api/attendance/integrity/anchor-pending
```

The external blockchain adapter is expected to accept attendance anchors at:

```text
POST /api/attendance/anchors
```

The module records the returned `transaction_id`, `reference`, or `id` as its anchor reference.

### 7. Vendor handoff checklist

Before production integration, obtain these details from Marulas Industrial Corporation or its biometric vendor:

- API base URL and logs endpoint
- push webhook support, pull API support, or both
- exact user reference field mapped to employee records
- authentication method and credential rotation procedure
- event timestamp timezone
- punch-type values
- retry behavior and vendor event ID guarantees
- certificate authority and mTLS client certificate requirements

Run the repeatable integration test after setup:

```powershell
npm run test:attendance-biometric
```

---

## Biometric Background Service Setup

_Consolidated section._

## LGSV HR Background Biometric Attendance

### Architecture

ZKTeco ZK9500 scanner -> LGSV ZK9500 background bridge -> fingerprint identification -> `POST /api/biometric/station-attendance` -> MySQL attendance record -> HR validation -> payroll-ready attendance summary.

Attendance no longer depends on an employee login, browser session, Attendance Station page, or Time In / Time Out buttons.

### Bridge Config

The bridge reads:

`C:\ProgramData\LGSV_HR\ZK9500Bridge\bridge-config.json`

Default development config:

```json
{
  "device_reference": "ZK9500-LOCAL-001",
  "hris_attendance_url": "http://localhost:3000/api/biometric/station-attendance",
  "auth_header_name": "x-biometric-api-key",
  "auth_secret": "",
  "background_scanner_enabled": true,
  "duplicate_local_cooldown_seconds": 60,
  "scanner_idle_delay_ms": 600,
  "listener_prefix": "http://localhost:8787/"
}
```

For AWS, change `hris_attendance_url`:

```json
"hris_attendance_url": "https://your-aws-domain.com/api/biometric/station-attendance"
```

If the biometric device in System Settings uses API key auth, set the same key in `auth_secret`.
Use `tools/biometric-bridge/bridge-config.aws.example.json` as the AWS station template and follow the full AWS checklist in `docs/aws-biometric-deployment.md`.

### Windows Startup

Run PowerShell as Administrator:

```powershell
cd tools\biometric-bridge
.\install-background-service.ps1
```

To remove it:

```powershell
cd tools\biometric-bridge
.\uninstall-background-service.ps1
```

### Logs

Bridge service log:

`C:\ProgramData\LGSV_HR\ZK9500Bridge\bridge-service.log`

HRIS logs:

- `biometric_scan_event`
- `attendance_log`
- `attendance_summary`
- `system_audit_log`

### Attendance Rules

Configured in `attendance_policy_settings`:

- `duplicate_scan_window_seconds`
- `hr_validation_required`
- `multiple_scan_handling`
- `missing_timeout_handling`
- `overtime_handling`

Default flow:

1. First fingerprint match of the day records `TIME_IN`.
2. Second fingerprint match records `TIME_OUT`.
3. More scans are rejected by duplicate/multiple scan policy.
4. New biometric attendance starts as `PENDING_VALIDATION`.
5. HR validates/corrects/rejects the record.
6. Completed and approved records become payroll-eligible.

### Optional Monitoring

The Attendance Station page is now optional monitoring only. Attendance still works when no HRIS page is open.
