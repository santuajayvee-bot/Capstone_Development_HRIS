/**
 * database/run-photos-migration.js
 * Run the employee photos migration
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

async function runMigration() {
  const conn = await pool.getConnection();
  try {
    console.log('🔄 Running employee photos migration...\n');
    
    const sql = fs.readFileSync(path.join(__dirname, 'migrate-employee-photos.sql'), 'utf8');
    
    // Split by semicolon and execute each statement
    const statements = sql.split(';').filter(stmt => stmt.trim());
    
    for (const statement of statements) {
      if (statement.trim()) {
        console.log('Executing:', statement.trim().substring(0, 60) + '...');
        await conn.execute(statement);
      }
    }
    
    console.log('\n✅ Employee photos table created/updated successfully!');
  } catch (err) {
    console.error('❌ Migration error:', err.message);
  } finally {
    conn.release();
    process.exit(0);
  }
}

runMigration();
