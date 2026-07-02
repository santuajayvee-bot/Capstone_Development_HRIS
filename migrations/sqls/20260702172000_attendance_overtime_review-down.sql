ALTER TABLE attendance_summary
  DROP COLUMN IF EXISTS overtime_status;

ALTER TABLE attendance_log
  DROP COLUMN IF EXISTS overtime_review_reason,
  DROP COLUMN IF EXISTS overtime_reviewed_at,
  DROP COLUMN IF EXISTS overtime_reviewed_by,
  DROP COLUMN IF EXISTS overtime_status;
