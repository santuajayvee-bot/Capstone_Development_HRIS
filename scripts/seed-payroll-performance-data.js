require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const argon2 = require('argon2');
const mysql = require('mysql2/promise');

const TEST_MARK = 'LGSV_PAYROLL_PERFORMANCE_TEST';
const DEFAULT_PERIOD = {
  payroll_period: '2026-07-W1',
  start_date: '2026-07-01',
  end_date: '2026-07-07',
};
const GROUPS = [
  { size: 10, department: 'PERF BENCHMARK 10', codePrefix: 'PERF10' },
  { size: 50, department: 'PERF BENCHMARK 50', codePrefix: 'PERF50' },
  { size: 100, department: 'PERF BENCHMARK 100', codePrefix: 'PERF100' },
];
const OUTPUT_DIR = path.join(__dirname, '..', 'artifacts', 'payroll-performance-test');

function argValue(name) {
  const prefix = `--${name}=`;
  const item = process.argv.find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
}

function mysqlConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: false,
  };
}

async function tableExists(connection, tableName) {
  const [rows] = await connection.execute(
    `SELECT TABLE_NAME
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      LIMIT 1`,
    [tableName]
  );
  return rows.length > 0;
}

async function deleteIfTableExists(connection, tableName, sql, params = []) {
  if (!(await tableExists(connection, tableName))) return 0;
  const [result] = await connection.execute(sql, params);
  return result.affectedRows || 0;
}

async function ensureDepartment(connection, name) {
  const [rows] = await connection.execute('SELECT id FROM departments WHERE name = ? LIMIT 1', [name]);
  if (rows.length) {
    await connection.execute('UPDATE departments SET is_active = 1 WHERE id = ?', [rows[0].id]);
    return rows[0].id;
  }
  const [result] = await connection.execute('INSERT INTO departments (name, is_active) VALUES (?, 1)', [name]);
  return result.insertId;
}

async function perPieceWageTypeId(connection) {
  const [rows] = await connection.execute(
    `SELECT id
       FROM wage_types
      WHERE LOWER(name) IN ('per-piece', 'piece rate')
      ORDER BY CASE WHEN LOWER(name) = 'per-piece' THEN 0 ELSE 1 END, id
      LIMIT 1`
  );
  if (!rows.length) throw new Error('Per-Piece wage type is not configured.');
  return rows[0].id;
}

async function payrollOfficerUserId(connection) {
  const [rows] = await connection.execute(
    "SELECT id FROM users WHERE username IN ('payroll.officer', 'payroll.manager') ORDER BY username = 'payroll.officer' DESC LIMIT 1"
  );
  return rows[0]?.id || null;
}

async function nextEmployeeNumber(connection) {
  const [rows] = await connection.execute('SELECT COALESCE(MAX(Employee_ID), 980000) + 1 AS next_number FROM employees');
  return Number(rows[0]?.next_number || 980001);
}

function employeeCode(group, index) {
  return `${group.codePrefix}-${String(index).padStart(3, '0')}`;
}

