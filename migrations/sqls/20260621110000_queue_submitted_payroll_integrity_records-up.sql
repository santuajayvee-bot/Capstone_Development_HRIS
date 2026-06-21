-- UP migration: queue existing submitted payroll calculations for blockchain review.
-- Submitted calculations remain off-chain pending approval; only finalized hashes
-- may be anchored to Hyperledger Fabric.

INSERT INTO PAYROLL_RECORD
  (Payroll_ID, Employee_ID, Gross_Pay, Total_Statutory_Deductions,
   Net_Pay, Non_Taxable_Allowance, Approval_Status, Blockchain_Status,
   Finalized_At, Approved_By)
SELECT
  sc.id,
  sc.employee_id,
  COALESCE(sc.gross_pay, 0.00),
  COALESCE(sc.sss_deduction, 0.00)
    + COALESCE(sc.pagibig_deduction, 0.00)
    + COALESCE(sc.philhealth_deduction, 0.00),
  COALESCE(sc.net_pay, 0.00),
  COALESCE(sc.total_allowances, 0.00),
  'Submitted',
  'PENDING_APPROVAL',
  NULL,
  NULL
FROM salary_calculations sc
WHERE sc.status = 'Submitted'
ON DUPLICATE KEY UPDATE
  Employee_ID = CASE WHEN PAYROLL_RECORD.Blockchain_Status = 'RECORDED' THEN PAYROLL_RECORD.Employee_ID ELSE VALUES(Employee_ID) END,
  Gross_Pay = CASE WHEN PAYROLL_RECORD.Blockchain_Status = 'RECORDED' THEN PAYROLL_RECORD.Gross_Pay ELSE VALUES(Gross_Pay) END,
  Total_Statutory_Deductions = CASE WHEN PAYROLL_RECORD.Blockchain_Status = 'RECORDED' THEN PAYROLL_RECORD.Total_Statutory_Deductions ELSE VALUES(Total_Statutory_Deductions) END,
  Net_Pay = CASE WHEN PAYROLL_RECORD.Blockchain_Status = 'RECORDED' THEN PAYROLL_RECORD.Net_Pay ELSE VALUES(Net_Pay) END,
  Non_Taxable_Allowance = CASE WHEN PAYROLL_RECORD.Blockchain_Status = 'RECORDED' THEN PAYROLL_RECORD.Non_Taxable_Allowance ELSE VALUES(Non_Taxable_Allowance) END,
  Approval_Status = CASE WHEN PAYROLL_RECORD.Blockchain_Status = 'RECORDED' THEN PAYROLL_RECORD.Approval_Status ELSE 'Submitted' END,
  Blockchain_Status = CASE WHEN PAYROLL_RECORD.Blockchain_Status = 'RECORDED' THEN PAYROLL_RECORD.Blockchain_Status ELSE 'PENDING_APPROVAL' END,
  Finalized_At = CASE WHEN PAYROLL_RECORD.Blockchain_Status = 'RECORDED' THEN PAYROLL_RECORD.Finalized_At ELSE NULL END,
  Approved_By = CASE WHEN PAYROLL_RECORD.Blockchain_Status = 'RECORDED' THEN PAYROLL_RECORD.Approved_By ELSE NULL END,
  updated_at = NOW();

INSERT INTO BLOCKCHAIN_AUDIT_LOG
  (Payroll_ID, Event_Type, Actor_User_ID, Actor_Role, Payload_Hash,
   Status, IP_Address, Details, Created_At)
SELECT
  sc.id,
  'PAYROLL_SUBMITTED_BACKFILL',
  sc.calculated_by,
  NULL,
  NULL,
  'PENDING_APPROVAL',
  NULL,
  JSON_OBJECT(
    'source', 'salary_calculations',
    'message', 'Existing submitted payroll calculation queued for Payroll Manager approval before Fabric anchoring.'
  ),
  NOW()
FROM salary_calculations sc
LEFT JOIN BLOCKCHAIN_AUDIT_LOG existing
  ON existing.Payroll_ID = sc.id
 AND existing.Event_Type IN ('PAYROLL_SUBMITTED_QUEUE', 'PAYROLL_SUBMITTED_BACKFILL')
WHERE sc.status = 'Submitted'
  AND existing.Audit_ID IS NULL;
