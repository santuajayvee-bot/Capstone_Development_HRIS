const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const argon2 = require('argon2');
const pool = require('../config/db');
const { computeLateUndertimeDeductions } = require('../server/payroll-attendance-deductions');

const PERIOD = {
  start: '2026-06-22',
  end: '2026-06-26',
  payrollPeriod: '2026-06-W4',
  workingDays: 5,
  standardHours: 8,
  dailyRate: 800,
  hourlyRate: 100,
  testDivisor: 4,
};

const TEST_MARK = 'MANUAL_DEDUCTION_TEST_20260624';
const DEPARTMENT_NAME = 'TEST Manual Deduction QA';
const OUTPUT_DIR = path.join(__dirname, '..', 'artifacts', 'payroll-manual-deduction-test');

const PRESENT_EMPLOYEES = ['EMP-MP01', 'EMP-MP02', 'EMP-MP03', 'EMP-MP04', 'EMP-MP05'];
const TARDY_EMPLOYEES = [
  { code: 'EMP-MU01', late: 30, undertime: 30 },
  { code: 'EMP-MU02', late: 45, undertime: 60 },
  { code: 'EMP-MU03', late: 60, undertime: 30 },
  { code: 'EMP-MU04', late: 90, undertime: 45 },
  { code: 'EMP-MU05', late: 120, undertime: 60 },
];
const TEST_CODES = [...PRESENT_EMPLOYEES, ...TARDY_EMPLOYEES.map(row => row.code)];

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function addDays(dateText, days) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMinutesToClock(clock, minutes) {
  const [hour, minute] = clock.split(':').map(Number);
  const total = hour * 60 + minute + Number(minutes || 0);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function ensureDepartment(connection) {
  const [rows] = await connection.execute(
    'SELECT id FROM departments WHERE name = ? LIMIT 1',
    [DEPARTMENT_NAME]
  );
  if (rows.length) return rows[0].id;
  const [result] = await connection.execute(
    'INSERT INTO departments (name, is_active) VALUES (?, 1)',
    [DEPARTMENT_NAME]
  );
  return result.insertId;
}

async function getDailyWageTypeId(connection) {
  const [rows] = await connection.execute(
    "SELECT id FROM wage_types WHERE LOWER(name) = 'daily' ORDER BY id LIMIT 1"
  );
  if (!rows.length) throw new Error('Daily wage type is not configured.');
  return rows[0].id;
}

async function ensureNoProcessedPayroll(connection) {
  const placeholders = TEST_CODES.map(() => '?').join(',');
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count
       FROM salary_calculations sc
       JOIN employees e ON e.id = sc.employee_id
      WHERE e.employee_code IN (${placeholders})`,
    TEST_CODES
  );
  if (Number(rows[0]?.count || 0) > 0) {
    throw new Error(
      'This manual test set already has payroll calculations. Use the existing records or change the test marker/codes before seeding another set.'
    );
  }
}

async function cleanupUnprocessedSeed(connection) {
  const placeholders = TEST_CODES.map(() => '?').join(',');
  const [employees] = await connection.execute(
    `SELECT id FROM employees WHERE employee_code IN (${placeholders})`,
    TEST_CODES
  );
  const employeeIds = employees.map(row => row.id);
  if (!employeeIds.length) return;

  const idSql = employeeIds.map(() => '?').join(',');
  await connection.execute(`DELETE FROM attendance_summary WHERE employee_id IN (${idSql})`, employeeIds);
  await connection.execute(`DELETE FROM attendance_log WHERE employee_id IN (${idSql})`, employeeIds);
  await connection.execute(`DELETE FROM employee_wage_rates WHERE employee_id IN (${idSql})`, employeeIds);
}

async function nextEmployeeNumber(connection) {
  const [rows] = await connection.execute(
    'SELECT COALESCE(MAX(Employee_ID), 990000) + 1 AS next_number FROM employees'
  );
  return Number(rows[0]?.next_number || 990001);
}

async function createEmployee(connection, { code, wageTypeId, departmentId, employeeNumber, position }) {
  const passwordHash = await argon2.hash(crypto.randomBytes(32).toString('base64url'), {
    type: argon2.argon2id,
  });
  const [existingRows] = await connection.execute(
    'SELECT id FROM employees WHERE employee_code = ? LIMIT 1',
    [code]
  );
  if (existingRows.length) {
    await connection.execute(
      `UPDATE employees
          SET first_name = 'MANUAL TEST',
              last_name = ?,
              email = ?,
              department_id = ?,
              position = ?,
              employment_type = 'Full-time',
              wage_type_id = ?,
              date_hired = ?,
              status = 'Active',
              daily_rate = ?,
              hourly_rate = ?,
              Password_Hash = ?,
              Password_Changed_At = NOW(),
              Failed_Login_Attempts = 0,
              Locked_Until = NULL,
              force_password_change = 1
        WHERE id = ?`,
      [
        code,
        `${code.toLowerCase()}@manual-deduction-test.local`,
        departmentId,
        position,
        wageTypeId,
        PERIOD.start,
        PERIOD.dailyRate,
        PERIOD.hourlyRate,
        passwordHash,
        existingRows[0].id,
      ]
    );
    return existingRows[0].id;
  }
  const [result] = await connection.execute(
    `INSERT INTO employees
       (employee_code, first_name, middle_name, last_name, email, contact_number,
        department_id, position, employment_type, wage_type_id, date_hired, status,
        daily_rate, hourly_rate, Employee_ID, Password_Hash, Password_Changed_At,
        Failed_Login_Attempts, force_password_change)
     VALUES (?, 'MANUAL TEST', NULL, ?, ?, '09999999999',
        ?, ?, 'Full-time', ?, ?, 'Active',
        ?, ?, ?, ?, NOW(), 0, 1)`,
    [
      code,
      code,
      `${code.toLowerCase()}@manual-deduction-test.local`,
      departmentId,
      position,
      wageTypeId,
      PERIOD.start,
      PERIOD.dailyRate,
      PERIOD.hourlyRate,
      employeeNumber,
      passwordHash,
    ]
  );
  return result.insertId;
}

async function createWageRate(connection, employeeId, wageTypeId) {
  await connection.execute(
    `INSERT INTO employee_wage_rates
       (employee_id, wage_type_id, base_rate, monthly_salary, daily_rate, hourly_rate,
        overtime_rate, default_role, rate, effective_date, end_date, is_active, notes)
     VALUES (?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, NULL, 1, ?)`,
    [
      employeeId,
      wageTypeId,
      PERIOD.dailyRate,
      PERIOD.dailyRate,
      PERIOD.hourlyRate,
      PERIOD.hourlyRate,
      PERIOD.dailyRate,
      PERIOD.start,
      TEST_MARK,
    ]
  );
}

async function seedAttendance(connection, employeeId, { late = 0, undertime = 0 }) {
  const attendanceRows = [];
  for (let index = 0; index < PERIOD.workingDays; index += 1) {
    const attendanceDate = addDays(PERIOD.start, index);
    const dayLate = index === 0 ? late : 0;
    const dayUndertime = index === 0 ? undertime : 0;
    const timeIn = addMinutesToClock('08:00', dayLate);
    const timeOut = addMinutesToClock('17:00', -dayUndertime);
    const attendanceStatus = dayLate > 0 ? 'Late' : dayUndertime > 0 ? 'Half Day' : 'Present';
    const [logResult] = await connection.execute(
      `INSERT INTO attendance_log
         (employee_id, date, time_in, time_out, overtime_hours, late_minutes,
          undertime_minutes, overtime_minutes, absences, status, verification_status,
          source, first_scan_at, last_scan_at, integrity_hash)
       VALUES (?, ?, ?, ?, 0, ?, ?, 0, 0, ?, 'PAYROLL_READY',
          'HR_MANUAL_ADJUSTMENT', ?, ?, SHA2(?, 256))`,
      [
        employeeId,
        attendanceDate,
        timeIn,
        timeOut,
        dayLate,
        dayUndertime,
        attendanceStatus,
        `${attendanceDate} ${timeIn}`,
        `${attendanceDate} ${timeOut}`,
        `${TEST_MARK}:LOG:${employeeId}:${attendanceDate}`,
      ]
    );
    await connection.execute(
      `INSERT INTO attendance_summary
         (employee_id, attendance_date, attendance_id, regular_minutes, overtime_minutes,
          late_minutes, undertime_minutes, attendance_status, verification_status,
          payroll_eligible, payroll_run_id, paid_at, integrity_hash, policy_snapshot_json)
       VALUES (?, ?, ?, 480, 0, ?, ?, ?, 'PAYROLL_READY',
          1, NULL, NULL, SHA2(?, 256), ?)`,
      [
        employeeId,
        attendanceDate,
        logResult.insertId,
        dayLate,
        dayUndertime,
        attendanceStatus,
        `${TEST_MARK}:SUMMARY:${employeeId}:${attendanceDate}`,
        JSON.stringify({ test: TEST_MARK, source: 'manual payroll deduction seed' }),
      ]
    );
    attendanceRows.push({
      time_in: timeIn,
      late_minutes: dayLate,
      undertime_minutes: dayUndertime,
      overtime_minutes: 0,
    });
  }
  return attendanceRows;
}

function expectedAttendanceValues(code, attendanceRows) {
  const attendanceDeductions = computeLateUndertimeDeductions({
    attendanceRows,
    wageType: 'Daily',
    rate: PERIOD.dailyRate,
    policy: {
      standard_hours_per_day: PERIOD.standardHours,
      grace_period_minutes: 15,
      late_apply_grace_period: true,
      count_late_for_payroll: true,
      count_undertime_for_payroll: true,
      late_deduction_method: 'auto_compute',
      undertime_deduction_method: 'auto_compute',
      work_start_time: '08:00:00',
    },
  });
  const grossPay = money(PERIOD.dailyRate * PERIOD.workingDays);
  return {
    employee_code: code,
    wage_type: 'Daily',
    attendance_days: PERIOD.workingDays,
    gross_before_deductions: grossPay,
    late_minutes: attendanceDeductions.late_minutes,
    deductible_late_minutes: attendanceDeductions.deductible_late_minutes,
    undertime_minutes: attendanceDeductions.undertime_minutes,
    expected_late_deduction_using_15_minute_grace: attendanceDeductions.late_deduction,
    expected_undertime_deduction: attendanceDeductions.undertime_deduction,
    expected_tardy_and_undertime_total: attendanceDeductions.tardy_ut_deduction,
    projected_monthly_base_at_divisor_4: money(grossPay * PERIOD.testDivisor),
    payroll_status_before_manual_processing: 'Source Ready',
  };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const connection = await pool.getConnection();
  const results = [];

  try {
    await connection.beginTransaction();
    await ensureNoProcessedPayroll(connection);
    await cleanupUnprocessedSeed(connection);

    const departmentId = await ensureDepartment(connection);
    const wageTypeId = await getDailyWageTypeId(connection);
    let employeeNumber = await nextEmployeeNumber(connection);

    for (const code of PRESENT_EMPLOYEES) {
      const employeeId = await createEmployee(connection, {
        code,
        wageTypeId,
        departmentId,
        employeeNumber: employeeNumber++,
        position: 'Manual Deduction Test - Present',
      });
      await createWageRate(connection, employeeId, wageTypeId);
      const attendanceRows = await seedAttendance(connection, employeeId, {});
      results.push(expectedAttendanceValues(code, attendanceRows));
    }

    for (const tardy of TARDY_EMPLOYEES) {
      const employeeId = await createEmployee(connection, {
        code: tardy.code,
        wageTypeId,
        departmentId,
        employeeNumber: employeeNumber++,
        position: 'Manual Deduction Test - Late and Undertime',
      });
      await createWageRate(connection, employeeId, wageTypeId);
      const attendanceRows = await seedAttendance(connection, employeeId, tardy);
      results.push(expectedAttendanceValues(tardy.code, attendanceRows));
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }

  const evidence = {
    generated_at: new Date().toISOString(),
    test_mark: TEST_MARK,
    department: DEPARTMENT_NAME,
    period: PERIOD,
    employees: results,
    processing_instructions: [
      'Open Payroll Run and select June 22, 2026 through June 26, 2026.',
      `Filter Department to ${DEPARTMENT_NAME}.`,
      'Set the payroll frequency and deduction settings you want to verify.',
      'Generate payroll manually. This seed script did not create a payroll run, salary calculation, or payslip.',
      'Compare the generated deduction rows against the active deduction settings and configured divisor.',
    ],
    divisor_4_reference: {
      projected_monthly_base: 'weekly gross x 4',
      monthly_contribution: 'projected monthly base x configured percentage',
      payroll_deduction: 'monthly contribution / 4',
      note: 'Floor, ceiling, contribution cap, matrix bracket, and deduction schedule can change the final amount.',
    },
  };

  const jsonPath = path.join(OUTPUT_DIR, 'manual-deduction-test-checklist.json');
  const csvPath = path.join(OUTPUT_DIR, 'manual-deduction-test-employees.csv');
  fs.writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  const headers = [
    'Employee Code',
    'Wage Type',
    'Attendance Days',
    'Gross Before Deductions',
    'Late Minutes',
    'Deductible Late Minutes',
    'Undertime Minutes',
    'Expected Late Deduction',
    'Expected Undertime Deduction',
    'Expected Tardy and Undertime Total',
    'Projected Monthly Base at Divisor 4',
    'Status Before Processing',
  ];
  const rows = results.map(row => [
    row.employee_code,
    row.wage_type,
    row.attendance_days,
    row.gross_before_deductions,
    row.late_minutes,
    row.deductible_late_minutes,
    row.undertime_minutes,
    row.expected_late_deduction_using_15_minute_grace,
    row.expected_undertime_deduction,
    row.expected_tardy_and_undertime_total,
    row.projected_monthly_base_at_divisor_4,
    row.payroll_status_before_manual_processing,
  ]);
  fs.writeFileSync(
    csvPath,
    [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\n')
  );

  console.log('Manual deduction test data is ready.');
  console.log(`Department: ${DEPARTMENT_NAME}`);
  console.log(`Payroll period: ${PERIOD.start} to ${PERIOD.end}`);
  console.log(`Employees: ${TEST_CODES.join(', ')}`);
  console.log('No payroll calculations, payroll runs, or payslips were created.');
  console.log(`Checklist: ${jsonPath}`);
  console.log(`CSV: ${csvPath}`);
  console.table(results.map(row => ({
    employee: row.employee_code,
    gross: row.gross_before_deductions,
    late_minutes: row.late_minutes,
    undertime_minutes: row.undertime_minutes,
    attendance_deduction: row.expected_tardy_and_undertime_total,
  })));
}

main().catch(error => {
  console.error('Manual deduction seed failed:', error.message);
  process.exit(1);
});
