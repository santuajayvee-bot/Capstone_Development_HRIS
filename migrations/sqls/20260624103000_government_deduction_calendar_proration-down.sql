UPDATE payroll_deduction_settings
   SET proration_mode = 'Fixed Divisor',
       fixed_divisor = CASE
         WHEN apply_schedule = 'Monthly' THEN 1
         WHEN apply_schedule IN ('Semi-Monthly','First Payroll of Month','Last Payroll of Month') THEN 2
         ELSE 4
       END
 WHERE category = 'Government'
   AND LOWER(REPLACE(name, '-', '')) IN ('sss', 'philhealth', 'pagibig');
