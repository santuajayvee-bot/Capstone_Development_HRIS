-- Preserve existing rows before restoring the historical string-inequality
-- constraint. The recovery point and checksum remain the authoritative
-- artifact identity; this suffix only makes legacy version labels distinct.
UPDATE module_rollback_requests
   SET target_version = CONCAT(LEFT(target_version, 71), '+rollback')
 WHERE current_version IS NOT NULL
   AND target_version IS NOT NULL
   AND current_version = target_version;

ALTER TABLE module_rollback_requests
  ADD CONSTRAINT chk_module_rollback_versions
  CHECK (current_version IS NULL OR target_version IS NULL OR current_version <> target_version);
