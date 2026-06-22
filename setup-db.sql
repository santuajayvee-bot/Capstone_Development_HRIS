-- Create database
CREATE DATABASE IF NOT EXISTS lgsv_hr_db;
USE lgsv_hr_db;

-- Roles table
CREATE TABLE roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  label VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Departments table
CREATE TABLE departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE
);

-- Users table
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role_id INT NOT NULL,
  employee_id INT NULL,
  is_active TINYINT(1) DEFAULT 1,
  last_login TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (role_id) REFERENCES roles(id)
);

-- Employees table
CREATE TABLE employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_code VARCHAR(20) NOT NULL UNIQUE,
  first_name VARCHAR(100) NOT NULL,
  middle_name VARCHAR(100) NULL,
  last_name VARCHAR(100) NOT NULL,
  suffix VARCHAR(10) NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  contact_number VARCHAR(20) NULL,
  nationality VARCHAR(50) DEFAULT 'Filipino',
  date_of_birth DATE NULL,
  gender ENUM('Male','Female','Prefer not to say') NULL,
  residential_address TEXT NULL,
  emergency_contact_name VARCHAR(100) NULL,
  emergency_contact_num VARCHAR(20) NULL,
  department_id INT NULL,
  position VARCHAR(100) NULL,
  employment_type ENUM('Full-time','Part-time','Contractual') DEFAULT 'Full-time',
  date_hired DATE NULL,
  supervisor VARCHAR(100) NULL,
  work_location VARCHAR(100) NULL,
  status ENUM('Active','Inactive','Resigned') DEFAULT 'Active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

-- Documents table (for storing employee uploaded files)
CREATE TABLE documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  document_type ENUM('Resume','Government_ID','NBI_Clearance','Other') NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  uploaded_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  INDEX idx_documents_employee_type_uploaded (employee_id, document_type, uploaded_date)
);

-- Leave Requests table
CREATE TABLE leave_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  type VARCHAR(50) NOT NULL,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  days INT DEFAULT 1,
  reason TEXT,
  status ENUM('Pending','Approved','Denied') DEFAULT 'Pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reviewed_by INT NULL,
  reviewed_at TIMESTAMP NULL,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Insert default roles
INSERT INTO roles (name, label) VALUES
  ('system_admin', 'System Administrator'),
  ('hr_admin', 'HR Manager'),
  ('hr_manager', 'HR Manager'),
  ('payroll_officer', 'Payroll Officer'),
  ('payroll_manager', 'Payroll Manager'),
  ('employee', 'Employee');

-- Insert departments
INSERT INTO departments (name) VALUES
  ('HR'), ('Accounting'), ('Production'), ('Logistics'), ('Personnel');
