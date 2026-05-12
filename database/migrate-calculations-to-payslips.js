const mysql = require('mysql2/promise');

async function migrateCalculationsToPayslips() {
  let connection;
  try {
    connection = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: 'Root@1234',
      database: 'lgsv_hr_db',
      multipleStatements: true
    });

    console.log('✅ Connected to database');

    // Get all salary calculations that don't have corresponding payslips
    const [calculations] = await connection.query(`
      SELECT * FROM salary_calculations ORDER BY calculation_date DESC
    `);

    if (!calculations || calculations.length === 0) {
      console.log('ℹ️  No salary calculations found to migrate');
      await connection.end();
      process.exit(0);
    }

    console.log(`🔄 Found ${calculations.length} salary calculations. Creating payroll records...`);

    // Get or create payroll_run for each month
    for (const calc of calculations) {
      const calcDate = new Date(calc.calculation_date);
      const monthYear = `${calcDate.getFullYear()}-${String(calcDate.getMonth() + 1).padStart(2, '0')}`;

      // Check if payroll_run exists for this month
      const [[payrollRun]] = await connection.execute(`
        SELECT id FROM payroll_runs WHERE month_year = ?
      `, [monthYear]);

      let payrollRunId;
      if (!payrollRun) {
        // Create new payroll_run
        const [result] = await connection.execute(`
          INSERT INTO payroll_runs (month_year, start_date, end_date, status, total_employees)
          VALUES (?, DATE_FORMAT(?, '%Y-%m-01'), LAST_DAY(?), 'Approved', 0)
        `, [monthYear, calc.calculation_date, calc.calculation_date]);
        payrollRunId = result.insertId;
        console.log(`   📅 Created payroll run for ${monthYear}`);
      } else {
        payrollRunId = payrollRun.id;
      }

      // Check if payslip already exists for this employee in this payroll run
      const [[existingPayslip]] = await connection.execute(`
        SELECT id FROM payslips WHERE payroll_run_id = ? AND employee_id = ?
      `, [payrollRunId, calc.employee_id]);

      if (!existingPayslip) {
        // Create payslip from salary calculation
        await connection.execute(`
          INSERT INTO payslips 
          (payroll_run_id, employee_id, wage_type_id, 
           total_earning, total_deduction, net_pay, status)
          VALUES (?, ?, ?, ?, ?, ?, 'Approved')
        `, [
          payrollRunId,
          calc.employee_id,
          calc.wage_type_id || 1,
          calc.gross_pay || 0,
          calc.total_deductions || 0,
          calc.net_pay || 0
        ]);
      }
    }

    console.log('✅ Migration completed!');
    console.log('📊 Salary calculations have been converted to payslips');

    await connection.end();
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

migrateCalculationsToPayslips();
