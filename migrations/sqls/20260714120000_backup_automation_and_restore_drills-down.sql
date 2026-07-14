ALTER TABLE backup_sets
  DROP FOREIGN KEY fk_backup_sets_schedule,
  DROP INDEX idx_backup_sets_schedule,
  DROP INDEX idx_backup_sets_retention,
  DROP CONSTRAINT chk_backup_sets_expiry,
  DROP CONSTRAINT chk_backup_sets_retention_evidence,
  DROP COLUMN IF EXISTS artifact_deleted_at,
  DROP COLUMN IF EXISTS retention_status,
  DROP COLUMN IF EXISTS expires_at,
  DROP COLUMN IF EXISTS schedule_id;

DROP TABLE IF EXISTS backup_restore_drill_runs;

DROP TABLE IF EXISTS backup_restore_drill_schedules;

DROP TABLE IF EXISTS backup_action_notifications;

DROP TABLE IF EXISTS backup_schedules;

DROP TABLE IF EXISTS backup_retention_policies;
