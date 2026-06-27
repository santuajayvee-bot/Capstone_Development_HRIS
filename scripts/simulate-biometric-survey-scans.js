const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const {
  ingestBiometricEvents,
} = require('../server/attendance-service');

const DEVICE_REFERENCE = 'ZK9500-LOCAL-001';
const OUTPUT_DIR = path.join(__dirname, '..', 'artifacts', 'biometric-survey');
const RESET = process.argv.includes('--reset');
const DATE_ARG = process.argv.find(arg => /^--date=\d{4}-\d{2}-\d{2}$/.test(arg));
const SCAN_DATE = DATE_ARG ? DATE_ARG.split('=')[1] : manilaDateKey();
const LIMIT_ARG = process.argv.find(arg => /^--limit=\d+$/.test(arg));
const LIMIT = LIMIT_ARG ? Number(LIMIT_ARG.split('=')[1]) : 35;

const PUNCHES = [
  { type: 'AUTO', time: '08:00:00', label: 'Time in' },
  { type: 'AUTO', time: '17:00:00', label: 'Time out' },
];

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function manilaDateKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0'),
    ].join('-');
  }
  const match = String(value || '').match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : String(value || '').slice(0, 10);
}

function biometricRefForCode(employeeCode) {
  const match = String(employeeCode || '').match(/SURV-BIO-(\d{3})$/);
  if (!match) return '';
  return `SURVEY-BIO-REF-${match[1]}`;
}

async function resetSurveyAttendance(connection, employeeIds, deviceId) {
  if (!employeeIds.length) return;
  const idSql = employeeIds.map(() => '?').join(', ');
  const [attendanceRows] = await connection.execute(
    `SELECT attendance_id
       FROM attendance_log
      WHERE employee_id IN (${idSql})
        AND date = ?`,
    [...employeeIds, SCAN_DATE]
  );
  const attendanceIds = attendanceRows.map(row => Number(row.attendance_id)).filter(Boolean);
  if (attendanceIds.length) {
    const attendanceSql = attendanceIds.map(() => '?').join(', ');
    await connection.execute(`DELETE FROM attendance_integrity_chain WHERE attendance_id IN (${attendanceSql})`, attendanceIds).catch(() => {});
    await connection.execute(`DELETE FROM attendance_summary WHERE attendance_id IN (${attendanceSql})`, attendanceIds).catch(() => {});
    await connection.execute(`UPDATE biometric_scan_event SET attendance_id = NULL WHERE attendance_id IN (${attendanceSql})`, attendanceIds).catch(() => {});
    await connection.execute(`DELETE FROM attendance_log WHERE attendance_id IN (${attendanceSql})`, attendanceIds);
  }
  await connection.execute(
    `DELETE FROM biometric_scan_event
      WHERE device_id = ?
        AND employee_id IN (${idSql})
        AND DATE(scan_timestamp) = ?`,
    [deviceId, ...employeeIds, SCAN_DATE]
  );
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const connection = await pool.getConnection();
  let device;
  let employees = [];

  try {
    const [devices] = await connection.execute(
      'SELECT * FROM biometric_device WHERE device_reference = ? AND is_active = 1 LIMIT 1',
      [DEVICE_REFERENCE]
    );
    if (!devices[0]) throw new Error(`Active biometric device ${DEVICE_REFERENCE} was not found. Run npm run seed:biometric-survey first.`);
    device = devices[0];

    const [employeeRows] = await connection.execute(
      `SELECT e.id, e.employee_code, e.first_name, e.last_name
         FROM employees e
         JOIN biometric_employee_mapping bem ON bem.employee_id = e.id AND bem.device_id = ? AND bem.is_active = 1
        WHERE e.employee_code LIKE 'SURV-BIO-%'
          AND e.status = 'Active'
        ORDER BY e.employee_code
        LIMIT ?`,
      [device.device_id, LIMIT]
    );
    employees = employeeRows;
    if (!employees.length) throw new Error('No active SURV-BIO employees with biometric mappings were found.');

    if (RESET) {
      await connection.beginTransaction();
      await resetSurveyAttendance(connection, employees.map(row => row.id), device.device_id);
      await connection.commit();
    }
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    throw error;
  } finally {
    connection.release();
  }

  const events = [];
  for (const employee of employees) {
    const biometricUserId = biometricRefForCode(employee.employee_code);
    for (const punch of PUNCHES) {
      events.push({
        external_event_id: `${employee.employee_code}-${SCAN_DATE}-${punch.time}`,
        biometric_user_id: biometricUserId,
        employee_code: employee.employee_code,
        scan_timestamp: `${SCAN_DATE} ${punch.time}`,
        attendance_type: punch.type,
      });
    }
  }

  const summary = await ingestBiometricEvents(device, events);

  const [records] = await pool.execute(
    `SELECT e.employee_code, al.date, al.time_in, al.time_out,
            al.status, al.verification_status, ats.payroll_eligible,
            ats.regular_minutes, ats.late_minutes, ats.undertime_minutes
       FROM attendance_log al
       JOIN employees e ON e.id = al.employee_id
       LEFT JOIN attendance_summary ats ON ats.attendance_id = al.attendance_id
      WHERE e.employee_code LIKE 'SURV-BIO-%'
        AND al.date = ?
      ORDER BY e.employee_code`,
    [SCAN_DATE]
  );

  const result = {
    generated_at: new Date().toISOString(),
    device_reference: DEVICE_REFERENCE,
    scan_date: SCAN_DATE,
    reset_before_run: RESET,
    employees: employees.length,
    events_sent: events.length,
    summary,
    attendance_records: records,
  };

  const jsonPath = path.join(OUTPUT_DIR, `survey-biometric-scan-${SCAN_DATE}.json`);
  const csvPath = path.join(OUTPUT_DIR, `survey-biometric-attendance-${SCAN_DATE}.csv`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  const headers = [
    'Employee Code', 'Date', 'Time In', 'Time Out',
    'Status', 'Verification Status', 'Payroll Eligible', 'Regular Minutes',
    'Late Minutes', 'Undertime Minutes',
  ];
  const csvRows = records.map(row => [
    row.employee_code,
    dateKey(row.date),
    row.time_in || '',
    row.time_out || '',
    row.status,
    row.verification_status,
    row.payroll_eligible,
    row.regular_minutes,
    row.late_minutes,
    row.undertime_minutes,
  ]);
  fs.writeFileSync(csvPath, [headers, ...csvRows].map(row => row.map(csvEscape).join(',')).join('\n'));

  await pool.end();

  console.log('BIOMETRIC SURVEY SCANS SIMULATED');
  console.log(`Date: ${SCAN_DATE}`);
  console.log(`Employees: ${employees.length}`);
  console.log(`Events sent: ${events.length}`);
  console.log(`Accepted: ${summary.accepted}, duplicates: ${summary.duplicates}, rejected: ${summary.rejected}`);
  console.log(`Attendance CSV: ${csvPath}`);
}

main().catch(async error => {
  console.error('BIOMETRIC SURVEY SCAN SIMULATION FAILED:', error.message);
  try { await pool.end(); } catch (_) {}
  process.exitCode = 1;
});
