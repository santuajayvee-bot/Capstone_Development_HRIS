UPDATE payroll_deduction_settings
   SET proration_mode = 'Calendar-Based Payroll Date Range',
       fixed_divisor = NULL
 WHERE category = 'Government'
   AND LOWER(REPLACE(name, '-', '')) IN ('sss', 'philhealth', 'pagibig');
