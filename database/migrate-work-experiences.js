const pool = require('../config/db');

async function migrate() {
  const sql = `
    CREATE TABLE IF NOT EXISTS employee_work_experiences (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      company_name VARCHAR(255) NOT NULL,
      position_title VARCHAR(150) NOT NULL,
      employment_type VARCHAR(100) NULL,
      date_from VARCHAR(20) NULL,
      date_to VARCHAR(20) NULL,
      supervisor_name VARCHAR(150) NULL,
      company_address TEXT NULL,
      reason_for_leaving TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_work_experience_employee
        FOREIGN KEY (employee_id) REFERENCES employees(id)
        ON DELETE CASCADE
    )
  `;

  await pool.execute(sql);
  console.log('employee_work_experiences table is ready.');
  await pool.end();
}

migrate().catch(error => {
  console.error('Work experience migration failed:', error);
  process.exit(1);
});
