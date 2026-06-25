DELETE rp
  FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id
  JOIN permissions p ON p.id = rp.permission_id
 WHERE r.name = 'employee'
   AND p.permission_key = 'payroll.view';
