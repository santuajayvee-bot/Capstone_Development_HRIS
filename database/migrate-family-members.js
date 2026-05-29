const pool = require('../config/db');

async function migrate() {
  const sql = `
    CREATE TABLE IF NOT EXISTS employee_family_members (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      relationship_type VARCHAR(80) NOT NULL,
      extension_name VARCHAR(20) NULL,
      first_name VARCHAR(100) NOT NULL,
      middle_name VARCHAR(100) NULL,
      last_name VARCHAR(100) NOT NULL,
      date_of_birth DATE NULL,
      telephone_number VARCHAR(50) NULL,
      business_address TEXT NULL,
      occupation VARCHAR(150) NULL,
      employer_name VARCHAR(150) NULL,
      deceased TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_family_employee
        FOREIGN KEY (employee_id) REFERENCES employees(id)
        ON DELETE CASCADE
    )
  `;

  await pool.execute(sql);
  console.log('employee_family_members table is ready.');
  await pool.end();
}

migrate().catch(error => {
  console.error('Family member migration failed:', error);
  process.exit(1);
});
