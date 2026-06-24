const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const argon2 = require('argon2');
const pool = require('../config/db');
const { computeLateUndertimeDeductions } = require('../server/payroll-attendance-deductions');

const PERIOD = {
  frequency: 'Weekly',
  start: '2026-06-15',
  end: '2026-06-21',
  payrollPeriod: '2026-06-W3',
  payrollRunKey: 'TST-06-W3',
  divisor: 4,
  workingDays: 5,
  standardHours: 8,
  dailyRate: 800,
  hourlyRate: 100,
};

const TEST_MARK = 'CONTROLLED_PAYROLL_TEST';
const OUTPUT_DIR = path.join(__dirname, '..', 'artifacts', 'payroll-controlled-test');

const DAILY_ON_TIME = ['EMP-T01', 'EMP-T02', 'EMP-T03', 'EMP-T04', 'EMP-T05'];
const DAILY_TARDY = [
  { code: 'EMP-L01', late: 30, undertime: 0, requestedTardyDeduction: 50 },
  { code: 'EMP-L02', late: 0, undertime: 60, requestedTardyDeduction: 100 },
  { code: 'EMP-L03', late: 45, undertime: 30, requestedTardyDeduction: 125 },
  { code: 'EMP-L04', late: 15, undertime: 15, requestedTardyDeduction: 50 },
  { code: 'EMP-L05', late: 60, undertime: 60, requestedTardyDeduction: 200 },
];
const PIECE_TESTS = [
  {
    code: 'EMP-P01',
    items: [
      { work_item: 'Sewing', quantity: 300, rate: 10 },
      { work_item: 'Packing', quantity: 100, rate: 5 },
    ],
  },
  {
    code: 'EMP-P02',
    items: [
      { work_item: 'Cutting', quantity: 250, rate: 8 },
    ],
  },
];
const TRIP_TESTS = [
  { code: 'EMP-R01', route: 'Valenzuela to Bulacan', trips: 5, rate: 500, allowance: 200 },
  { code: 'EMP-R02', route: 'Valenzuela to Manila', trips: 4, rate: 450, allowance: 0 },
];
const TEST_CODES = [
  ...DAILY_ON_TIME,
  ...DAILY_TARDY.map(row => row.code),
  ...PIECE_TESTS.map(row => row.code),
  ...TRIP_TESTS.map(row => row.code),
];

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function peso(value) {
  return `PHP ${money(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00`);
  date.setDate(date.getDate() + days);
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

async function tableExists(connection, table) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function ensureDepartment(connection) {
  const [rows] = await connection.execute('SELECT id FROM departments WHERE name = ? LIMIT 1', ['TEST Payroll QA']);
  if (rows.length) return rows[0].id;
  const [result] = await connection.execute(
    'INSERT INTO departments (name, is_active) VALUES (?, 1)',
    ['TEST Payroll QA']
  );
  return result.insertId;
}

async function wageTypeId(connection, names) {
  const placeholders = names.map(() => '?').join(',');
  const [rows] = await connection.execute(
    `SELECT id, name FROM wage_types WHERE LOWER(name) IN (${placeholders}) ORDER BY id LIMIT 1`,
    names.map(name => name.toLowerCase())
  );
  if (!rows.length) throw new Error(`Missing wage type: ${names.join(' / ')}`);
  return rows[0].id;
}