async function cleanup(connection, period) {
  const [employees] = await connection.execute(
    `SELECT id
       FROM employees
      WHERE employee_code LIKE 'PERF10-%'
         OR employee_code LIKE 'PERF50-%'
         OR employee_code LIKE 'PERF100-%'
         OR email LIKE '%@payroll-performance.local'`
  );
  const ids = employees.map(row => Number(row.id)).filter(Boolean);
  const result = { employees_found: ids.length };

  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    result.salary_deduction_rows = await deleteIfTableExists(connection, 'salary_calculation_deductions', `
      DELETE scd FROM salary_calculation_deductions scd
      JOIN salary_calculations sc ON sc.id = scd.salary_calculation_id
      WHERE sc.employee_id IN (${placeholders})
    `, ids);
    result.employee_deduction_payments = await deleteIfTableExists(connection, 'employee_deduction_payments', `
      DELETE edp FROM employee_deduction_payments edp
      JOIN salary_calculations sc ON sc.id = edp.salary_calculation_id
      WHERE sc.employee_id IN (${placeholders})
    `, ids);
    result.payroll_record = await deleteIfTableExists(connection, 'payroll_record', `
      DELETE pr FROM payroll_record pr
      JOIN salary_calculations sc ON sc.id = pr.Payroll_ID
      WHERE sc.employee_id IN (${placeholders})
    `, ids).catch(() => 0);
    result.payslips = await deleteIfTableExists(connection, 'payslips', `DELETE FROM payslips WHERE employee_id IN (${placeholders})`, ids);
    result.payroll_audit_trail = await deleteIfTableExists(connection, 'payroll_audit_trail', `DELETE FROM payroll_audit_trail WHERE employee_id IN (${placeholders})`, ids);
    result.salary_calculations = await deleteIfTableExists(connection, 'salary_calculations', `DELETE FROM salary_calculations WHERE employee_id IN (${placeholders})`, ids);
    result.employee_wage_rates = await deleteIfTableExists(connection, 'employee_wage_rates', `DELETE FROM employee_wage_rates WHERE employee_id IN (${placeholders})`, ids);
    result.piece_rate_output_shares = await deleteIfTableExists(connection, 'piece_rate_output_shares', `DELETE FROM piece_rate_output_shares WHERE employee_id IN (${placeholders})`, ids);
  }

  result.piece_rate_outputs = await deleteIfTableExists(connection, 'piece_rate_outputs', `
    DELETE FROM piece_rate_outputs
     WHERE remarks LIKE ?
        OR payroll_period_id = ?
  `, [`%${TEST_MARK}%`, period.payroll_period]);

  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    result.employees = await deleteIfTableExists(connection, 'employees', `DELETE FROM employees WHERE id IN (${placeholders})`, ids);
  }

  result.payroll_runs = await deleteIfTableExists(connection, 'payroll_runs', `
    DELETE FROM payroll_runs
     WHERE month_year = ?
        OR source_summary LIKE ?
  `, [period.payroll_period, `%${TEST_MARK}%`]);
  result.performance_logs = await deleteIfTableExists(connection, 'performance_logs', `
    DELETE FROM performance_logs
     WHERE payroll_period = ?
        OR metadata_json LIKE ?
  `, [period.payroll_period, `%${TEST_MARK}%`]);

  return result;
}

async function createEmployee(connection, group, index, departmentId, wageTypeId, employeeNumber, period) {
  const code = employeeCode(group, index);
  const passwordHash = await argon2.hash(crypto.randomBytes(32).toString('base64url'), {
    type: argon2.argon2id,
  });
  const [result] = await connection.execute(
    `INSERT INTO employees
       (employee_code, first_name, middle_name, last_name, email, contact_number,
        department_id, position, employment_type, wage_type_id, default_payroll_role,
        date_hired, status, daily_rate, hourly_rate, hiring_type, agency_name,
        Employee_ID, Password_Hash, Password_Changed_At, Failed_Login_Attempts,
        force_password_change)
     VALUES (?, 'PERF', NULL, ?, ?, '09999999999',
        ?, 'Performance Benchmark Worker', 'Full-time', ?, 'Solo',
        ?, 'Active', 0, 0, 'Direct Hire', NULL,
        ?, ?, NOW(), 0, 1)`,
    [
      code,
      `Benchmark ${code}`,
      `${code.toLowerCase()}@payroll-performance.local`,
      departmentId,
      wageTypeId,
      period.start_date,
      employeeNumber,
      passwordHash,
    ]
  );
  return { id: result.insertId, code };
}

