# Secure Onboarding Module Setup

The onboarding module keeps applicants outside the official Employee Directory until HR approval and transfer. It stores biometric reference IDs only. It does not store fingerprint templates or fingerprint images.

## 1. Apply the schema

```powershell
npm run migrate:onboarding
```

The migration is idempotent and creates:

- `onboarding_position_route`
- `onboarding_applicant`
- `onboarding_applicant_document`
- `onboarding_applicant_activity`
- `onboarding_integrity_chain`

## 2. Workflow and RBAC

Only `hr_admin` and the legacy `admin` role can manage applicants.

- Direct-hire office roles such as Manager and HR Staff proceed to HR approval.
- Factory and operational roles such as Operator, Production Worker, and Driver enter screening and training first.
- Agency-hired applicants require agency deployment and contract details.
- Applicants are created in `employees` only after approval and an explicit transfer reason.
- Transfer prepares payroll wage configuration and activates the encrypted biometric reference mapping when configured.

`system_admin` can submit queued onboarding integrity hashes to the blockchain adapter but cannot read or modify applicant records.

## Initial Payroll Rate

The onboarding form uses **Initial payroll rate** instead of the ambiguous term **base rate**. It initializes the employee's payroll configuration during transfer:

- `Base Salary`: fixed monthly salary
- `Hourly`: default amount paid per hour
- `Per-Piece`: fallback amount paid per produced item
- `Per-Trip`: fallback amount paid per delivery trip

Detailed overtime, sewing-type, and logistics-region rates can be refined in Payroll after transfer.

## 3. Security

Production deployments must use TLS 1.3:

- Set `TLS_CERT_PATH` and `TLS_KEY_PATH` when Node terminates HTTPS directly.
- Alternatively, terminate TLS 1.3 at a trusted reverse proxy and forward only over the private application network.
- Set `DB_SSL=true` and provide the MySQL CA and client certificate paths when the database supports TLS.
- Enable database, tablespace, disk, or managed-service encryption at rest.

Applicant contact information, addresses, email, optional biometric user references, and prepared document bytes are encrypted with AES-256-GCM. Prepared documents are stored under `secure_uploads/onboarding`, outside the public web root.

## 4. Permissioned Blockchain Adapter

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

## 5. Verify

Run the repeatable integration test while the local server is running:

```powershell
npm run test:onboarding
```
