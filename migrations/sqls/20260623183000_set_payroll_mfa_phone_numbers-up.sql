UPDATE employees e
JOIN users u ON u.employee_id = e.id
   SET e.contact_number = CASE
     WHEN LOWER(u.username) = 'payroll.officer' THEN '09181234567'
     WHEN LOWER(u.username) = 'payroll.manager' THEN '09191234567'
     ELSE e.contact_number
   END
 WHERE LOWER(u.username) IN ('payroll.officer', 'payroll.manager');
