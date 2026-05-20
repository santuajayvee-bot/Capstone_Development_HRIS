/* ============================================================
   database/migrate-onboarding.js
   Creates tables for the Employee Onboarding Module.
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

async function migrateOnboarding() {
  const conn = await pool.getConnection();
  try {
    console.log('🔄 Migrating Onboarding Module Tables...\n');

    // 1. Onboarding Tasks
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS onboarding_tasks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        task_name VARCHAR(255) NOT NULL,
        description TEXT,
        assignee_role VARCHAR(50) DEFAULT 'HR',
        due_date DATE,
        status ENUM('pending', 'in_progress', 'completed', 'overdue') DEFAULT 'pending',
        completed_at DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
      )
    `);
    console.log('   ✅ Table created: onboarding_tasks');

    // 2. Onboarding Documents
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS onboarding_documents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        document_name VARCHAR(255) NOT NULL,
        document_type ENUM('contract', 'nda', 'tax', 'policy', 'other') DEFAULT 'other',
        file_path VARCHAR(500),
        status ENUM('pending', 'submitted', 'approved', 'rejected') DEFAULT 'pending',
        uploaded_at DATETIME,
        verified_at DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
      )
    `);
    console.log('   ✅ Table created: onboarding_documents');

    // 3. Onboarding Learning
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS onboarding_learning (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        module_name VARCHAR(255) NOT NULL,
        category VARCHAR(100),
        progress INT DEFAULT 0, -- 0 to 100
        status ENUM('not_started', 'in_progress', 'completed') DEFAULT 'not_started',
        completed_at DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
      )
    `);
    console.log('   ✅ Table created: onboarding_learning');

    // 4. Onboarding Feedback
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS onboarding_feedback (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        rating INT DEFAULT 5, -- 1 to 5
        comments TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
      )
    `);
    console.log('   ✅ Table created: onboarding_feedback');

    console.log('\n✅ Onboarding migration completed successfully.');

  } catch (err) {
    console.error('❌ Migration error:', err.message);
  } finally {
    conn.release();
    process.exit(0);
  }
}

migrateOnboarding();
