-- DOWN migration: remove only queue records introduced by the submitted-payroll backfill.

DELETE pr
FROM PAYROLL_RECORD pr
JOIN BLOCKCHAIN_AUDIT_LOG backfill
  ON backfill.Payroll_ID = pr.Payroll_ID
 AND backfill.Event_Type = 'PAYROLL_SUBMITTED_BACKFILL'
LEFT JOIN BLOCKCHAIN_AUDIT_LOG later_event
  ON later_event.Payroll_ID = pr.Payroll_ID
 AND later_event.Audit_ID <> backfill.Audit_ID
WHERE later_event.Audit_ID IS NULL
  AND pr.Approval_Status = 'Submitted'
  AND pr.Blockchain_Status = 'PENDING_APPROVAL';

DELETE FROM BLOCKCHAIN_AUDIT_LOG
WHERE Event_Type = 'PAYROLL_SUBMITTED_BACKFILL';
