ALTER TABLE attendance_log
  ADD COLUMN IF NOT EXISTS am_time_in TIME NULL AFTER time_out,
  ADD COLUMN IF NOT EXISTS am_time_out TIME NULL AFTER am_time_in,
  ADD COLUMN IF NOT EXISTS pm_time_in TIME NULL AFTER am_time_out,
  ADD COLUMN IF NOT EXISTS pm_time_out TIME NULL AFTER pm_time_in;

UPDATE attendance_log
   SET am_time_in = CASE
         WHEN am_time_in IS NULL AND time_in IS NOT NULL AND TIME_TO_SEC(time_in) < TIME_TO_SEC('12:00:00') THEN time_in
         ELSE am_time_in
       END,
       pm_time_in = CASE
         WHEN pm_time_in IS NULL AND time_in IS NOT NULL AND TIME_TO_SEC(time_in) >= TIME_TO_SEC('12:00:00') THEN time_in
         ELSE pm_time_in
       END,
       am_time_out = CASE
         WHEN am_time_out IS NULL AND time_out IS NOT NULL AND TIME_TO_SEC(time_out) < TIME_TO_SEC('12:00:00') THEN time_out
         ELSE am_time_out
       END,
       pm_time_out = CASE
         WHEN pm_time_out IS NULL AND time_out IS NOT NULL AND TIME_TO_SEC(time_out) >= TIME_TO_SEC('12:00:00') THEN time_out
         ELSE pm_time_out
       END;

UPDATE attendance_log
   SET am_time_out = CASE
         WHEN am_time_out IS NULL
          AND am_time_in IS NOT NULL
          AND pm_time_out IS NOT NULL
          AND TIME_TO_SEC(am_time_in) < TIME_TO_SEC('12:00:00')
          AND TIME_TO_SEC(pm_time_out) > TIME_TO_SEC('13:00:00')
         THEN '12:00:00'
         ELSE am_time_out
       END,
       pm_time_in = CASE
         WHEN pm_time_in IS NULL
          AND am_time_in IS NOT NULL
          AND pm_time_out IS NOT NULL
          AND TIME_TO_SEC(am_time_in) < TIME_TO_SEC('12:00:00')
          AND TIME_TO_SEC(pm_time_out) > TIME_TO_SEC('13:00:00')
         THEN '13:00:00'
         ELSE pm_time_in
       END
 WHERE source <> 'BIOMETRIC_API';