async function createPieceSource(connection, employeeId, period, actorId, index) {
  const quantity = 100 + (index % 5) * 10;
  const rate = 10;
  const amount = quantity * rate;
  const [output] = await connection.execute(
    `INSERT INTO piece_rate_outputs
       (payroll_period_id, output_date, operation_type, size_range, quantity_produced,
        rate_per_piece, full_amount, output_mode, split_rule, remarks, status, created_by,
        submitted_by, submitted_at, verified_by, verified_at, approved_by, approved_at, updated_by)
     VALUES (?, ?, 'PERF-BENCH-SEW', 'BENCH', ?, ?, ?, 'solo', 'SOLO', ?, 'Payroll Ready',
        ?, ?, NOW(), ?, NOW(), ?, NOW(), ?)`,
    [
      period.payroll_period,
      period.start_date,
      quantity,
      rate,
      amount,
      TEST_MARK,
      actorId,
      actorId,
      actorId,
      actorId,
      actorId,
    ]
  );
  await connection.execute(
    `INSERT INTO piece_rate_output_shares
       (piece_rate_output_id, employee_id, partner_role, share_percentage, share_amount)
     VALUES (?, ?, 'Solo', 100.00, ?)`,
    [output.insertId, employeeId, amount]
  );
  return { output_id: output.insertId, amount };
}

async function createWageRate(connection, employeeId, wageTypeId, period) {
  await connection.execute(
    `INSERT INTO employee_wage_rates
       (employee_id, wage_type_id, base_rate, monthly_salary, daily_rate, hourly_rate,
        overtime_rate, default_role, rate, effective_date, end_date, is_active, notes)
     VALUES (?, ?, 0, 0, 0, 0, 0, 'Solo', 10, ?, NULL, 1, ?)`,
    [employeeId, wageTypeId, period.start_date, TEST_MARK]
  );
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function run() {
  const period = {
    payroll_period: argValue('period') || process.env.PERFORMANCE_PAYROLL_PERIOD || DEFAULT_PERIOD.payroll_period,
    start_date: argValue('start') || process.env.PERFORMANCE_PERIOD_START || DEFAULT_PERIOD.start_date,
    end_date: argValue('end') || process.env.PERFORMANCE_PERIOD_END || DEFAULT_PERIOD.end_date,
  };
  const connection = await mysql.createConnection(mysqlConfig());
  const evidence = {
    marker: TEST_MARK,
    period,
    groups: GROUPS.map(group => ({ department: group.department, employees: group.size })),
    cleanup: null,
    employees_created: 0,
    source_rows_created: 0,
  };

  try {
    await connection.beginTransaction();
    evidence.cleanup = await cleanup(connection, period);
    const wageTypeId = await perPieceWageTypeId(connection);
    const actorId = await payrollOfficerUserId(connection);
    let employeeNumber = await nextEmployeeNumber(connection);
    const csvRows = [['department', 'employee_code', 'payroll_period', 'source_status']];

    for (const group of GROUPS) {
      const departmentId = await ensureDepartment(connection, group.department);
      for (let index = 1; index <= group.size; index += 1) {
        const employee = await createEmployee(connection, group, index, departmentId, wageTypeId, employeeNumber++, period);
        await createWageRate(connection, employee.id, wageTypeId, period);
        await createPieceSource(connection, employee.id, period, actorId, index);
        evidence.employees_created += 1;
        evidence.source_rows_created += 1;
        csvRows.push([group.department, employee.code, period.payroll_period, 'Payroll Ready']);
      }
    }

    await connection.commit();
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUTPUT_DIR, 'payroll-performance-seed.json'), JSON.stringify(evidence, null, 2));
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'payroll-performance-employees.csv'),
      csvRows.map(row => row.map(csvEscape).join(',')).join('\n')
    );
    console.log(JSON.stringify(evidence, null, 2));
    console.log('\nSeed complete. Generate payroll in the UI using:');
    for (const group of GROUPS) {
      console.log(`- Department: ${group.department} | Pay Type: Per-Piece | Period: ${period.payroll_period} | ${period.start_date} to ${period.end_date}`);
    }
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

run().catch(error => {
  console.error(`Payroll performance seed failed: ${error.message}`);
  process.exitCode = 1;
});
