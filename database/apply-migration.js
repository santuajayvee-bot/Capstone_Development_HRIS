// Apply payroll schema migration
// Run this from your project root: node database/apply-migration.js

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function applyMigration() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : '',
    database: process.env.DB_NAME || 'lgsv_hr_db',
    multipleStatements: true
  });

  try {
    console.log('📦 Reading migration file...');
    const sqlFile = path.join(__dirname, 'migrate-payroll-schema.sql');
    const sql = fs.readFileSync(sqlFile, 'utf8');

    console.log('🔄 Applying migration...');
    await connection.query(sql);
    
    console.log('✅ Migration completed successfully!');
    console.log('\n✨ New tables created:');
    console.log('  - wage_types');
    console.log('  - sewing_types');
    console.log('  - logistics_regions');
    console.log('  - employee_wage_rates');
    console.log('  - production_transactions');
    console.log('  - logistics_transactions');
    console.log('  - payroll_runs');
    console.log('  - payslips');
    console.log('  - employee_deductions');
    console.log('\n💾 Columns added to employees table:');
    console.log('  - wage_type_id');
    console.log('  - sss_number, philhealth_number, pagibig_number, tin');
    console.log('  - bank_name, bank_account');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

applyMigration();
