-- Migration: Create salary_calculations table for storing Base Salary and Hourly wage calculations
-- This stores individual salary calculations before they're aggregated into payslips

USE lgsv_hr_db;

CREATE TABLE IF NOT EXISTS salary_calculations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  wage_type_id INT NOT NULL,
  
  -- Calculation inputs
  base_rate DECIMAL(10, 2) NOT NULL,
  quantity DECIMAL(10, 2) NOT NULL DEFAULT 1,
  
  -- Allowances
  housing_allowance DECIMAL(10, 2) DEFAULT 0,
  meal_allowance DECIMAL(10, 2) DEFAULT 0,
  transport_allowance DECIMAL(10, 2) DEFAULT 0,
  bonus_allowance DECIMAL(10, 2) DEFAULT 0,
  total_allowances DECIMAL(10, 2) DEFAULT 0,
  
  -- Overtime
  overtime_hours DECIMAL(10, 2) DEFAULT 0,
  overtime_amount DECIMAL(10, 2) DEFAULT 0,
  
  -- Salary calculations
  gross_pay DECIMAL(10, 2) NOT NULL,
  
  -- Deductions
  sss_deduction DECIMAL(10, 2) DEFAULT 0,      -- 4.5%
  pagibig_deduction DECIMAL(10, 2) DEFAULT 0,  -- 2%
  philhealth_deduction DECIMAL(10, 2) DEFAULT 0, -- 2.75%
  total_deductions DECIMAL(10, 2) DEFAULT 0,
  
  -- Net pay
  net_pay DECIMAL(10, 2) NOT NULL,
  
  -- Metadata
  calculation_date DATE NOT NULL DEFAULT CURDATE(),
  notes TEXT,
  status ENUM('Draft', 'Submitted', 'Approved') DEFAULT 'Submitted',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (wage_type_id) REFERENCES wage_types(id),
  KEY idx_emp_date (employee_id, calculation_date),
  KEY idx_wage_type (wage_type_id)
);

-- Add index for retrieving calculations by month
ALTER TABLE salary_calculations ADD INDEX idx_calculation_month (YEAR(calculation_date), MONTH(calculation_date));
