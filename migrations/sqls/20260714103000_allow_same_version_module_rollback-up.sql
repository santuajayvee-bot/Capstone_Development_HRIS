-- A verified recovery artifact may carry the same semantic version as the
-- damaged deployment. Artifact identity and safety are enforced by the
-- recovery-point foreign key, SHA-256 checksum, maker-checker approval, MFA,
-- lifecycle state, and post-cutover integrity verification.
ALTER TABLE module_rollback_requests
  DROP CONSTRAINT chk_module_rollback_versions;
