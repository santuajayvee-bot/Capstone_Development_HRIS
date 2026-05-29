const pool = require('../config/db');

async function migrate() {
  const connection = await pool.getConnection();

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS employee_certifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        certification_name VARCHAR(255) NOT NULL,
        issuing_organization VARCHAR(255) NULL,
        issue_date DATE NULL,
        expiry_date DATE NULL,
        certificate_file_name VARCHAR(255) NULL,
        certificate_file_path VARCHAR(500) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS employee_trainings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        training_name VARCHAR(255) NOT NULL,
        provider VARCHAR(255) NULL,
        date_from DATE NULL,
        date_to DATE NULL,
        training_hours DECIMAL(8,2) NULL,
        remarks TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS employee_skills (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        skill_name VARCHAR(255) NOT NULL,
        proficiency VARCHAR(100) NULL,
        remarks TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
      )
    `);

    console.log('Education/training record tables are ready.');
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate().catch(error => {
  console.error('Education/training migration failed:', error);
  process.exit(1);
});
