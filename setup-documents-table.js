// Setup documents table
const pool = require('./config/db');

async function setupDocumentsTable() {
  try {
    const query = `
      CREATE TABLE IF NOT EXISTS documents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        document_type ENUM('Resume','Government_ID','NBI_Clearance','Other') NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        file_path VARCHAR(500) NOT NULL,
        uploaded_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
        UNIQUE KEY unique_doc_per_emp (employee_id, document_type)
      )
    `;
    
    await pool.execute(query);
    console.log('✅ Documents table created successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error creating documents table:', err.message);
    process.exit(1);
  }
}

setupDocumentsTable();
