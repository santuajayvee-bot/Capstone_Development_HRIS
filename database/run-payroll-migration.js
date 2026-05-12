const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  let connection;
  try {
    // Create connection pool
    connection = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: 'Root@1234',
      database: 'lgsv_hr_db',
      multipleStatements: true
    });

    console.log('✅ Connected to database');

    // Read migration file
    const migrationPath = path.join(__dirname, 'migrate-payroll-tables.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    console.log('🔄 Running migration...');
    
    // Execute migration
    await connection.query(sql);

    console.log('✅ Migration completed successfully!');
    console.log('📋 Created tables:');
    console.log('   - wage_types');
    console.log('   - payroll_runs');
    console.log('   - payslips');
    console.log('✅ Updated employees table:');
    console.log('   - Added wage_type_id foreign key');

    await connection.end();
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

runMigration();
