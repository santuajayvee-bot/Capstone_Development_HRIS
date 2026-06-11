# Permissioned Blockchain Payroll Integrity Module

LGSV HR uses Hyperledger Fabric as a permissioned audit and integrity layer. MySQL remains the source of operational payroll data. The ledger stores only finalized payroll hashes, references, approval metadata, timestamps, and adjustment links.

## Fabric Client Dependencies

Install these in the Express app when connecting to a real Fabric network:

```bash
npm install @hyperledger/fabric-gateway @grpc/grpc-js
```

Install chaincode dependencies inside `chaincode/payroll-audit` before packaging/deploying chaincode:

```bash
cd chaincode/payroll-audit
npm install
```

## API Endpoints

- `POST /api/payroll/:payrollId/finalize-blockchain`
  - System Administrator only, Level 4 exact role.
  - Reads `PAYROLL_RECORD`, recomputes SHA-256, submits hash to Fabric, then stores the Fabric transaction ID in `Transaction_Hash`.

- `GET /api/admin/verify-integrity/:payrollId`
  - System Administrator only, Level 4 exact role.
  - Recomputes the current off-chain hash and compares it to the ledger hash.

- `POST /api/payroll/:payrollId/blockchain-adjustments`
  - System Administrator only, Level 4 exact role.
  - Creates a new adjustment ledger transaction. The original finalized ledger entry is never edited or deleted.

## Example Finalized Payroll Data Before Hashing

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

## Example Blockchain Ledger Record

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

## Example Successful Verification Response

```json
{
  "status": "success",
  "message": "Payroll record integrity verified",
  "payroll_id": "10000042",
  "computed_hash": "6e86d2f0b92f4cf5bfe470fb685d7ec698f57e5f93fcaec9c52e141dbe88c8e8",
  "blockchain_hash": "6e86d2f0b92f4cf5bfe470fb685d7ec698f57e5f93fcaec9c52e141dbe88c8e8"
}
```

## Example Tampering Detection Response

```json
{
  "status": "critical",
  "message": "Tampering detected: off-chain payroll record does not match blockchain ledger",
  "payroll_id": "10000042",
  "computed_hash": "f7390d4b1a9d5375b70e9a6d3d9e8dc9505ac2a968dc14f78b96a81a0d8d03f3",
  "blockchain_hash": "6e86d2f0b92f4cf5bfe470fb685d7ec698f57e5f93fcaec9c52e141dbe88c8e8"
}
```

## Security Notes

- SHA-256 hashes are built from deterministic JSON ordering in `server/utils/payrollHash.js`.
- No full 201-file data, bank details, home addresses, or complete payroll breakdowns are written to Fabric.
- `Employee_ID` on-chain is an anonymized reference using `BLOCKCHAIN_EMPLOYEE_REF_PEPPER`.
- All blockchain actions enforce System Administrator-only RBAC before controller execution.
- SQL queries are parameterized.
- Finalized Fabric records are immutable by chaincode design. Corrections use `CreatePayrollAdjustmentRecord`.
- Finalize, verify, and adjustment actions write to `system_audit_log`; blockchain-specific receipts also write to `BLOCKCHAIN_AUDIT_LOG` when available.