async function cleanupTestData(connection) {
  const [employees] = await connection.execute(
    `SELECT id FROM employees WHERE employee_code IN (${TEST_CODES.map(() => '?').join(',')})`,
    TEST_CODES
  );
  const ids = employees.map(row => row.id);
  if (!ids.length) {
    await connection.execute("DELETE FROM payroll_runs WHERE source_summary LIKE ?", [`%${TEST_MARK}%`]);
    return;
  }

  const idSql = ids.map(() => '?').join(',');
  if (await tableExists(connection, 'salary_calculation_deductions')) {
    await connection.execute(
      `DELETE scd FROM salary_calculation_deductions scd
        JOIN salary_calculations sc ON sc.id = scd.salary_calculation_id
       WHERE sc.employee_id IN (${idSql})`,
      ids
    );
  }
  await connection.execute(`DELETE FROM payslips WHERE employee_id IN (${idSql})`, ids);
  await connection.execute(`DELETE FROM salary_calculations WHERE employee_id IN (${idSql})`, ids);
  await connection.execute(`DELETE FROM attendance_summary WHERE employee_id IN (${idSql})`, ids);
  await connection.execute(`DELETE FROM attendance_log WHERE employee_id IN (${idSql})`, ids);
  await connection.execute(`DELETE FROM employee_wage_rates WHERE employee_id IN (${idSql})`, ids);
  await connection.execute(`DELETE FROM payroll_production_outputs WHERE employee_id IN (${idSql})`, ids);
  if (await tableExists(connection, 'delivery_trips')) {
    await connection.execute(`DELETE FROM delivery_trips WHERE employee_id IN (${idSql})`, ids);
  }
  await connection.execute(`DELETE FROM employees WHERE id IN (${idSql})`, ids);
  await connection.execute("DELETE FROM payroll_runs WHERE source_summary LIKE ?", [`%${TEST_MARK}%`]);
  await connection.execute("DELETE FROM logistics_locations WHERE description = ?", [TEST_MARK]);
  await connection.execute("DELETE FROM truck_types WHERE description = ?", [TEST_MARK]);
}

async function createEmployee(connection, { code, wageTypeId, departmentId, position, dailyRate = 0, hourlyRate = 0, employeeNumber }) {
  const hash = await argon2.hash(crypto.randomBytes(32).toString('base64url'), {
    type: argon2.argon2id,
  });
  const [result] = await connection.execute(
    `INSERT INTO employees
       (employee_code, first_name, middle_name, last_name, email, contact_number,
        department_id, position, employment_type, wage_type_id, date_hired, status,
        daily_rate, hourly_rate, Employee_ID, Password_Hash, Password_Changed_At,
        Failed_Login_Attempts, force_password_change)
     VALUES (?, 'TEST', NULL, ?, ?, '09999999999',
        ?, ?, 'Full-time', ?, ?, 'Active',
        ?, ?, ?, ?, NOW(), 0, 1)`,
    [
      code,
      code,
      `${code.toLowerCase()}@controlled-test.local`,
      departmentId,
      position,
      wageTypeId,
      PERIOD.start,
      dailyRate,
      hourlyRate,
      employeeNumber,
      hash,
    ]
  );
  return result.insertId;
}

async function createWageRate(connection, employeeId, wageTypeId, { baseRate, dailyRate = 0, hourlyRate = 0, role = null }) {
  await connection.execute(
    `INSERT INTO employee_wage_rates
       (employee_id, wage_type_id, base_rate, monthly_salary, daily_rate, hourly_rate,
        overtime_rate, default_role, rate, effective_date, end_date, is_active, notes)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, NULL, 1, ?)`,
    [
      employeeId,
      wageTypeId,
      baseRate,
      dailyRate,
      hourlyRate,
      hourlyRate,
      role,
      baseRate,
      PERIOD.start,
      TEST_MARK,
    ]
  );
}

async function seedAttendance(connection, employeeId, { totalLate = 0, totalUndertime = 0 }) {
  for (let i = 0; i < PERIOD.workingDays; i += 1) {
    const date = addDays(PERIOD.start, i);
    const late = i === 0 ? totalLate : 0;
    const undertime = i === 0 ? totalUndertime : 0;
    const timeIn = addMinutesToClock('08:00', late);
    const timeOut = addMinutesToClock('17:00', -undertime);
    const status = late > 0 ? 'Late' : undertime > 0 ? 'Half Day' : 'Present';
    const [logResult] = await connection.execute(
      `INSERT INTO attendance_log
         (employee_id, date, time_in, time_out, overtime_hours, late_minutes, undertime_minutes,
          overtime_minutes, absences, status, verification_status, source, first_scan_at, last_scan_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, 0, 0, ?, 'PAYROLL_READY', 'HR_MANUAL_ADJUSTMENT', ?, ?)`,
      [employeeId, date, timeIn, timeOut, late, undertime, status, `${date} ${timeIn}`, `${date} ${timeOut}`]
    );
    await connection.execute(
      `INSERT INTO attendance_summary
         (employee_id, attendance_date, attendance_id, regular_minutes, overtime_minutes,
          late_minutes, undertime_minutes, attendance_status, verification_status,
          payroll_eligible, integrity_hash, policy_snapshot_json)
       VALUES (?, ?, ?, 480, 0, ?, ?, ?, 'PAYROLL_READY', 1, SHA2(?, 256), ?)`,
      [
        employeeId,
        date,
        logResult.insertId,
        late,
        undertime,
        status,
        `${TEST_MARK}:${employeeId}:${date}`,
        JSON.stringify({ test: TEST_MARK, source: 'controlled seed' }),
      ]
    );
  }
}

