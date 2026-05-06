/* ============================================================
   database/migrate-201-file-management.js
   Add 201-file management tables and columns.
   ============================================================ */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const pool = require(require('path').join(__dirname, '..', 'config', 'db'));

async function migrate201Files() {
  const conn = await pool.getConnection();
  try {
    console.log('\n🔄 Migrating 201-File Management schema...\n');

    // 1. Extend documents table with verification fields
    console.log('   📄 Updating documents table...');
    try {
      await conn.execute(`
        ALTER TABLE documents ADD COLUMN verification_status ENUM('Pending','Verified','Rejected') DEFAULT 'Pending'
      `);
      console.log('      ✅ Added verification_status');
    } catch (e) {
      if (!e.message.includes('already exists')) throw e;
      console.log('      ⚠️  verification_status already exists');
    }

    try {
      await conn.execute(`
        ALTER TABLE documents ADD COLUMN verified_by INT NULL
      `);
      console.log('      ✅ Added verified_by');
    } catch (e) {
      if (!e.message.includes('already exists')) throw e;
      console.log('      ⚠️  verified_by already exists');
    }

    try {
      await conn.execute(`
        ALTER TABLE documents ADD COLUMN verified_at TIMESTAMP NULL
      `);
      console.log('      ✅ Added verified_at');
    } catch (e) {
      if (!e.message.includes('already exists')) throw e;
      console.log('      ⚠️  verified_at already exists');
    }

    try {
      await conn.execute(`
        ALTER TABLE documents ADD COLUMN rejection_reason TEXT NULL
      `);
      console.log('      ✅ Added rejection_reason');
    } catch (e) {
      if (!e.message.includes('already exists')) throw e;
      console.log('      ⚠️  rejection_reason already exists');
    }

    // 2. Create sensitive_employee_data table
    console.log('\n   🔐 Creating sensitive_employee_data table...');
    try {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS sensitive_employee_data (
          id INT AUTO_INCREMENT PRIMARY KEY,
          employee_id INT NOT NULL UNIQUE,
          ssn VARCHAR(20) NULL COMMENT 'Social Security Number or TIN',
          tax_id VARCHAR(50) NULL COMMENT 'BIR Tax ID',
          bank_account_number VARCHAR(50) NULL,
          bank_routing_number VARCHAR(50) NULL,
          emergency_contact_phone VARCHAR(20) NULL,
          other_sensitive_info TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          updated_by INT NULL,
          FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
          FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
        )
      `);
      console.log('      ✅ Created sensitive_employee_data table');
    } catch (e) {
      if (!e.message.includes('already exists')) throw e;
      console.log('      ⚠️  sensitive_employee_data table already exists');
    }

    // 3. Create 201-file access audit log table
    console.log('\n   📋 Creating employee_201_file_access_log table...');
    try {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS employee_201_file_access_log (
          id INT AUTO_INCREMENT PRIMARY KEY,
          employee_id INT NOT NULL,
          accessed_by INT NOT NULL,
          accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          action VARCHAR(50) NOT NULL COMMENT 'view, edit, document_upload, document_verify, sensitive_data_view',
          resource_type VARCHAR(50) NULL COMMENT 'document, sensitive_data, employee_info',
          resource_id INT NULL,
          details TEXT NULL COMMENT 'JSON storing what was accessed/changed',
          FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
          FOREIGN KEY (accessed_by) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_employee (employee_id),
          INDEX idx_accessed_by (accessed_by),
          INDEX idx_accessed_at (accessed_at)
        )
      `);
      console.log('      ✅ Created employee_201_file_access_log table');
    } catch (e) {
      if (!e.message.includes('already exists')) throw e;
      console.log('      ⚠️  employee_201_file_access_log table already exists');
    }

    console.log('\n✅ 201-File Management migration completed successfully.\n');
    console.log('New tables/columns:');
    console.log('  • documents.verification_status (Pending|Verified|Rejected)');
    console.log('  • documents.verified_by (user_id)');
    console.log('  • documents.verified_at (timestamp)');
    console.log('  • documents.rejection_reason (text)');
    console.log('  • sensitive_employee_data (SSN, Tax ID, Bank details, Emergency contact)');
    console.log('  • employee_201_file_access_log (Audit trail)\n');

  } catch (err) {
    console.error('\n❌ Migration error:', err.message);
    throw err;
  } finally {
    conn.release();
    process.exit(0);
  }
}

migrate201Files();
