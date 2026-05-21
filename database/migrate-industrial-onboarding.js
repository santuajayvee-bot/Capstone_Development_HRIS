/* ============================================================
   database/migrate-industrial-onboarding.js
   Aligns onboarding with Marulas Industrial specific constraints.
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

async function migrate() {
  const conn = await pool.getConnection();
  try {
    console.log('🏗️  Re-aligning Onboarding for Industrial Constraints...');

    // 1. Add specific readiness flags to employees
    await conn.execute(`
      ALTER TABLE employees 
      ADD COLUMN IF NOT EXISTS biometric_status ENUM('pending', 'completed') DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS safety_test_status ENUM('not_started', 'passed', 'failed') DEFAULT 'not_started',
      ADD COLUMN IF NOT EXISTS wage_rate_locked TINYINT(1) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS blockchain_baseline_hash VARCHAR(255) DEFAULT NULL
    `);
    console.log('   ✅ Added industrial readiness flags (Biometric, Safety, Wage Lock).');

    // 2. Add an indexing to speed up payroll-readiness queries
    try {
      await conn.execute('CREATE INDEX idx_wage_readiness ON employees (onboarding_status, wage_rate_locked)');
      console.log('   ✅ Created index for wage readiness tracking.');
    } catch (e) {}

    console.log('\n✅ Industrial re-alignment migration successful.');

  } catch (err) {
    console.error('❌ Migration error:', err.message);
  } finally {
    conn.release();
    process.exit(0);
  }
}

migrate();
