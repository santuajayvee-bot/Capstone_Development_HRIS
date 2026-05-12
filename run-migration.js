// Run migration to create salary_calculations table
const fs = require('fs');
const path = require('path');
const pool = require('./config/db');

async function runMigration() {
  try {
    console.log('🔄 Running salary calculations migration...\n');
    
    const migrationSql = fs.readFileSync(
      path.join(__dirname, 'database', 'migrate-salary-calculations.sql'),
      'utf8'
    );
    
    // Split by semicolon and execute each statement
    const statements = migrationSql
      .split(';')
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('--'));
    
    for (const statement of statements) {
      console.log('Executing:', statement.substring(0, 80) + '...');
      try {
        await pool.execute(statement);
        console.log('✅ Success\n');
      } catch (err) {
        if (err.message.includes('already exists')) {
          console.log('ℹ️  Table already exists, skipping\n');
        } else {
          throw err;
        }
      }
    }
    
    console.log('✅ Migration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

runMigration();
