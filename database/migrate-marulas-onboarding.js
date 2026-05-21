/* ============================================================
   database/migrate-marulas-onboarding.js
   Updates employees table and creates audit_logs for MIC.
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

async function migrate() {
  const conn = await pool.getConnection();
  try {
    console.log('🔄 Updating Database for Marulas Industrial Corp...');

    // 1. Update Employees Table
    await conn.execute(`
      ALTER TABLE employees 
      ADD COLUMN IF NOT EXISTS dob DATE,
      ADD COLUMN IF NOT EXISTS gender ENUM('Male', 'Female', 'Other'),
      ADD COLUMN IF NOT EXISTS marital_status VARCHAR(20),
      ADD COLUMN IF NOT EXISTS blood_type VARCHAR(5),
      ADD COLUMN IF NOT EXISTS mobile VARCHAR(100), -- Encrypted
      ADD COLUMN IF NOT EXISTS address TEXT,         -- Encrypted
      ADD COLUMN IF NOT EXISTS branch VARCHAR(50),
      ADD COLUMN IF NOT EXISTS worker_category ENUM('Regular', 'Agency'),
      ADD COLUMN IF NOT EXISTS wage_structure ENUM('Fixed', 'Hourly', 'Piece-Rate', 'Per-Trip'),
      ADD COLUMN IF NOT EXISTS tin VARCHAR(255),    -- Encrypted
      ADD COLUMN IF NOT EXISTS sss VARCHAR(255),    -- Encrypted
      ADD COLUMN IF NOT EXISTS philhealth VARCHAR(255), -- Encrypted
      ADD COLUMN IF NOT EXISTS pagibig VARCHAR(255), -- Encrypted
      ADD COLUMN IF NOT EXISTS data_consent TINYINT(1) DEFAULT 0
    `);
    console.log('   ✅ Employees table updated with PII and Industrial fields.');

    // 2. Create Audit Logs Table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        action VARCHAR(255),
        details TEXT,
        ip_address VARCHAR(45),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    console.log('   ✅ Table created: audit_logs');

    console.log('\n✅ Migration successful.');

  } catch (err) {
    console.error('❌ Migration error:', err.message);
  } finally {
    conn.release();
    process.exit(0);
  }
}

migrate();
