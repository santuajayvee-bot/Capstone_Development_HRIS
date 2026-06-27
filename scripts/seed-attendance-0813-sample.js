require('dotenv').config();

const pool = require('../config/db');
const {
  getActiveAttendancePolicy,
  getAttendanceStatusForTimeIn,
} = require('../server/attendance-policy-engine');
const {
  appendIntegrityEntry,
  ensureAttendanceLogMetricColumns,
  ensureAttendanceSummaryPolicyColumns,
} = require('../server/attendance-service');

const DATE_ARG = process.argv.find(arg => /^--date=\d{4}-\d{2}-\d{2}$/.test(arg));
const EMPLOYEE_ARG = process.argv.find(arg => /^--employee-code=[A-Za-z0-9_-]+$/.test(arg));
const SAMPLE_DATE = DATE_ARG ? DATE_ARG.split('=')[1] : manilaDateKey();
const EMPLOYEE_CODE = EMPLOYEE_ARG ? EMPLOYEE_ARG.split('=')[1] : null;
const TIME_IN = '08:13:00';
const TIME_OUT = '17:00:00';

function manilaDateKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).reduce((values, part) => {
    values[part.type] = part.value;
    return values;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function minutesFromTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  return match ? (Number(match[1]) * 60) + Number(match[2]) : 0;
}

function timeFromMinutes(value) {
  const minutes = Math.max(0, Number(value || 0));
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

async function findSampleEmployee(connection) {
  if (EMPLOYEE_CODE && !EMPLOYEE_CODE.startsWith('SURV-BIO-')) {
    throw new Error('For safety, this sample seeder only accepts SURV-BIO-* test employees.');
  }

  const params = [SAMPLE_DATE];
  let employeeFilter = "e.employee_code LIKE 'SURV-BIO-%'";
  if (EMPLOYEE_CODE) {
    employeeFilter = 'e.employee_code = ?';
    params.unshift(EMPLOYEE_CODE);
  }

  const [rows] = await connection.execute(
    `SELECT e.id, e.employee_code, e.first_name, e.last_name, al.attendance_id
       FROM employees e
       LEFT JOIN attendance_log al ON al.employee_id = e.id AND al.date = ?
      WHERE ${employeeFilter}
        AND e.status = 'Active'
      ORDER BY CASE WHEN al.attendance_id IS NULL THEN 0 ELSE 1 END, e.employee_code
      LIMIT 1`,
    EMPLOYEE_CODE ? [SAMPLE_DATE, EMPLOYEE_CODE] : params
  );
  if (!rows.length) {
    throw new Error('No active SURV-BIO test employee was found. Run npm run seed:biometric-survey first.');
  }
  return rows[0];
}

async function main() {
  const connection = await pool.getConnection();
  try {
    await ensureAttendanceLogMetricColumns(connection);
    await ensureAttendanceSummaryPolicyColumns(connection);
    const employee = await findSampleEmployee(connection);
    const policy = await getActiveAttendancePolicy(connection, SAMPLE_DATE, { employee_id: employee.id });
    const status = getAttendanceStatusForTimeIn(TIME_IN, policy);

    await connection.beginTransaction();
    const [existingRows] = await connection.execute(
      `SELECT attendance_id
         FROM attendance_log
        WHERE employee_id = ? AND date = ?
        FOR UPDATE`,
      [employee.id, SAMPLE_DATE]
    );

    let attendanceId = Number(existingRows[0]?.attendance_id || 0);
    if (attendanceId) {
      await connection.execute(
        `UPDATE attendance_log
            SET time_in = ?, time_out = ?,
                am_time_in = ?, am_time_out = NULL,
                pm_time_in = NULL, pm_time_out = ?,
                status = ?, verification_status = 'PENDING_VALIDATION',
                source = 'HR_MANUAL_ADJUSTMENT',
                first_scan_at = ?, last_scan_at = ?
          WHERE attendance_id = ?`,
        [
          TIME_IN,
          TIME_OUT,
          TIME_IN,
          TIME_OUT,
          status,
          `${SAMPLE_DATE} ${TIME_IN}`,
          `${SAMPLE_DATE} ${TIME_OUT}`,
          attendanceId,
        ]
      );
    } else {
      const [inserted] = await connection.execute(
        `INSERT INTO attendance_log
           (employee_id, date, time_in, time_out,
            am_time_in, am_time_out, pm_time_in, pm_time_out,
            status, verification_status, source, first_scan_at, last_scan_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'PENDING_VALIDATION',
                 'HR_MANUAL_ADJUSTMENT', ?, ?)`,
        [
          employee.id,
          SAMPLE_DATE,
          TIME_IN,
          TIME_OUT,
          TIME_IN,
          TIME_OUT,
          status,
          `${SAMPLE_DATE} ${TIME_IN}`,
          `${SAMPLE_DATE} ${TIME_OUT}`,
        ]
      );
      attendanceId = Number(inserted.insertId);
    }

    await appendIntegrityEntry(connection, attendanceId, 'TEST_0813_TWO_PUNCH_SAMPLE');
    await connection.commit();

    const [summaryRows] = await connection.execute(
      `SELECT al.status, al.time_in, al.time_out, al.am_time_out, al.pm_time_in,
              ats.attendance_status, ats.late_minutes, ats.regular_minutes,
              ats.undertime_minutes, ats.verification_status
         FROM attendance_log al
         LEFT JOIN attendance_summary ats ON ats.attendance_id = al.attendance_id
        WHERE al.attendance_id = ?`,
      [attendanceId]
    );
    const result = summaryRows[0] || {};
    const cutoffMinutes = minutesFromTime(policy.work_start_time)
      + Number(policy.grace_period_minutes || 0)
      + Number(policy.late_threshold_minutes || 0);
    const policySource = policy.payroll_config_name
      ? `${policy.payroll_config_scope_type}: ${policy.payroll_config_name}`
      : 'Global attendance policy';

    console.log('08:13 ATTENDANCE SAMPLE CREATED');
    console.log(`Employee: ${employee.employee_code} - ${employee.first_name} ${employee.last_name}`);
    console.log(`Date: ${SAMPLE_DATE}`);
    console.log(`Time In / Time Out: ${result.time_in} / ${result.time_out}`);
    console.log(`Policy source: ${policySource}`);
    console.log(`Work start: ${policy.work_start_time}`);
    console.log(`Grace period: ${policy.grace_period_minutes} minute(s)`);
    console.log(`Late threshold: ${policy.late_threshold_minutes} minute(s)`);
    console.log(`Late after: ${timeFromMinutes(cutoffMinutes)}`);
    console.log(`Result: ${result.attendance_status || result.status}`);
    console.log(`Late minutes: ${Number(result.late_minutes || 0)}`);
    console.log(`Legacy AM Out / PM In: ${result.am_time_out || 'NULL'} / ${result.pm_time_in || 'NULL'}`);
    console.log(`Attendance ID: ${attendanceId}`);
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error('08:13 ATTENDANCE SAMPLE FAILED:', error.message);
  process.exitCode = 1;
});
