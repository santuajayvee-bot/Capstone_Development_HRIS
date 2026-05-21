-- Create employee_photos table to store employee profile pictures
CREATE TABLE IF NOT EXISTS employee_photos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL UNIQUE,
  photo_data LONGBLOB NOT NULL,
  photo_mime_type VARCHAR(50) DEFAULT 'image/jpeg',
  photo_size INT,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  INDEX idx_employee_id (employee_id)
);

-- Add photo column to employees table for quick reference
ALTER TABLE employees ADD COLUMN photo_id INT DEFAULT NULL AFTER status;