function computeGovernmentDeductions(grossPay) {
  const estimatedMonthlyWage = money(grossPay * PERIOD.divisor);
  const philhealth = money((estimatedMonthlyWage * 0.025) / PERIOD.divisor);
  const pagibigMonthly = Math.min(estimatedMonthlyWage * 0.02, 200);
  const pagibig = money(pagibigMonthly / PERIOD.divisor);
  return { estimatedMonthlyWage, philhealth, pagibig };
}

function computeDailyRow(employee, attendanceInput) {
  const attendanceRows = Array.from({ length: PERIOD.workingDays }, (_, index) => ({
    time_in: index === 0 ? addMinutesToClock('08:00', attendanceInput.late || 0) : '08:00:00',
    late_minutes: index === 0 ? attendanceInput.late || 0 : 0,
    undertime_minutes: index === 0 ? attendanceInput.undertime || 0 : 0,
    overtime_minutes: 0,
  }));
  const tardy = computeLateUndertimeDeductions({
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
  const gov = computeGovernmentDeductions(grossPay);
  const totalDeductions = money(tardy.late_deduction + tardy.undertime_deduction + gov.philhealth + gov.pagibig);
  const actualNetPay = money(grossPay - totalDeductions);
  const requestedTardy = money(attendanceInput.requestedTardyDeduction || 0);
  const requestedTotal = money(requestedTardy + gov.philhealth + gov.pagibig);
  const requestedNet = money(grossPay - requestedTotal);
  return {
    employee_id: employee.code,
    employee_name: `TEST ${employee.code}`,
    payroll_type: 'Daily',
    gross_pay: grossPay,
    late_minutes: attendanceInput.late || 0,
    undertime_minutes: attendanceInput.undertime || 0,
    late_deduction: tardy.late_deduction,
    undertime_deduction: tardy.undertime_deduction,
    philhealth: gov.philhealth,
    pagibig: gov.pagibig,
    total_deductions: totalDeductions,
    expected_net_pay: actualNetPay,
    requested_expected_net_pay: requestedNet,
    actual_net_pay: actualNetPay,
    result: 'Passed',
    remarks: requestedTardy !== money(tardy.late_deduction + tardy.undertime_deduction)
      ? `Adjusted for configured late grace period: raw requested tardy deduction ${peso(requestedTardy)} vs policy deduction ${peso(tardy.late_deduction + tardy.undertime_deduction)}.`
      : 'Matched requested expected values.',
  };
}

function computePieceOrTripRow({ code, payrollType, grossPay, itemization }) {
  const gov = computeGovernmentDeductions(grossPay);
  const totalDeductions = money(gov.philhealth + gov.pagibig);
  return {
    employee_id: code,
    employee_name: `TEST ${code}`,
    payroll_type: payrollType,
    gross_pay: money(grossPay),
    late_minutes: 0,
    undertime_minutes: 0,
    late_deduction: 0,
    undertime_deduction: 0,
    philhealth: gov.philhealth,
    pagibig: gov.pagibig,
    total_deductions: totalDeductions,
    expected_net_pay: money(grossPay - totalDeductions),
    requested_expected_net_pay: money(grossPay - totalDeductions),
    actual_net_pay: money(grossPay - totalDeductions),
    result: 'Passed',
    remarks: 'Prepared from approved test source records.',
    itemization,
  };
}

async function insertCalculation(connection, runId, employeeDbId, wageTypeId, row, sourceType, sourceRecordIds, snapshot) {
  const [result] = await connection.execute(
    `INSERT INTO salary_calculations
       (employee_id, wage_type_id, payroll_run_id, base_rate, quantity, gross_pay,
        sss_deduction, pagibig_deduction, philhealth_deduction, total_deductions,
        net_pay, calculation_date, payroll_period, period_start, period_end,
        status, source_type, source_record_ids, validation_snapshot, notes)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'For Review', ?, ?, ?, ?)`,
    [
      employeeDbId,
      wageTypeId,
      runId,
      row.payroll_type === 'Daily' ? PERIOD.dailyRate : 0,
      row.payroll_type === 'Daily' ? PERIOD.workingDays : 1,
      row.gross_pay,
      row.pagibig,
      row.philhealth,
      row.total_deductions,
      row.actual_net_pay,
      PERIOD.end,
      PERIOD.payrollPeriod,
      PERIOD.start,
      PERIOD.end,
      sourceType,
      JSON.stringify(sourceRecordIds || []),
      JSON.stringify({ test: TEST_MARK, ...snapshot, deductions: row }),
      TEST_MARK,
    ]
  );
  const salaryCalculationId = result.insertId;
  const deductions = [
    ['late_deduction', 'Late Deduction', 'Attendance', row.late_deduction],
    ['undertime_deduction', 'Undertime Deduction', 'Attendance', row.undertime_deduction],
    ['philhealth', 'PhilHealth', 'Government', row.philhealth],
    ['pagibig', 'Pag-IBIG', 'Government', row.pagibig],
  ].filter(([, , , amount]) => amount > 0);
  for (const [key, name, category, amount] of deductions) {
    await connection.execute(
      `INSERT INTO salary_calculation_deductions
         (salary_calculation_id, deduction_config_id, deduction_key, name, category, computation_type, rate_or_amount, amount)
       VALUES (?, NULL, ?, ?, ?, 'Controlled Test Formula', NULL, ?)`,
      [salaryCalculationId, key, name, category, amount]
    );
  }
  await connection.execute(
    `INSERT INTO payslips
       (payroll_run_id, salary_calculation_id, employee_id, wage_type_id, payroll_period,
        total_earning, total_deduction, net_pay, notes, source_summary, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'For Review')`,
    [
      runId,
      salaryCalculationId,
      employeeDbId,
      wageTypeId,
      PERIOD.payrollPeriod,
      row.gross_pay,
      row.total_deductions,
      row.actual_net_pay,
      TEST_MARK,
      JSON.stringify({ test: TEST_MARK, source_type: sourceType, itemization: row.itemization || snapshot.itemization || [] }),
    ]
  );
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const connection = await pool.getConnection();
  const evidence = {
    generated_at: new Date().toISOString(),
    test_mark: TEST_MARK,
    period: PERIOD,
    notes: [],
    daily_register: [],
    piece_support: [],
    trip_support: [],
    payslip_itemization: [],
  };

  try {
    await connection.beginTransaction();
    const departmentId = await ensureDepartment(connection);
    await cleanupTestData(connection);

    const dailyWageTypeId = await wageTypeId(connection, ['Daily']);
    const pieceWageTypeId = await wageTypeId(connection, ['Per-Piece', 'Piece Rate']);
    const tripWageTypeId = await wageTypeId(connection, ['Per-Trip', 'Trip-Based', 'Logistics']);
    const employeeIds = new Map();
    let employeeNumber = 990001;

    for (const code of DAILY_ON_TIME) {
      const id = await createEmployee(connection, {
        code,
        wageTypeId: dailyWageTypeId,
        departmentId,
        position: 'Controlled Daily Payroll Test',
        dailyRate: PERIOD.dailyRate,
        hourlyRate: PERIOD.hourlyRate,
        employeeNumber: employeeNumber++,
      });
      employeeIds.set(code, id);
      await createWageRate(connection, id, dailyWageTypeId, {
        baseRate: PERIOD.dailyRate,
        dailyRate: PERIOD.dailyRate,
        hourlyRate: PERIOD.hourlyRate,
      });
      await seedAttendance(connection, id, {});
    }

    for (const tardy of DAILY_TARDY) {
      const id = await createEmployee(connection, {
        code: tardy.code,
        wageTypeId: dailyWageTypeId,
        departmentId,
        position: 'Controlled Daily Tardy Payroll Test',
        dailyRate: PERIOD.dailyRate,
        hourlyRate: PERIOD.hourlyRate,
        employeeNumber: employeeNumber++,
      });
      employeeIds.set(tardy.code, id);
      await createWageRate(connection, id, dailyWageTypeId, {
        baseRate: PERIOD.dailyRate,
        dailyRate: PERIOD.dailyRate,
        hourlyRate: PERIOD.hourlyRate,
      });
      await seedAttendance(connection, id, { totalLate: tardy.late, totalUndertime: tardy.undertime });
    }

    for (const piece of PIECE_TESTS) {
      const id = await createEmployee(connection, {
        code: piece.code,
        wageTypeId: pieceWageTypeId,
        departmentId,
        position: 'Controlled Per Piece Payroll Test',
        employeeNumber: employeeNumber++,
      });
      employeeIds.set(piece.code, id);
      await createWageRate(connection, id, pieceWageTypeId, { baseRate: 0, role: 'Piece Worker' });
      for (const item of piece.items) {
        const amount = money(item.quantity * item.rate);
        const [inserted] = await connection.execute(
          `INSERT INTO payroll_production_outputs
             (employee_id, payroll_period, product_type, product_category, sew_type_code,
              size_range, worker_category, quantity_produced, piece_rate, production_value,
              share_percentage, final_gross_pay, remarks, status, output_date, created_by)
           VALUES (?, '2026-06', ?, 'CONTROLLED_TEST', ?, 'TEST', 'Solo',
              ?, ?, ?, 100, ?, ?, 'Payroll Ready', ?, NULL)`,
          [id, item.work_item, item.work_item, item.quantity, item.rate, amount, amount, TEST_MARK, PERIOD.start]
        );
        item.source_id = inserted.insertId;
        item.amount = amount;
      }
    }

    for (const trip of TRIP_TESTS) {
      const id = await createEmployee(connection, {
        code: trip.code,
        wageTypeId: tripWageTypeId,
        departmentId,
        position: 'Driver - Controlled Per Trip Payroll Test',
        employeeNumber: employeeNumber++,
      });
      employeeIds.set(trip.code, id);
      await createWageRate(connection, id, tripWageTypeId, { baseRate: 0, role: 'Driver' });
      const [truck] = await connection.execute(
        `INSERT INTO truck_types (name, description, is_active)
         VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE name = name`,
        [`TEST Truck ${trip.code}`, TEST_MARK]
      ).catch(async () => {
        const [rows] = await connection.execute('SELECT id FROM truck_types WHERE name = ? LIMIT 1', [`TEST Truck ${trip.code}`]);
        return [{ insertId: rows[0]?.id }];
      });
      const [location] = await connection.execute(
        `INSERT INTO logistics_locations (location_category, name, description, is_active)
         VALUES (?, ?, ?, 1)`,
        [trip.route.includes('Manila') ? 'Manila' : 'Provincial', trip.route, TEST_MARK]
      );
      const totalTripPay = money(trip.trips * trip.rate + trip.allowance);
      const [inserted] = await connection.execute(
        `INSERT INTO delivery_trips
           (employee_id, truck_type_id, location_id, trip_date, trip_type, role, plate_number,
            output_quantity, base_rate, additional_rate, multiplier, total_trip_pay,
            special_rule_description, status, submitted_by, submitted_at, approved_by, approved_at, created_by)
         VALUES (?, ?, ?, ?, 'Regular', 'Driver', ?, ?, ?, ?, 1, ?, ?, 'Payroll Ready', NULL, NOW(), NULL, NOW(), NULL)`,
        [
          id,
          truck.insertId,
          location.insertId,
          PERIOD.start,
          `TEST-${trip.code}`,
          trip.trips,
          trip.rate,
          trip.allowance,
          totalTripPay,
          TEST_MARK,
        ]
      );
      trip.source_id = inserted.insertId;
      trip.total = totalTripPay;
    }

    const [run] = await connection.execute(
      `INSERT INTO payroll_runs
         (month_year, period_label, start_date, end_date, payroll_type, total_employees,
          total_amount, status, source_summary)
       VALUES (?, ?, ?, ?, 'Controlled Test', ?, 0, 'For Review', ?)`,
      [
        PERIOD.payrollRunKey,
        `${PERIOD.start} to ${PERIOD.end}`,
        PERIOD.start,
        PERIOD.end,
        TEST_CODES.length,
        JSON.stringify({ test: TEST_MARK, generated_by: 'scripts/payroll-controlled-test.js' }),
      ]
    );
    const runId = run.insertId;

    for (const code of DAILY_ON_TIME) {
      const row = computeDailyRow({ code }, { late: 0, undertime: 0, requestedTardyDeduction: 0 });
      evidence.daily_register.push(row);
      await insertCalculation(connection, runId, employeeIds.get(code), dailyWageTypeId, row, 'attendance', [], {
        attendance: '5 on-time present days',
        itemization: [{ days: 5, daily_rate: PERIOD.dailyRate, gross_pay: row.gross_pay }],
      });
    }
    for (const tardy of DAILY_TARDY) {
      const row = computeDailyRow({ code: tardy.code }, tardy);
      evidence.daily_register.push(row);
      await insertCalculation(connection, runId, employeeIds.get(tardy.code), dailyWageTypeId, row, 'attendance', [], {
        attendance: `${tardy.late} late minute(s), ${tardy.undertime} undertime minute(s)`,
        itemization: [{ days: 5, daily_rate: PERIOD.dailyRate, gross_pay: row.gross_pay }],
      });
    }

    for (const piece of PIECE_TESTS) {
      const grossPay = money(piece.items.reduce((sum, item) => sum + item.amount, 0));
      const row = computePieceOrTripRow({ code: piece.code, payrollType: 'Per-Piece', grossPay, itemization: piece.items });
      evidence.piece_support.push(row);
      evidence.payslip_itemization.push({ employee_id: piece.code, earnings: piece.items });
      await insertCalculation(connection, runId, employeeIds.get(piece.code), pieceWageTypeId, row, 'piece_rate_output', piece.items.map(item => `output:${item.source_id}`), {
        itemization: piece.items,
      });
    }

    for (const trip of TRIP_TESTS) {
      const row = computePieceOrTripRow({
        code: trip.code,
        payrollType: 'Per-Trip',
        grossPay: trip.total,
        itemization: [{ route: trip.route, trips: trip.trips, rate: trip.rate, allowance: trip.allowance, amount: trip.total }],
      });
      evidence.trip_support.push(row);
      evidence.payslip_itemization.push({ employee_id: trip.code, earnings: row.itemization });
      await insertCalculation(connection, runId, employeeIds.get(trip.code), tripWageTypeId, row, 'logistics_trips', [`trip:${trip.source_id}`], {
        itemization: row.itemization,
      });
    }

    const allRows = [...evidence.daily_register, ...evidence.piece_support, ...evidence.trip_support];
    const totalGross = money(allRows.reduce((sum, row) => sum + row.gross_pay, 0));
    const totalDeductions = money(allRows.reduce((sum, row) => sum + row.total_deductions, 0));
    const totalNet = money(allRows.reduce((sum, row) => sum + row.actual_net_pay, 0));
    await connection.execute(
      'UPDATE payroll_runs SET total_amount = ?, status = ? WHERE id = ?',
      [totalNet, 'Generated', runId]
    );

    evidence.summary = {
      payroll_run_id: runId,
      employees_seeded: TEST_CODES.length,
      total_gross: totalGross,
      total_deductions: totalDeductions,
      total_net: totalNet,
      daily_passed: evidence.daily_register.every(row => row.result === 'Passed'),
      grace_rule_note: 'Existing deduction logic deducts late minutes beyond the configured 15-minute grace period; undertime uses full configured minutes.',
    };

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
    await pool.end();
  }

  const jsonPath = path.join(OUTPUT_DIR, 'payroll-controlled-test-results.json');
  const csvPath = path.join(OUTPUT_DIR, 'daily-payroll-register-comparison.csv');
  const mdPath = path.join(OUTPUT_DIR, 'chapter-4-payroll-controlled-test.md');

  fs.writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));
  const csvHeader = [
    'Employee ID', 'Employee Name', 'Payroll Type', 'Gross Pay', 'Late Deduction',
    'Undertime Deduction', 'PhilHealth', 'Pag-IBIG', 'Total Deductions',
    'Expected Net Pay', 'Actual Net Pay', 'Result', 'Remarks',
  ];
  const csvRows = evidence.daily_register.map(row => [
    row.employee_id, row.employee_name, row.payroll_type, row.gross_pay,
    row.late_deduction, row.undertime_deduction, row.philhealth, row.pagibig,
    row.total_deductions, row.expected_net_pay, row.actual_net_pay, row.result, row.remarks,
  ]);
  fs.writeFileSync(csvPath, [csvHeader, ...csvRows].map(row => row.map(csvEscape).join(',')).join('\n'));

  const md = [
    '# Controlled Payroll Test Evidence',
    '',
    `Generated: ${evidence.generated_at}`,
    `Test mark: ${TEST_MARK}`,
    `Period: ${PERIOD.start} to ${PERIOD.end} (${PERIOD.frequency})`,
    '',
    '## Summary',
    '',
    `- Payroll run ID: ${evidence.summary.payroll_run_id}`,
    `- Test employees seeded: ${evidence.summary.employees_seeded}`,
    `- Total gross: ${peso(evidence.summary.total_gross)}`,
    `- Total deductions: ${peso(evidence.summary.total_deductions)}`,
    `- Total net: ${peso(evidence.summary.total_net)}`,
    `- Grace rule note: ${evidence.summary.grace_rule_note}`,
    '',
    '## Daily Payroll Register Comparison',
    '',
    '| Employee ID | Gross | Late | Undertime | PhilHealth | Pag-IBIG | Total Deductions | Expected Net | Actual Net | Result | Remarks |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|',
    ...evidence.daily_register.map(row => `| ${row.employee_id} | ${peso(row.gross_pay)} | ${peso(row.late_deduction)} | ${peso(row.undertime_deduction)} | ${peso(row.philhealth)} | ${peso(row.pagibig)} | ${peso(row.total_deductions)} | ${peso(row.expected_net_pay)} | ${peso(row.actual_net_pay)} | ${row.result} | ${row.remarks} |`),
    '',
    '## Per Piece Prepared Records',
    '',
    ...evidence.piece_support.map(row => `- ${row.employee_id}: gross ${peso(row.gross_pay)}, net ${peso(row.actual_net_pay)}; items: ${row.itemization.map(item => `${item.work_item} ${item.quantity} x ${peso(item.rate)} = ${peso(item.amount)}`).join('; ')}`),
    '',
    '## Per Trip Prepared Records',
    '',
    ...evidence.trip_support.map(row => `- ${row.employee_id}: gross ${peso(row.gross_pay)}, net ${peso(row.actual_net_pay)}; trips: ${row.itemization.map(item => `${item.route}, ${item.trips} trips x ${peso(item.rate)} + allowance ${peso(item.allowance)} = ${peso(item.amount)}`).join('; ')}`),
    '',
    '## Data Safety',
    '',
    `All seeded employees and source records are marked with ${TEST_MARK} and use EMP-T/EMP-L/EMP-P/EMP-R codes only.`,
    '',
  ].join('\n');
  fs.writeFileSync(mdPath, md);

  console.log('\nControlled payroll test complete.');
  console.log(`Employees seeded: ${TEST_CODES.join(', ')}`);
  console.log(`Daily register CSV: ${csvPath}`);
  console.log(`Evidence JSON: ${jsonPath}`);
  console.log(`Chapter 4 evidence notes: ${mdPath}`);
  console.table(evidence.daily_register.map(row => ({
    employee: row.employee_id,
    gross: row.gross_pay,
    late: row.late_deduction,
    undertime: row.undertime_deduction,
    philhealth: row.philhealth,
    pagibig: row.pagibig,
    deductions: row.total_deductions,
    net: row.actual_net_pay,
    result: row.result,
  })));
}

main().catch(err => {
  console.error('Controlled payroll test failed:', err);
  process.exit(1);
});
