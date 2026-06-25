CREATE TABLE IF NOT EXISTS migration_20260625170000_employee_photo_link_backup (
  employee_id BIGINT NOT NULL,
  old_photo_id BIGINT NULL,
  backed_up_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO migration_20260625170000_employee_photo_link_backup
  (employee_id, old_photo_id)
SELECT e.id, e.photo_id
  FROM employees e
  JOIN employee_photos p ON p.employee_id = e.id
 WHERE e.photo_id IS NULL
    OR e.photo_id <> p.id;

UPDATE employees e
JOIN employee_photos p ON p.employee_id = e.id
   SET e.photo_id = p.id
 WHERE e.photo_id IS NULL
    OR e.photo_id <> p.id;
