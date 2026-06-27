ALTER TABLE attendance_log
  DROP COLUMN IF EXISTS pm_time_out,
  DROP COLUMN IF EXISTS pm_time_in,
  DROP COLUMN IF EXISTS am_time_out,
  DROP COLUMN IF EXISTS am_time_in;
