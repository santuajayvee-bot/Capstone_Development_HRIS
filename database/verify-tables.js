const mysql = require('mysql2/promise');

async function verifyTables() {
  let connection;
  try {
    connection = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: 'Root@1234',
      database: 'lgsv_hr_db',
    });

    console.log('✅ Connected to database\n');

    // Check payroll_runs table
    console.log('📋 payroll_runs table columns:');
    const [payrollRunsInfo] = await connection.query(`
      SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'payroll_runs' AND TABLE_SCHEMA = 'lgsv_hr_db'
      ORDER BY ORDINAL_POSITION
    `);
    payrollRunsInfo.forEach(col => {
      console.log(`  - ${col.COLUMN_NAME}: ${col.COLUMN_TYPE}`);
    });

    // Check payslips table
    console.log('\n📋 payslips table columns:');
    const [payslipsInfo] = await connection.query(`
      SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'payslips' AND TABLE_SCHEMA = 'lgsv_hr_db'
      ORDER BY ORDINAL_POSITION
    `);
    payslipsInfo.forEach(col => {
      console.log(`  - ${col.COLUMN_NAME}: ${col.COLUMN_TYPE}`);
    });

    // Check salary_calculations table
    console.log('\n📋 salary_calculations table columns:');
    const [salaryCalcInfo] = await connection.query(`
      SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'salary_calculations' AND TABLE_SCHEMA = 'lgsv_hr_db'
      ORDER BY ORDINAL_POSITION
    `);
    salaryCalcInfo.forEach(col => {
      console.log(`  - ${col.COLUMN_NAME}: ${col.COLUMN_TYPE}`);
    });

    await connection.end();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

verifyTables();
