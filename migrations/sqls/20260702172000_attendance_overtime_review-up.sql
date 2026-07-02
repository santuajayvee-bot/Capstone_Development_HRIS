ALTER TABLE attendance_log
  ADD COLUMN IF NOT EXISTS overtime_status ENUM('NONE','PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'NONE' AFTER overtime_minutes,
  ADD COLUMN IF NOT EXISTS overtime_reviewed_by BIGINT NULL AFTER overtime_status,
  ADD COLUMN IF NOT EXISTS overtime_reviewed_at DATETIME NULL AFTER overtime_reviewed_by,
  ADD COLUMN IF NOT EXISTS overtime_review_reason VARCHAR(500) NULL AFTER overtime_reviewed_at;

ALTER TABLE attendance_summary
  ADD COLUMN IF NOT EXISTS overtime_status ENUM('NONE','PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'NONE' AFTER overtime_minutes;

UPDATE attendance_log
   SET overtime_status = CASE
         WHEN COALESCE(overtime_minutes, 0) > 0 THEN 'PENDING'
         ELSE 'NONE'
       END
 WHERE overtime_status = 'NONE';

UPDATE attendance_summary ats
JOIN attendance_log al ON al.attendance_id = ats.attendance_id
   SET ats.overtime_status = al.overtime_status
 WHERE ats.overtime_status = 'NONE'
   AND COALESCE(al.overtime_minutes, 0) > 0;

UPDATE attendance_summary
   SET overtime_minutes = 0
 WHERE overtime_status <> 'APPROVED';
