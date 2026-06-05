/* ============================================================
   Repeatable biometric attendance integration test.
   Creates temporary device data and removes it after verification.
   Requires the local server to be running.
   ============================================================ */

require('dotenv').config();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('./config/db');
const { encryptAES256 } = require('./server/crypto');

const baseUrl = `http://localhost:${process.env.PORT || 3000}`;
const vendorSecret = 'temporary-biometric-test-secret';
const deviceReference = `TEST-BIO-${Date.now()}`;
const biometricUserId = `TEST-USER-${Date.now()}`;
const testDate = '2026-05-28';

let deviceId;
let attendanceId;

function issueToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, employeeId: user.employee_id },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function bearer(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  return { status: response.status, data };
}

function check(message, condition) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
}

async function run() {
  const [users] = await pool.query(`
    SELECT u.id, u.username, u.employee_id, r.name AS role
      FROM users u
      JOIN roles r ON r.id = u.role_id
  `);
  const sysAdmin = users.find(user => user.role === 'system_admin');
  const hrAdmin = users.find(user => user.username === 'hr.admin' && user.role === 'hr_manager')
    || users.find(user => user.role === 'hr_manager');
  const officer = users.find(user => user.role === 'payroll_officer');
  const manager = users.find(user => user.role === 'payroll_manager');
  const employee = users.find(user => user.role === 'employee' && user.employee_id);
  check('Required roles exist', sysAdmin && hrAdmin && officer && manager && employee);

  const [existing] = await pool.execute(
    'SELECT attendance_id FROM attendance_log WHERE employee_id = ? AND date = ?',
    [employee.employee_id, testDate]
  );
  check('Temporary test date is unused', existing.length === 0);

  const [device] = await pool.execute(
    `INSERT INTO biometric_device
       (device_reference, device_name, vendor, auth_type, auth_header_name, auth_secret_encrypted)
     VALUES (?, 'Temporary Integration Test Scanner', 'LGSV Test', 'API_KEY', 'x-biometric-api-key', ?)`,
    [deviceReference, encryptAES256(vendorSecret)]
  );
  deviceId = device.insertId;

  await pool.execute(
    `INSERT INTO biometric_employee_mapping
       (device_id, employee_id, biometric_user_hash, biometric_user_id_encrypted)
     VALUES (?, ?, ?, ?)`,
    [
      deviceId,
      employee.employee_id,
      crypto.createHash('sha256').update(biometricUserId).digest('hex'),
      encryptAES256(biometricUserId),
    ]
  );

  const webhookHeaders = { 'Content-Type': 'application/json', 'x-biometric-api-key': vendorSecret };
  let result = await api(`/api/attendance/biometric/webhook/${deviceReference}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-biometric-api-key': 'wrong-secret' },
    body: JSON.stringify({ id: 'TEST-AUTH', biometric_user_id: biometricUserId, scan_timestamp: `${testDate}T08:00:00+08:00`, attendance_type: 'TIME_IN' })
  });
  check('Wrong biometric API key is rejected', result.status === 401);

  result = await api(`/api/attendance/biometric/webhook/${deviceReference}`, {
    method: 'POST',
    headers: webhookHeaders,
    body: JSON.stringify({
      events: [
        { id: 'TEST-IN', biometric_user_id: biometricUserId, scan_timestamp: `${testDate}T08:05:00+08:00`, attendance_type: 'TIME_IN' },
        { id: 'TEST-OUT', biometric_user_id: biometricUserId, scan_timestamp: `${testDate}T17:10:00+08:00`, attendance_type: 'TIME_OUT' },
      ]
    })
  });
  check('Mapped webhook punches are accepted', result.status === 200 && result.data.accepted === 2);

  result = await api(`/api/attendance/biometric/webhook/${deviceReference}`, {
    method: 'POST',
    headers: webhookHeaders,
    body: JSON.stringify({ id: 'TEST-IN', biometric_user_id: biometricUserId, scan_timestamp: `${testDate}T08:05:00+08:00`, attendance_type: 'TIME_IN' })
  });
  check('Repeated scan is deduplicated', result.status === 200 && result.data.duplicates === 1);

  result = await api(`/api/attendance/biometric/webhook/${deviceReference}`, {
    method: 'POST',
    headers: webhookHeaders,
    body: JSON.stringify({ id: 'TEST-BAD', biometric_user_id: biometricUserId, attendance_type: 'TIME_IN' })
  });
  check('Malformed scan is rejected and monitored', result.status === 207 && result.data.rejected === 1);

  const [records] = await pool.execute(
    'SELECT * FROM attendance_log WHERE employee_id = ? AND date = ?',
    [employee.employee_id, testDate]
  );
  attendanceId = records[0]?.attendance_id;
  check('Validated daily aggregate exists', records.length === 1 && records[0].verification_status === 'VALIDATED');
  check('Biometric reference is encrypted', !records[0].biometric_user_id_encrypted.includes(biometricUserId));

  const [summaries] = await pool.execute('SELECT * FROM attendance_summary WHERE attendance_id = ?', [attendanceId]);
  check('Payroll summary is eligible', summaries.length === 1 && summaries[0].payroll_eligible === 1);

  const [malformed] = await pool.execute(
    `SELECT * FROM biometric_scan_event WHERE device_id = ? AND verification_status = 'MALFORMED'`,
    [deviceId]
  );
  check('Malformed metadata was persisted without raw fingerprint data', malformed.length === 1);

  const tokens = {
    sysAdmin: issueToken(sysAdmin),
    hrAdmin: issueToken(hrAdmin),
    officer: issueToken(officer),
    manager: issueToken(manager),
    employee: issueToken(employee),
  };

  result = await api('/api/attendance/my-records', { headers: bearer(tokens.employee) });
  check('Employee can view own attendance', result.status === 200 && result.data.some(row => Number(row.attendance_id) === Number(attendanceId)));

  result = await api(`/api/attendance/${attendanceId}/override`, {
    method: 'PATCH',
    headers: bearer(tokens.officer),
    body: JSON.stringify({ time_out: '17:15', reason: 'This mutation must be denied.' })
  });
  check('Payroll officer cannot correct attendance', result.status === 403);

  result = await api(`/api/attendance/${attendanceId}/override`, {
    method: 'PATCH',
    headers: bearer(tokens.hrAdmin),
    body: JSON.stringify({ time_out: '17:15' })
  });
  check('HR correction requires an audit reason', result.status === 400);

  result = await api('/api/attendance/summaries', { headers: bearer(tokens.manager) });
  check('Payroll manager can review summaries', result.status === 200);

  result = await api('/api/attendance/all', { headers: bearer(tokens.manager) });
  check('Payroll manager cannot read raw attendance route', result.status === 403);

  result = await api('/api/attendance/biometric/health', { headers: bearer(tokens.sysAdmin) });
  check('System admin can view device health', result.status === 200);

  result = await api('/api/attendance/biometric/health', { headers: bearer(tokens.hrAdmin) });
  check('HR manager cannot manage device health', result.status === 403);

  result = await api(`/api/attendance/integrity/${attendanceId}`, { headers: bearer(tokens.employee) });
  check('Employee integrity verification passes', result.status === 200 && result.data.chain_valid === true);
}

async function cleanup() {
  if (attendanceId) {
    await pool.execute('DELETE FROM attendance_adjustment WHERE attendance_id = ?', [attendanceId]);
    await pool.execute('DELETE FROM attendance_summary WHERE attendance_id = ?', [attendanceId]);
    await pool.execute('DELETE FROM attendance_integrity_chain WHERE attendance_id = ?', [attendanceId]);
  }
  if (deviceId) {
    await pool.execute('DELETE FROM biometric_scan_event WHERE device_id = ?', [deviceId]);
    await pool.execute('DELETE FROM biometric_sync_log WHERE device_id = ?', [deviceId]);
    await pool.execute('DELETE FROM biometric_employee_mapping WHERE device_id = ?', [deviceId]);
    await pool.execute('DELETE FROM biometric_device WHERE device_id = ?', [deviceId]);
  }
  if (attendanceId) await pool.execute('DELETE FROM attendance_log WHERE attendance_id = ?', [attendanceId]);
  await pool.end();
}

run()
  .then(() => console.log('Biometric attendance integration test completed.'))
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
