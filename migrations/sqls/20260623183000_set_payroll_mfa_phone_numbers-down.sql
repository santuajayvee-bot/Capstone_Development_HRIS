UPDATE employees e
JOIN users u ON u.employee_id = e.id
   SET e.contact_number = NULL
 WHERE (LOWER(u.username) = 'payroll.officer' AND e.contact_number = '09181234567')
    OR (LOWER(u.username) = 'payroll.manager' AND e.contact_number = '09191234567');
