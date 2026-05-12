const db = require('./config/db.js');

(async () => {
  try {
    console.log('Converting salary calculations to payslips for 2026-05...');
    
    // Get payroll run for 2026-05
    const [payrollRuns] = await db.query('SELECT id FROM payroll_runs WHERE month_year = ?', ['2026-05']);
    if (!payrollRuns.length) {
      console.log('No payroll run found for 2026-05');
      process.exit(0);
    }
    
    const payrollRunId = payrollRuns[0].id;
    console.log('Using payroll_run_id:', payrollRunId);
    
    // Delete existing payslips for this run to start fresh
    const [deleted] = await db.query('DELETE FROM payslips WHERE payroll_run_id = ?', [payrollRunId]);
    console.log('Cleared', deleted.affectedRows, 'existing payslips');
    
    // Get the LATEST calculation for each employee using a subquery
    const [latestCalcs] = await db.query(`
      SELECT sc.employee_id, sc.wage_type_id, sc.gross_pay, sc.total_deductions, sc.net_pay
      FROM salary_calculations sc
      WHERE sc.status = 'Submitted'
      AND sc.id = (
        SELECT MAX(id) FROM salary_calculations sc2 
        WHERE sc2.employee_id = sc.employee_id AND sc2.status = 'Submitted'
      )
    `);
    
    console.log('Found', latestCalcs.length, 'employees with submitted calculations');
    
    // Insert the latest calculation for each employee as a payslip
    let convertedCount = 0;
    for (const calc of latestCalcs) {
      await db.query(`
        INSERT INTO payslips (payroll_run_id, employee_id, wage_type_id, total_earning, total_deduction, net_pay, status)
        VALUES (?, ?, ?, ?, ?, ?, 'Approved')
      `, [payrollRunId, calc.employee_id, calc.wage_type_id, calc.gross_pay, calc.total_deductions, calc.net_pay]);
      
      convertedCount++;
      console.log('✅ Created payslip for employee', calc.employee_id, '- ₱' + calc.gross_pay);
    }
    
    // Show all payslips now
    const [payslips] = await db.query(`
      SELECT p.id, p.employee_id, CONCAT(e.first_name, ' ', COALESCE(e.last_name, '')) as name, p.total_earning, p.total_deduction, p.net_pay 
      FROM payslips p
      LEFT JOIN employees e ON e.id = p.employee_id
      WHERE p.payroll_run_id = ? 
      ORDER BY p.id
    `, [payrollRunId]);
    
    console.log('\n✅ Conversion complete! Created', convertedCount, 'payslips for payroll_run', payrollRunId + ':');
    console.table(payslips);
    
  } catch (err) {
    console.error('Error:', err.message);
  }
  process.exit(0);
})();
