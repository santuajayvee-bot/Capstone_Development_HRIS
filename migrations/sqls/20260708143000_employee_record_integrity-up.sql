ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS integrity_hash CHAR(64) NULL;

UPDATE employees
   SET integrity_hash = SHA2(CONCAT_WS('|',
       'employee:v2',
       COALESCE(employee_code, ''),
       COALESCE(first_name, ''),
       COALESCE(middle_name, ''),
       COALESCE(last_name, ''),
       COALESCE(suffix, ''),
       COALESCE(email, ''),
       COALESCE(contact_number, ''),
       COALESCE(CAST(department_id AS CHAR), ''),
       COALESCE(position, ''),
       COALESCE(employment_type, ''),
       COALESCE(status, ''),
       COALESCE(hiring_type, ''),
       COALESCE(deployment_status, ''),
       COALESCE(supervisor, ''),
       COALESCE(work_location, ''),
       COALESCE(shift_schedule, ''),
       COALESCE(sss_number, ''),
       COALESCE(philhealth_number, ''),
       COALESCE(pagibig_number, ''),
       COALESCE(tin, ''),
       COALESCE(tax_status, ''),
       COALESCE(bank_name, ''),
       COALESCE(bank_account, '')
     ), 256)
 WHERE integrity_hash IS NULL;
