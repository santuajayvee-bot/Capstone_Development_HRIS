/* ============================================================
   Attendance biometric ingestion and integrity service.

   Privacy design:
   - Never stores raw fingerprint templates or images.
   - Encrypts biometric reference IDs with AES-256-GCM.
   - Uses SHA-256 lookup hashes for deterministic matching.
   ============================================================ */

const crypto = require('crypto');
const pool = require('../config/db');
const { encryptAES256, decryptAES256 } = require('./crypto');
const { requestJson } = require('./secure-http');
const {
  getActiveAttendancePolicy,
  getAttendanceStatusForTimeIn,
  computeAttendanceMetrics,
  getInitialVerificationStatus,
} = require('./attendance-policy-engine');
const { classifyDtrPunch, dtrUpdateValues, hasRequiredDtrPunches } = require('./dtr-punch');
const { getHolidayForDate } = require('./holiday-service');
const { recordTardinessPolicyAlert } = require('./tardiness-policy');

const GENESIS_HASH = '0'.repeat(64);
const VALID_TYPES = new Set(['TIME_IN', 'TIME_OUT', 'AUTO']);
const PAYROLL_READY_STATUSES = new Set(['VALIDATED', 'PAYROLL_READY']);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function timingSafeEqualText(actual, expected) {
  const a = Buffer.from(String(actual || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeBiometricIngestionError(err, fallback = 'Biometric attendance event could not be processed.') {
  const message = String(err?.message || '').trim();
  const code = String(err?.code || '');
  if (
    err?.sqlMessage ||
    err?.sqlState ||
    code.startsWith('ER_') ||
    /\b(sql|mysql|database|table|column|constraint|syntax|foreign key|select|insert|update|delete)\b/i.test(message)
  ) {
    return fallback;
  }
  return message || fallback;
}

async function ensureAttendanceSummaryPolicyColumns(conn) {
  const [columns] = await conn.execute(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'attendance_summary'
        AND COLUMN_NAME IN ('undertime_minutes','policy_snapshot_json','overtime_status')`
  );
  const existing = new Set(columns.map((row) => row.COLUMN_NAME));
  if (!existing.has('undertime_minutes')) {
    await conn.execute('ALTER TABLE attendance_summary ADD COLUMN undertime_minutes INT NOT NULL DEFAULT 0 AFTER late_minutes');
  }
  if (!existing.has('policy_snapshot_json')) {
    await conn.execute('ALTER TABLE attendance_summary ADD COLUMN policy_snapshot_json JSON NULL AFTER integrity_hash');
  }
  if (!existing.has('overtime_status')) {
    await conn.execute("ALTER TABLE attendance_summary ADD COLUMN overtime_status ENUM('NONE','PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'NONE' AFTER overtime_minutes");
  }
}

async function ensureAttendanceLogMetricColumns(conn) {
  const [columns] = await conn.execute(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'attendance_log'
        AND COLUMN_NAME IN ('late_minutes','undertime_minutes','overtime_minutes','overtime_status','overtime_reviewed_by','overtime_reviewed_at','overtime_review_reason')`
  );
  const existing = new Set(columns.map((row) => row.COLUMN_NAME));
  if (!existing.has('late_minutes')) {
    await conn.execute('ALTER TABLE attendance_log ADD COLUMN late_minutes INT NOT NULL DEFAULT 0 AFTER overtime_hours');
  }
  if (!existing.has('undertime_minutes')) {
    await conn.execute('ALTER TABLE attendance_log ADD COLUMN undertime_minutes INT NOT NULL DEFAULT 0 AFTER late_minutes');
  }
  if (!existing.has('overtime_minutes')) {
    await conn.execute('ALTER TABLE attendance_log ADD COLUMN overtime_minutes INT NOT NULL DEFAULT 0 AFTER undertime_minutes');
  }
  if (!existing.has('overtime_status')) {
    await conn.execute("ALTER TABLE attendance_log ADD COLUMN overtime_status ENUM('NONE','PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'NONE' AFTER overtime_minutes");
  }
  if (!existing.has('overtime_reviewed_by')) {
    await conn.execute('ALTER TABLE attendance_log ADD COLUMN overtime_reviewed_by BIGINT NULL AFTER overtime_status');
  }
  if (!existing.has('overtime_reviewed_at')) {
    await conn.execute('ALTER TABLE attendance_log ADD COLUMN overtime_reviewed_at DATETIME NULL AFTER overtime_reviewed_by');
  }
  if (!existing.has('overtime_review_reason')) {
    await conn.execute('ALTER TABLE attendance_log ADD COLUMN overtime_review_reason VARCHAR(500) NULL AFTER overtime_reviewed_at');
  }
}

function getManilaParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    dateTime: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function minutesFromTime(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isLaterTime(candidate, current) {
  return minutesFromTime(candidate) > minutesFromTime(current);
}

function isAutoTimeOutEligible(scanTime, policy) {
  return minutesFromTime(scanTime) >= minutesFromTime(policy.work_end_time || '17:00');
}

function normalizeTimestamp(value) {
  if (!value) throw new Error('scan_timestamp is required.');
  const raw = String(value).trim();
  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const parsed = new Date(hasTimezone ? raw : `${raw.replace(' ', 'T')}+08:00`);
  if (Number.isNaN(parsed.getTime())) throw new Error('scan_timestamp is invalid.');

  const now = Date.now();
  if (parsed.getTime() > now + 24 * 60 * 60 * 1000) {
    throw new Error('scan_timestamp is too far in the future.');
  }
  if (parsed.getTime() < now - 2 * 365 * 24 * 60 * 60 * 1000) {
    throw new Error('scan_timestamp is outside the supported synchronization window.');
  }
  return parsed;
}

function normalizeAttendanceType(value) {
  const normalized = String(value || 'AUTO').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const aliases = {
    IN: 'TIME_IN',
    CLOCK_IN: 'TIME_IN',
    CHECK_IN: 'TIME_IN',
    OUT: 'TIME_OUT',
    CLOCK_OUT: 'TIME_OUT',
    CHECK_OUT: 'TIME_OUT',
  };
  const type = aliases[normalized] || normalized;
  if (!VALID_TYPES.has(type)) throw new Error('attendance_type must be TIME_IN, TIME_OUT, or AUTO.');
  return type;
}

function normalizeEvent(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) {
    throw new Error('Each biometric event must be an object.');
  }

  const biometricUserId = String(
    rawEvent.biometric_user_id ??
    rawEvent.biometricUserId ??
    rawEvent.user_id ??
    rawEvent.userId ??
    ''
  ).trim();
  const employeeCode = String(rawEvent.employee_code ?? rawEvent.employeeCode ?? '').trim();

  if (!biometricUserId && !employeeCode) {
    throw new Error('biometric_user_id or employee_code is required.');
  }

  const timestamp = normalizeTimestamp(
    rawEvent.scan_timestamp ??
    rawEvent.scanTimestamp ??
    rawEvent.timestamp ??
    rawEvent.scanned_at
  );

  return {
    externalEventId: String(rawEvent.external_event_id ?? rawEvent.event_id ?? rawEvent.id ?? '').trim() || null,
    biometricUserId,
    employeeCode,
    timestamp,
    attendanceType: normalizeAttendanceType(rawEvent.attendance_type ?? rawEvent.type ?? rawEvent.punch_type),
  };
}

async function recordMalformedEvent(device, rawEvent, error) {
  const biometricUserId = String(
    rawEvent?.biometric_user_id ??
    rawEvent?.biometricUserId ??
    rawEvent?.user_id ??
    rawEvent?.userId ??
    ''
  ).trim();
  const rawType = String(rawEvent?.attendance_type ?? rawEvent?.type ?? 'AUTO').trim().toUpperCase();
  const attendanceType = VALID_TYPES.has(rawType) ? rawType : 'AUTO';
  let scanTimestamp = null;
  try {
    scanTimestamp = getManilaParts(normalizeTimestamp(
      rawEvent?.scan_timestamp ?? rawEvent?.scanTimestamp ?? rawEvent?.timestamp ?? rawEvent?.scanned_at
    )).dateTime;
  } catch {
    scanTimestamp = null;
  }

  const payloadHash = sha256(canonicalJson(rawEvent));
  const idempotencyKey = sha256(`${device.device_id}:MALFORMED:${payloadHash}`);
  try {
    await pool.execute(
      `INSERT INTO biometric_scan_event
         (external_event_id, idempotency_key, device_id, biometric_user_hash,
          biometric_user_id_encrypted, scan_timestamp, attendance_type,
          verification_status, payload_hash, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'MALFORMED', ?, ?)`,
      [
        String(rawEvent?.external_event_id ?? rawEvent?.event_id ?? rawEvent?.id ?? '').trim() || null,
        idempotencyKey,
        device.device_id,
        biometricUserId ? sha256(biometricUserId) : null,
        biometricUserId ? encryptAES256(biometricUserId) : null,
        scanTimestamp,
        attendanceType,
        payloadHash,
        String(error.message || 'Malformed biometric event.').slice(0, 500),
      ]
    );
  } catch (insertError) {
    if (insertError.code !== 'ER_DUP_ENTRY') throw insertError;
  }
}

async function findEmployee(conn, deviceId, event) {
  if (event.biometricUserId) {
    const userHash = sha256(event.biometricUserId);
    const [mappings] = await conn.execute(
      `SELECT bem.employee_id
         FROM biometric_employee_mapping bem
         JOIN employees e ON e.id = bem.employee_id
        WHERE bem.device_id = ?
          AND bem.biometric_user_hash = ?
          AND bem.is_active = 1
          AND e.status = 'Active'
        LIMIT 1`,
      [deviceId, userHash]
    );
    if (mappings.length) return { employeeId: mappings[0].employee_id, biometricUserHash: userHash };
  }

  if (event.employeeCode) {
    const [employees] = await conn.execute(
      `SELECT id FROM employees WHERE employee_code = ? AND status = 'Active' LIMIT 1`,
      [event.employeeCode]
    );
    if (employees.length) {
      return {
        employeeId: employees[0].id,
        biometricUserHash: event.biometricUserId ? sha256(event.biometricUserId) : null,
      };
    }
  }

  return {
    employeeId: null,
    biometricUserHash: event.biometricUserId ? sha256(event.biometricUserId) : null,
  };
}

async function refreshSummary(conn, attendanceId) {
  const [rows] = await conn.execute(
    `SELECT attendance_id, employee_id, date, time_in, time_out,
            am_time_in, am_time_out, pm_time_in, pm_time_out, overtime_hours,
            overtime_status, status, verification_status, integrity_hash
       FROM attendance_log
      WHERE attendance_id = ?`,
    [attendanceId]
  );
  if (!rows.length) return;
  const row = rows[0];
  await ensureAttendanceSummaryPolicyColumns(conn);
  await ensureAttendanceLogMetricColumns(conn);

  const policy = await getActiveAttendancePolicy(conn, row.date, { employee_id: row.employee_id });
  const holiday = policy.enable_holiday_rules ? await getHolidayForDate(conn, row.date, 'PH') : null;
  const metrics = computeAttendanceMetrics(row, policy);
  const { regularMinutes, overtimeMinutes: detectedOvertimeMinutes, lateMinutes, undertimeMinutes, attendanceStatus } = metrics;
  const minimumOvertimeMinutes = Math.max(0, Math.round(Number(policy.minimum_overtime_minutes || 0)));
  const overtimeStatus = !policy.enable_overtime || detectedOvertimeMinutes <= 0 || detectedOvertimeMinutes < minimumOvertimeMinutes
    ? 'NONE'
    : !policy.overtime_approval_required
      ? 'APPROVED'
      : ['APPROVED', 'REJECTED', 'PENDING'].includes(String(row.overtime_status || '').toUpperCase())
        ? String(row.overtime_status || '').toUpperCase()
        : 'PENDING';
  const payableOvertimeMinutes = overtimeStatus === 'APPROVED' ? detectedOvertimeMinutes : 0;
  const statusReady = policy.payroll_attendance_source === 'validated'
    ? PAYROLL_READY_STATUSES.has(row.verification_status)
    : row.verification_status === 'PAYROLL_READY';
  const payrollEligible = statusReady && !!row.time_in && !!row.time_out && hasRequiredDtrPunches(row) ? 1 : 0;
  const policySnapshot = JSON.stringify({
    work_start_time: policy.work_start_time,
    work_end_time: policy.work_end_time,
    break_start_time: policy.break_start_time,
    break_end_time: policy.break_end_time,
    standard_work_hours: policy.standard_work_hours,
    grace_period_minutes: policy.grace_period_minutes,
    overtime_threshold_minutes: policy.overtime_threshold_minutes,
    minimum_overtime_minutes: minimumOvertimeMinutes,
    overtime_approval_required: policy.overtime_approval_required,
    detected_overtime_minutes: detectedOvertimeMinutes,
    payable_overtime_minutes: payableOvertimeMinutes,
    overtime_status: overtimeStatus,
    payroll_attendance_source: policy.payroll_attendance_source,
    missing_timeout_handling: policy.missing_timeout_handling,
    payroll_config_id: policy.payroll_config_id || null,
    payroll_config_name: policy.payroll_config_name || null,
    payroll_config_scope_type: policy.payroll_config_scope_type || null,
    working_days_per_month: policy.working_days_per_month || null,
    working_days_per_year: policy.working_days_per_year || null,
    habitual_tardiness_threshold: policy.habitual_tardiness_threshold || null,
    holiday: {
      enabled: policy.enable_holiday_rules,
      date: holiday?.holiday_date || null,
      name: holiday?.name || null,
      local_name: holiday?.local_name || null,
      type: holiday?.holiday_type || null,
      multiplier: holiday?.multiplier || null,
      is_paid: holiday?.is_paid ?? null,
      regular_multiplier: policy.regular_holiday_multiplier,
      special_multiplier: policy.special_holiday_multiplier,
      rest_day_multiplier: policy.rest_day_multiplier,
      overtime_multiplier: policy.holiday_overtime_multiplier,
    },
  });

  await conn.execute(
    `UPDATE attendance_log
        SET late_minutes = ?,
            undertime_minutes = ?,
            overtime_minutes = ?,
            overtime_status = ?
      WHERE attendance_id = ?`,
    [lateMinutes, undertimeMinutes, detectedOvertimeMinutes, overtimeStatus, row.attendance_id]
  );

  await conn.execute(
    `INSERT INTO attendance_summary
       (employee_id, attendance_date, attendance_id, regular_minutes, overtime_minutes, overtime_status,
        late_minutes, undertime_minutes, attendance_status, verification_status, payroll_eligible, integrity_hash, policy_snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       attendance_id = VALUES(attendance_id),
       regular_minutes = VALUES(regular_minutes),
       overtime_minutes = VALUES(overtime_minutes),
       overtime_status = VALUES(overtime_status),
       late_minutes = VALUES(late_minutes),
       undertime_minutes = VALUES(undertime_minutes),
       attendance_status = VALUES(attendance_status),
       verification_status = VALUES(verification_status),
       payroll_eligible = VALUES(payroll_eligible),
       integrity_hash = VALUES(integrity_hash),
       policy_snapshot_json = VALUES(policy_snapshot_json)`,
    [
      row.employee_id,
      row.date,
      row.attendance_id,
      regularMinutes,
      payableOvertimeMinutes,
      overtimeStatus,
      lateMinutes,
      undertimeMinutes,
      attendanceStatus,
      row.verification_status,
      payrollEligible,
      row.integrity_hash,
      policySnapshot,
    ]
  );
  if (lateMinutes > 0) {
    await recordTardinessPolicyAlert(conn, row, policy);
  }
}

async function appendIntegrityEntry(conn, attendanceId, eventType) {
  const [locks] = await conn.execute("SELECT GET_LOCK('attendance_integrity_chain', 5) AS acquired");
  if (Number(locks[0]?.acquired) !== 1) throw new Error('Attendance integrity ledger is busy. Please retry.');

  try {
    const [records] = await conn.execute(
      `SELECT attendance_id, employee_id, date, time_in, time_out,
              am_time_in, am_time_out, pm_time_in, pm_time_out, overtime_hours,
              absences, status, biometric_user_hash, device_id, verification_status,
              source, first_scan_at, last_scan_at
         FROM attendance_log
        WHERE attendance_id = ?`,
      [attendanceId]
    );
    if (!records.length) throw new Error('Attendance record not found for integrity hashing.');

    const payloadHash = sha256(canonicalJson(records[0]));
    const [previousRows] = await conn.execute(
      'SELECT chain_hash FROM attendance_integrity_chain ORDER BY chain_id DESC LIMIT 1'
    );
    const previousHash = previousRows[0]?.chain_hash || GENESIS_HASH;
    const chainHash = sha256(`${payloadHash}:${previousHash}:${eventType}`);

    await conn.execute(
      `INSERT INTO attendance_integrity_chain
         (attendance_id, event_type, payload_hash, previous_hash, chain_hash)
       VALUES (?, ?, ?, ?, ?)`,
      [attendanceId, eventType, payloadHash, previousHash, chainHash]
    );
    await conn.execute(
      'UPDATE attendance_log SET integrity_hash = ? WHERE attendance_id = ?',
      [chainHash, attendanceId]
    );
    await refreshSummary(conn, attendanceId);
    return chainHash;
  } finally {
    await conn.execute("SELECT RELEASE_LOCK('attendance_integrity_chain')");
  }
}

async function updateScanEvent(conn, scanEventId, values) {
  await conn.execute(
    `UPDATE biometric_scan_event
        SET employee_id = ?, biometric_user_hash = ?, biometric_user_id_encrypted = ?,
            verification_status = ?, attendance_id = ?, error_message = ?
      WHERE scan_event_id = ?`,
    [
      values.employeeId || null,
      values.biometricUserHash || null,
      values.biometricUserIdEncrypted || null,
      values.verificationStatus,
      values.attendanceId || null,
      values.errorMessage || null,
      scanEventId,
    ]
  );
}

async function processMappedEvent(conn, device, event, match, scanEventId) {
  const manila = getManilaParts(event.timestamp);
  const policy = await getActiveAttendancePolicy(conn, manila.date, { employee_id: match.employeeId });
  const encryptedBiometricId = event.biometricUserId ? encryptAES256(event.biometricUserId) : null;
  if (policy.duplicate_scan_window_seconds > 0) {
    const [recent] = await conn.execute(
      `SELECT scan_event_id, attendance_id
         FROM biometric_scan_event
        WHERE employee_id = ?
          AND device_id = ?
          AND scan_event_id <> ?
          AND scan_timestamp BETWEEN DATE_SUB(?, INTERVAL ${policy.duplicate_scan_window_seconds} SECOND)
                                 AND DATE_ADD(?, INTERVAL ${policy.duplicate_scan_window_seconds} SECOND)
        LIMIT 1`,
      [match.employeeId, device.device_id, scanEventId, manila.dateTime, manila.dateTime]
    );
    if (recent.length) {
      await updateScanEvent(conn, scanEventId, {
        ...match,
        biometricUserIdEncrypted: encryptedBiometricId,
        verificationStatus: 'DUPLICATE',
        attendanceId: recent[0].attendance_id,
        errorMessage: `Duplicate biometric scan within ${policy.duplicate_scan_window_seconds} seconds.`,
      });
      return { status: 'duplicate', attendanceId: recent[0].attendance_id };
    }
  }
  const [rows] = await conn.execute(
    'SELECT * FROM attendance_log WHERE employee_id = ? AND date = ? FOR UPDATE',
    [match.employeeId, manila.date]
  );
  let record = rows[0] || null;
  const punch = classifyDtrPunch(record, manila.time, policy, event.attendanceType);
  const attendanceType = punch.attendanceType || event.attendanceType;

  if (punch.status === 'intermediate') {
    await updateScanEvent(conn, scanEventId, {
      ...match,
      biometricUserIdEncrypted: encryptedBiometricId,
      verificationStatus: 'VALIDATED',
      attendanceId: record?.attendance_id,
      errorMessage: 'Intermediate biometric scan; DTR attendance unchanged.',
    });
    return { status: 'intermediate', attendanceId: record?.attendance_id };
  }

  if (punch.status === 'duplicate') {
    await updateScanEvent(conn, scanEventId, {
      ...match,
      biometricUserIdEncrypted: encryptedBiometricId,
      verificationStatus: 'DUPLICATE',
      attendanceId: record?.attendance_id,
      errorMessage: 'DTR punch already exists for this employee and date.',
    });
    return { status: 'duplicate', attendanceId: record?.attendance_id };
  }

  if (!record) {
    const next = dtrUpdateValues(null, punch.slot, manila.time);
    const status = next.time_in ? getAttendanceStatusForTimeIn(next.time_in, policy) : 'Incomplete';
    const verificationStatus = getInitialVerificationStatus(attendanceType, policy, { missingTimeIn: !next.time_in });
    const [result] = await conn.execute(
      `INSERT INTO attendance_log
         (employee_id, date, time_in, time_out, am_time_in, am_time_out, pm_time_in, pm_time_out, status, biometric_user_hash,
          biometric_user_id_encrypted, device_id, verification_status, source,
          first_scan_at, last_scan_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BIOMETRIC_API', ?, ?)`,
      [
        match.employeeId,
        manila.date,
        next.time_in,
        next.time_out,
        next.am_time_in,
        next.am_time_out,
        next.pm_time_in,
        next.pm_time_out,
        status,
        match.biometricUserHash,
        encryptedBiometricId,
        device.device_id,
        verificationStatus,
        manila.dateTime,
        manila.dateTime,
      ]
    );
    record = { attendance_id: result.insertId };
  } else {
    const next = dtrUpdateValues(record, punch.slot, manila.time);
    await conn.execute(
      `UPDATE attendance_log
          SET time_in = ?, time_out = ?,
              am_time_in = ?, am_time_out = ?, pm_time_in = ?, pm_time_out = ?,
              status = ?, biometric_user_hash = ?,
              biometric_user_id_encrypted = ?, device_id = ?, source = 'BIOMETRIC_API',
              verification_status = ?,
              first_scan_at = COALESCE(first_scan_at, ?), last_scan_at = ?
        WHERE attendance_id = ?`,
      [
        next.time_in,
        next.time_out,
        next.am_time_in,
        next.am_time_out,
        next.pm_time_in,
        next.pm_time_out,
        next.time_in ? getAttendanceStatusForTimeIn(next.time_in, policy) : 'Incomplete',
        match.biometricUserHash,
        encryptedBiometricId,
        device.device_id,
        getInitialVerificationStatus(attendanceType, policy),
        manila.dateTime,
        manila.dateTime,
        record.attendance_id,
      ]
    );
  }

  await updateScanEvent(conn, scanEventId, {
    ...match,
    biometricUserIdEncrypted: encryptedBiometricId,
    verificationStatus: 'VALIDATED',
    attendanceId: record.attendance_id,
  });
  await appendIntegrityEntry(conn, record.attendance_id, `BIOMETRIC_${attendanceType}`);
  return { status: 'accepted', attendanceId: record.attendance_id };
}

async function ingestBiometricEvent(device, rawEvent) {
  const conn = await pool.getConnection();
  let event;
  try {
    event = normalizeEvent(rawEvent);
  } catch (err) {
    await recordMalformedEvent(device, rawEvent, err);
    return { status: 'rejected', error: err.message };
  }

  const payloadHash = sha256(canonicalJson(rawEvent));
  const idempotencyKey = sha256(
    `${device.device_id}:${event.externalEventId || ''}:${event.biometricUserId || event.employeeCode}:${event.timestamp.toISOString()}:${event.attendanceType}`
  );

  try {
    await conn.beginTransaction();
    let scanEventId;
    try {
      const [insert] = await conn.execute(
        `INSERT INTO biometric_scan_event
           (external_event_id, idempotency_key, device_id, scan_timestamp,
            attendance_type, verification_status, payload_hash)
         VALUES (?, ?, ?, ?, ?, 'NEEDS_REVIEW', ?)`,
        [
          event.externalEventId,
          idempotencyKey,
          device.device_id,
          getManilaParts(event.timestamp).dateTime,
          event.attendanceType,
          payloadHash,
        ]
      );
      scanEventId = insert.insertId;
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        await conn.rollback();
        return { status: 'duplicate', error: 'Repeated biometric event ignored.' };
      }
      throw err;
    }

    const match = await findEmployee(conn, device.device_id, event);
    if (!match.employeeId) {
      await updateScanEvent(conn, scanEventId, {
        ...match,
        biometricUserIdEncrypted: event.biometricUserId ? encryptAES256(event.biometricUserId) : null,
        verificationStatus: 'UNMAPPED',
        errorMessage: 'No active employee mapping exists for this biometric reference.',
      });
      await conn.commit();
      return { status: 'rejected', error: 'Biometric reference is not mapped to an active employee.' };
    }

    const result = await processMappedEvent(conn, device, event, match, scanEventId);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function summarizeResults(results) {
  return results.reduce((summary, result) => {
    summary.received += 1;
    if (result.status === 'accepted') summary.accepted += 1;
    else if (result.status === 'duplicate') summary.duplicates += 1;
    else summary.rejected += 1;
    return summary;
  }, { received: 0, accepted: 0, duplicates: 0, rejected: 0 });
}

async function ingestBiometricEvents(device, events) {
  if (!Array.isArray(events)) throw new Error('Biometric payload must contain an events array.');
  if (events.length > 1000) throw new Error('A maximum of 1000 biometric events is allowed per request.');

  const results = [];
  for (const event of events) {
    try {
      results.push(await ingestBiometricEvent(device, event));
    } catch (err) {
      console.error('[attendance/biometric-event]', err.message, err.code || '');
      results.push({ status: 'rejected', error: safeBiometricIngestionError(err) });
    }
  }
  return { ...summarizeResults(results), results };
}

function getDeviceSecret(device) {
  return device.auth_secret_encrypted ? decryptAES256(device.auth_secret_encrypted) : '';
}

function buildDeviceAuthHeaders(device, method, path, body = null) {
  const secret = getDeviceSecret(device);
  if (device.auth_type === 'API_KEY') return { [device.auth_header_name || 'x-biometric-api-key']: secret };
  if (device.auth_type === 'BEARER' || device.auth_type === 'OAUTH2') return { Authorization: `Bearer ${secret}` };
  if (device.auth_type === 'HMAC') {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = body == null ? '' : JSON.stringify(body);
    const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${method}.${path}.${payload}`).digest('hex');
    return { 'x-biometric-timestamp': timestamp, 'x-biometric-signature': `sha256=${signature}` };
  }
  return {};
}

async function pullDeviceLogs(device) {
  if (!device.api_base_url) throw new Error('The biometric device API base URL is not configured.');
  const endpoint = device.logs_endpoint || '/attendance/logs';
  const url = new URL(endpoint, device.api_base_url).toString();
  const headers = buildDeviceAuthHeaders(device, 'GET', new URL(url).pathname);
  const response = await requestJson(url, {
    headers,
    allowHttp: process.env.ALLOW_INSECURE_BIOMETRIC_API === 'true' && process.env.NODE_ENV !== 'production',
    clientCertPath: process.env.BIOMETRIC_MTLS_CERT_PATH,
    clientKeyPath: process.env.BIOMETRIC_MTLS_KEY_PATH,
    caPath: process.env.BIOMETRIC_CA_PATH,
  });
  return Array.isArray(response.data) ? response.data : response.data.events;
}

async function anchorIntegrityEntry(entry) {
  if (!process.env.BLOCKCHAIN_API_URL) return { skipped: true };
  const endpoint = new URL('/api/attendance/anchors', process.env.BLOCKCHAIN_API_URL).toString();
  const body = {
    chain_id: entry.chain_id,
    attendance_id: entry.attendance_id,
    event_type: entry.event_type,
    payload_hash: entry.payload_hash,
    previous_hash: entry.previous_hash,
    chain_hash: entry.chain_hash,
  };
  const headers = process.env.BLOCKCHAIN_API_TOKEN
    ? { Authorization: `Bearer ${process.env.BLOCKCHAIN_API_TOKEN}` }
    : {};
  const response = await requestJson(endpoint, {
    method: 'POST',
    headers,
    body,
    clientCertPath: process.env.BLOCKCHAIN_MTLS_CERT_PATH,
    clientKeyPath: process.env.BLOCKCHAIN_MTLS_KEY_PATH,
    caPath: process.env.BLOCKCHAIN_CA_PATH,
  });
  return { reference: String(response.data.transaction_id || response.data.reference || response.data.id || '') };
}

module.exports = {
  appendIntegrityEntry,
  anchorIntegrityEntry,
  buildDeviceAuthHeaders,
  canonicalJson,
  getDeviceSecret,
  ingestBiometricEvents,
  ensureAttendanceLogMetricColumns,
  ensureAttendanceSummaryPolicyColumns,
  pullDeviceLogs,
  recordTardinessPolicyAlert,
  refreshSummary,
  sha256,
  timingSafeEqualText,
};
