-- No-op rollback by design.
-- These columns belong to the shared system audit log and may be used by
-- authentication, RBAC, DPA, blockchain, attendance, and payroll audit trails.
SELECT 1;
