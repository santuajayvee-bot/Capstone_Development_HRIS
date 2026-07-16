-- The fixed one-System-Administrator workflow allows the same authenticated
-- administrator to verify and approve. MySQL/RDS also rejects CHECK
-- constraints that reference columns with SET NULL referential actions, so
-- maker-checker enforcement stays in the service layer while MFA/evidence,
-- idempotency, and integrity constraints remain enforced here.
SELECT 1;
