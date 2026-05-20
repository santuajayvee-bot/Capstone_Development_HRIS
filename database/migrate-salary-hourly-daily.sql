-- Migration: Add hourly and daily wage support to salary_calculations
-- This adds columns for hours_worked, days_worked, and daily_rate
-- Allows proper calculation for Hourly and Daily wage types

USE lgsv_hr_db;

-- Add new columns to salary_calculations table
ALTER TABLE salary_calculations 
  ADD COLUMN IF NOT EXISTS hours_worked DECIMAL(10, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS days_worked DECIMAL(10, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_rate DECIMAL(10, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hourly_rate DECIMAL(10, 2) DEFAULT 0;

-- Add Daily wage type if it doesn't exist
INSERT IGNORE INTO wage_types (name, description) VALUES
  ('Daily', 'Daily wage with daily rates');

-- Ensure employees table has wage_type properly set up
ALTER TABLE employees 
  ADD COLUMN IF NOT EXISTS daily_rate DECIMAL(10, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hourly_rate DECIMAL(10, 2) DEFAULT 0;

-- Create index for faster lookups
ALTER TABLE salary_calculations 
  ADD INDEX IF NOT EXISTS idx_emp_wage_date (employee_id, wage_type_id, calculation_date);

COMMIT;
