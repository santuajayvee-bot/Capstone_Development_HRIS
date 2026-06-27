const mysql = require('mysql2/promise');
require('dotenv').config();

const EMPLOYEE_ID = 11;
const SALARY_CALCULATION_ID = 31;
const SOURCE_RESET_START = '2026-06-22';
const SOURCE_RESET_END = '2026-06-27';

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'lgsv_hr_db',
    timezone: '+08:00',
  });

  const result = {};
  await connection.beginTransaction();
  try {
    const [[calc]] = await connection.execute(
      `SELECT id, employee_id, payroll_run_id, source_record_ids
         FROM salary_calculations
        WHERE id = ? AND employee_id = ?
        LIMIT 1`,
      [SALARY_CALCULATION_ID, EMPLOYEE_ID]
    );
    if (!calc) throw new Error(`Salary calculation ${SALARY_CALCULATION_ID} for employee ${EMPLOYEE_ID} was not found.`);

    const [[payslip]] = await connection.execute(
      `SELECT id, total_earning, total_deduction, net_pay
         FROM payslips
        WHERE payroll_run_id = ? AND employee_id = ?
        LIMIT 1`,
      [calc.payroll_run_id, calc.employee_id]
    );
    result.target = {
      salary_calculation_id: calc.id,
      payslip_id: payslip?.id || null,
      payroll_run_id: calc.payroll_run_id,
      employee_id: calc.employee_id,
    };

    const [deductions] = await connection.execute(
      'DELETE FROM salary_calculation_deductions WHERE salary_calculation_id = ?',
      [calc.id]
    );
    result.salary_calculation_deductions_deleted = deductions.affectedRows || 0;

    try {
      const [payments] = await connection.execute(
        'DELETE FROM employee_deduction_payments WHERE salary_calculation_id = ?',
        [calc.id]
      );
      result.employee_deduction_payments_deleted = payments.affectedRows || 0;
    } catch (_) {
      result.employee_deduction_payments_deleted = 0;
    }

    const [payslips] = await connection.execute(
      'DELETE FROM payslips WHERE payroll_run_id = ? AND employee_id = ?',
      [calc.payroll_run_id, calc.employee_id]
    );
    result.payslips_deleted = payslips.affectedRows || 0;

    const [calculations] = await connection.execute(
      'DELETE FROM salary_calculations WHERE id = ? AND employee_id = ?',
      [calc.id, calc.employee_id]
    );
    result.salary_calculations_deleted = calculations.affectedRows || 0;

    let sourceIds = [];
    try {
      sourceIds = JSON.parse(calc.source_record_ids || '[]')
        .map(value => String(value).split(':'))
        .filter(([prefix]) => prefix === 'pair')
        .map(([, id]) => Number(id))
        .filter(Boolean);
    } catch (_) {}
    result.source_pair_ids_from_old_calc = sourceIds;

    if (sourceIds.length) {
      const [reset] = await connection.execute(
        `UPDATE payroll_production_pairs
            SET status = 'Payroll Ready',
                payroll_run_id = NULL,
                paid_at = NULL,
                updated_by = NULL
          WHERE id IN (${sourceIds.map(() => '?').join(', ')})
            AND production_date BETWEEN ? AND ?`,
        [...sourceIds, SOURCE_RESET_START, SOURCE_RESET_END]
      );
      result.source_rows_reset_to_payroll_ready = reset.affectedRows || 0;
    } else {
      result.source_rows_reset_to_payroll_ready = 0;
    }

    const [[totals]] = await connection.execute(
      'SELECT COUNT(*) AS total_employees, COALESCE(SUM(net_pay), 0) AS total_amount FROM payslips WHERE payroll_run_id = ?',
      [calc.payroll_run_id]
    );
    await connection.execute(
      'UPDATE payroll_runs SET total_employees = ?, total_amount = ? WHERE id = ?',
      [totals.total_employees || 0, totals.total_amount || 0, calc.payroll_run_id]
    );
    result.updated_run_totals = {
      total_employees: Number(totals.total_employees || 0),
      total_amount: Number(totals.total_amount || 0),
    };

    await connection.commit();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
