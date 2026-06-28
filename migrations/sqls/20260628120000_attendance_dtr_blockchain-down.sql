-- DOWN migration: remove Attendance DTR blockchain anchoring tables only.
-- Raw attendance tables are intentionally untouched.

DROP TABLE IF EXISTS DTR_ADJUSTMENT_RECORD;
DROP TABLE IF EXISTS DTR_BLOCKCHAIN_AUDIT_LOG;
DROP TABLE IF EXISTS DTR_RECORD;
