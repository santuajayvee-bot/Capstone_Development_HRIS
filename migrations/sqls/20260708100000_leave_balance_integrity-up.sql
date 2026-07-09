ALTER TABLE leave_balances
  ADD COLUMN IF NOT EXISTS integrity_hash CHAR(64) NULL AFTER remaining_days;

UPDATE leave_balances
   SET integrity_hash = SHA2(CONCAT_WS('|',
       'leave_balance:v1',
       COALESCE(CAST(employee_id AS CHAR), ''),
       COALESCE(CAST(leave_type_id AS CHAR), ''),
       COALESCE(leave_type, ''),
       COALESCE(CAST(year AS CHAR), ''),
       CAST(CAST(COALESCE(balance, 0) AS DECIMAL(12,2)) AS CHAR),
       CAST(CAST(COALESCE(used, 0) AS DECIMAL(12,2)) AS CHAR),
       CAST(CAST(COALESCE(total_days, 0) AS DECIMAL(12,2)) AS CHAR),
       CAST(CAST(COALESCE(used_days, 0) AS DECIMAL(12,2)) AS CHAR),
       CAST(CAST(COALESCE(remaining_days, 0) AS DECIMAL(12,2)) AS CHAR)
     ), 256)
 WHERE integrity_hash IS NULL;
