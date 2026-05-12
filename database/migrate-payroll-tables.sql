-- Migration: Create Payroll Tables (payroll_runs, payslips, wage_types)
-- This creates the necessary tables for the payroll system to track payroll runs and payslips

-- Create wage_types table
CREATE TABLE IF NOT EXISTS wage_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default wage types
INSERT IGNORE INTO wage_types (name, description) VALUES
  ('Base Salary', 'Fixed monthly salary'),
  ('Hourly', 'Hourly wage rate with overtime support'),
  ('Per-Piece', 'Production-based pay'),
  ('Per-Trip', 'Logistics/delivery-based pay');

-- Create payroll_runs table (tracks when payroll was run)
CREATE TABLE IF NOT EXISTS payroll_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  month_year VARCHAR(7) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status ENUM('Draft','Generated','Approved','Disbursed','Cancelled') DEFAULT 'Draft',
  total_employees INT DEFAULT 0,
  total_payroll DECIMAL(12, 2) DEFAULT 0,
  total_deductions DECIMAL(12, 2) DEFAULT 0,
  processed_by INT,
  approved_by INT,
  approved_date TIMESTAMP NULL,
  disbursed_date TIMESTAMP NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (processed_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY unique_payroll_run (month_year),
  INDEX idx_status (status)
);

-- Create payslips table (individual employee payroll records)
CREATE TABLE IF NOT EXISTS payslips (
  id INT AUTO_INCREMENT PRIMARY KEY,
  payroll_run_id INT NOT NULL,
  employee_id INT NOT NULL,
  wage_type_id INT,
  base_rate DECIMAL(10, 2),
  quantity INT DEFAULT 1,
  total_earning DECIMAL(12, 2) NOT NULL,
  sss_contribution DECIMAL(10, 2) DEFAULT 0,
  pagibig_contribution DECIMAL(10, 2) DEFAULT 0,
  philhealth_contribution DECIMAL(10, 2) DEFAULT 0,
  other_deductions DECIMAL(10, 2) DEFAULT 0,
  total_deduction DECIMAL(12, 2) NOT NULL,
  net_pay DECIMAL(12, 2) NOT NULL,
  status ENUM('Draft','Approved','Disbursed','Cancelled') DEFAULT 'Draft',
  disbursed_date TIMESTAMP NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (wage_type_id) REFERENCES wage_types(id) ON DELETE SET NULL,
  INDEX idx_employee_payroll (employee_id, payroll_run_id),
  INDEX idx_status (status)
);

-- Add wage_type_id to employees table if it doesn't exist (may already exist in schema)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS wage_type_id INT DEFAULT 1 AFTER employment_type;

-- Add foreign key constraint if not already present (syntax varies by MySQL version)
-- This will fail silently if the column doesn't exist or constraint already exists
