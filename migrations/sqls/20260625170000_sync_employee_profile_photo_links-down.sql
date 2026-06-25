UPDATE employees e
JOIN migration_20260625170000_employee_photo_link_backup b
  ON b.employee_id = e.id
   SET e.photo_id = b.old_photo_id;

DROP TABLE IF EXISTS migration_20260625170000_employee_photo_link_backup;
