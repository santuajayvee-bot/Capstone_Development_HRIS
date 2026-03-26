-- Migration: Add custom wage structure for Production and Logistics departments
-- This adds support for per-piece and per-trip wage calculations

USE lgsv_hr_db;

-- 1. Wage Types table
CREATE TABLE IF NOT EXISTS wage_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  description VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO wage_types (name, description) VALUES
  ('Base Salary', 'Fixed monthly/fixed salary'),
  ('Hourly', 'Hourly wage with overtime'),
  ('Per-Piece', 'Production: paid per item produced'),
  ('Per-Trip', 'Logistics: paid per delivery trip');

-- 2. Sewing Types table (for Production department)
CREATE TABLE IF NOT EXISTS sewing_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  default_rate DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO sewing_types (name, description, default_rate) VALUES
  ('Buttonhole Sewing', 'Button hole stitching', 2.50),
  ('Hem Sewing', 'Bottom hem finishing', 1.50),
  ('Zipper Installation', 'Zipper attachment', 3.00),
  ('Seam Sewing', 'Main seam stitching', 2.00),
  ('Cuff Sewing', 'Sleeve cuff finishing', 1.80),
  ('Label Sewing', 'Label attachment', 0.75),
  ('Other', 'Other sewing tasks', 2.00);

-- 3. Logistics Regions table (for Logistics department)
CREATE TABLE IF NOT EXISTS logistics_regions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  code VARCHAR(10),
  description TEXT,
  default_rate DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO logistics_regions (name, code, description, default_rate) VALUES
  ('Manila', 'MNL', 'Metro Manila area', 250.00),
  ('Luzon Province', 'LZN', 'Outside Manila in Luzon', 400.00),
  ('Visayas', 'VIS', 'Visayas region', 600.00),
  ('Mindanao', 'MND', 'Mindanao region', 800.00),
  ('Provincial', 'PRV', 'General provincial delivery', 350.00);

-- 4. Employee Wage Rates table (custom rates per employee)
CREATE TABLE IF NOT EXISTS employee_wage_rates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  wage_type_id INT NOT NULL,
  base_rate DECIMAL(10, 2) NULL,
  sewing_type_id INT NULL,
  logistics_region_id INT NULL,
  rate DECIMAL(10, 2) NOT NULL,
  notes TEXT,
  effective_date DATE DEFAULT CURDATE(),
  end_date DATE NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (wage_type_id) REFERENCES wage_types(id),
  FOREIGN KEY (sewing_type_id) REFERENCES sewing_types(id),
  FOREIGN KEY (logistics_region_id) REFERENCES logistics_regions(id)
);

-- 5. Production Transactions table (track pieces produced)
CREATE TABLE IF NOT EXISTS production_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  sewing_type_id INT NOT NULL,
  quantity INT NOT NULL,
  rate DECIMAL(10, 2) NOT NULL,
  amount DECIMAL(10, 2) GENERATED ALWAYS AS (quantity * rate) STORED,
  transaction_date DATE NOT NULL DEFAULT CURDATE(),
  week_number INT,
  month_year VARCHAR(10),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (sewing_type_id) REFERENCES sewing_types(id),
  KEY idx_emp_date (employee_id, transaction_date),
  KEY idx_month_year (month_year)
);

-- 6. Logistics Transactions table (track trips completed)
CREATE TABLE IF NOT EXISTS logistics_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  logistics_region_id INT NOT NULL,
  rate DECIMAL(10, 2) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  trip_reference VARCHAR(100) NULL,
  transaction_date DATE NOT NULL DEFAULT CURDATE(),
  week_number INT,
  month_year VARCHAR(10),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (logistics_region_id) REFERENCES logistics_regions(id),
  KEY idx_emp_date (employee_id, transaction_date),
  KEY idx_month_year (month_year)
);

-- 7. Payroll Runs table (batch payroll generation)
CREATE TABLE IF NOT EXISTS payroll_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  month_year VARCHAR(10) NOT NULL UNIQUE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  total_employees INT,
  total_amount DECIMAL(15, 2),
  status ENUM('Draft', 'Pending Review', 'Approved', 'Disbursed') DEFAULT 'Draft',
  created_by INT,
  reviewed_by INT NULL,
  approved_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- 8. Payslips table (individual employee payslips)
CREATE TABLE IF NOT EXISTS payslips (
  id INT AUTO_INCREMENT PRIMARY KEY,
  payroll_run_id INT NOT NULL,
  employee_id INT NOT NULL,
  wage_type_id INT NOT NULL,
  total_earning DECIMAL(10, 2),
  total_deduction DECIMAL(10, 2),
  net_pay DECIMAL(10, 2),
  notes TEXT,
  status ENUM('Pending', 'Approved', 'Disbursed') DEFAULT 'Pending',
  disbursed_date TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (wage_type_id) REFERENCES wage_types(id),
  UNIQUE KEY unique_payslip (payroll_run_id, employee_id)
);

-- 9. Deductions table (for storing employee deductions like SSS, PhilHealth, etc.)
CREATE TABLE IF NOT EXISTS employee_deductions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  deduction_type VARCHAR(50) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  start_date DATE,
  end_date DATE NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  KEY idx_emp_date (employee_id, start_date)
);

-- Add wage_type_id column to employees table if it doesn't exist
ALTER TABLE employees ADD COLUMN IF NOT EXISTS wage_type_id INT AFTER employment_type;
ALTER TABLE employees ADD CONSTRAINT fk_emp_wage_type FOREIGN KEY (wage_type_id) REFERENCES wage_types(id);

-- Add beneficiary/government IDs to employees table
ALTER TABLE employees ADD COLUMN IF NOT EXISTS sss_number VARCHAR(20);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS philhealth_number VARCHAR(20);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pagibig_number VARCHAR(20);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS tin VARCHAR(20);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_account VARCHAR(50);

-- Update status to include more options
ALTER TABLE employees MODIFY COLUMN status ENUM('Active','Inactive','Resigned','On Leave','Suspended') DEFAULT 'Active';

COMMIT;
