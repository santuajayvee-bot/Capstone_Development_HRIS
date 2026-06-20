const DEFAULT_ATTENDANCE_POLICIES = [
  ['Work Schedule Policy', 'schedule', 'work_start_time', '08:00'],
  ['Work Schedule Policy', 'schedule', 'work_end_time', '17:00'],
  ['Work Schedule Policy', 'schedule', 'break_start_time', '12:00'],
  ['Work Schedule Policy', 'schedule', 'break_end_time', '13:00'],
  ['Work Schedule Policy', 'schedule', 'standard_work_hours', '8'],
  ['Grace Period Policy', 'validation', 'grace_period_minutes', '10'],
  ['Late Policy', 'validation', 'enable_late_tracking', 'true'],
  ['Late Policy', 'validation', 'late_threshold_minutes', '0'],
  ['Late Policy', 'validation', 'count_late_for_payroll', 'true'],
  ['Late Deduction Policy', 'payroll', 'late_deduction_method', 'auto_compute'],
  ['Late Deduction Policy', 'payroll', 'late_fixed_deduction_amount', '0'],
  ['Late Deduction Policy', 'payroll', 'late_apply_grace_period', 'true'],
  ['Late Deduction Policy', 'payroll', 'late_require_hr_approval', 'true'],
  ['Undertime Policy', 'validation', 'enable_undertime_tracking', 'true'],
  ['Undertime Policy', 'validation', 'count_undertime_for_payroll', 'true'],
  ['Undertime Deduction Policy', 'payroll', 'undertime_deduction_method', 'auto_compute'],
  ['Undertime Deduction Policy', 'payroll', 'undertime_fixed_deduction_amount', '0'],
  ['Undertime Deduction Policy', 'payroll', 'undertime_require_hr_approval', 'true'],
  ['Half-Day Policy', 'validation', 'enable_half_day_rule', 'true'],
  ['Half-Day Policy', 'validation', 'half_day_threshold_hours', '4'],
  ['Overtime Policy', 'overtime', 'enable_overtime', 'true'],
  ['Overtime Policy', 'overtime', 'overtime_threshold_minutes', '480'],
  ['Overtime Policy', 'overtime', 'overtime_approval_required', 'true'],
  ['Overtime Policy', 'overtime', 'minimum_overtime_minutes', '30'],
  ['Attendance Validation Policy', 'validation', 'require_hr_validation', 'true'],
  ['Attendance Validation Policy', 'validation', 'auto_payroll_ready', 'false'],
  ['Attendance Validation Policy', 'validation', 'validation_expiration_days', '3'],
  ['Missing Time Out Policy', 'exceptions', 'missing_timeout_handling', 'Needs Review'],
  ['Duplicate Scan Policy', 'biometric', 'duplicate_scan_window_seconds', '60'],
  ['Payroll Attendance Policy', 'payroll', 'payroll_attendance_source', 'payroll_ready'],
  ['Payroll Attendance Policy', 'payroll', 'working_days_per_month', '26'],
  ['Holiday Policy', 'holiday', 'enable_holiday_rules', 'false'],
  ['Holiday Policy', 'holiday', 'regular_holiday_multiplier', '2.00'],
  ['Holiday Policy', 'holiday', 'special_holiday_multiplier', '1.30'],
  ['Holiday Policy', 'holiday', 'rest_day_multiplier', '1.30'],
  ['Holiday Policy', 'holiday', 'holiday_overtime_multiplier', '1.30'],
  ['Attendance Exception Policy', 'exceptions', 'allow_manual_attendance', 'true'],
  ['Attendance Exception Policy', 'exceptions', 'allow_hr_correction', 'true'],
  ['Attendance Exception Policy', 'exceptions', 'allow_manager_certification', 'false'],
  ['Attendance Exception Policy', 'exceptions', 'device_failure_handling', 'HR Correction Required'],
];

const POLICY_KEYS = new Set(DEFAULT_ATTENDANCE_POLICIES.map((row) => row[2]));

function toBool(value, fallback = false) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanPolicyValue(value, maxLength = 500) {
  return String(value ?? '').trim().replace(/[<>]/g, '').slice(0, maxLength);
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return new Date().toISOString().slice(0, 10);
}

async function hasColumn(pool, table, column) {
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function addColumnIfMissing(pool, table, column, definition) {
  if (!(await hasColumn(pool, table, column))) {
    await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function normalizeLegacyPolicyTable(pool) {
  const hasSettingKey = await hasColumn(pool, 'attendance_policy_settings', 'setting_key');
  const hasId = await hasColumn(pool, 'attendance_policy_settings', 'id');
  if (hasSettingKey && !hasId) {
    try { await pool.execute('ALTER TABLE attendance_policy_settings DROP PRIMARY KEY'); } catch (_) {}
    try { await pool.execute('ALTER TABLE attendance_policy_settings MODIFY setting_key VARCHAR(100) NULL'); } catch (_) {}
    await pool.execute('ALTER TABLE attendance_policy_settings ADD COLUMN id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST');
  }
}

async function ensureAttendancePolicySettings(pool) {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS attendance_policy_settings (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      policy_name VARCHAR(120) NULL,
      policy_category VARCHAR(80) NULL,
      policy_key VARCHAR(120) NULL,
      policy_value TEXT NULL,
      effective_date DATE NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by BIGINT NULL,
      updated_by BIGINT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_att_policy_lookup (policy_key, is_active, effective_date),
      INDEX idx_att_policy_category (policy_category, is_active)
    )
  `);

  await normalizeLegacyPolicyTable(pool);
  await addColumnIfMissing(pool, 'attendance_policy_settings', 'policy_name', 'VARCHAR(120) NULL');
  await addColumnIfMissing(pool, 'attendance_policy_settings', 'policy_category', 'VARCHAR(80) NULL');
  await addColumnIfMissing(pool, 'attendance_policy_settings', 'policy_key', 'VARCHAR(120) NULL');
  await addColumnIfMissing(pool, 'attendance_policy_settings', 'policy_value', 'TEXT NULL');
  await addColumnIfMissing(pool, 'attendance_policy_settings', 'effective_date', 'DATE NULL');
  await addColumnIfMissing(pool, 'attendance_policy_settings', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing(pool, 'attendance_policy_settings', 'created_by', 'BIGINT NULL');
  await addColumnIfMissing(pool, 'attendance_policy_settings', 'updated_by', 'BIGINT NULL');
  await addColumnIfMissing(pool, 'attendance_policy_settings', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
  await addColumnIfMissing(pool, 'attendance_policy_settings', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
  try { await pool.execute('CREATE INDEX idx_att_policy_lookup ON attendance_policy_settings (policy_key, is_active, effective_date)'); } catch (_) {}
  try { await pool.execute('CREATE INDEX idx_att_policy_category ON attendance_policy_settings (policy_category, is_active)'); } catch (_) {}

  for (const [name, category, key, value] of DEFAULT_ATTENDANCE_POLICIES) {
    await pool.execute(
      `INSERT INTO attendance_policy_settings
         (policy_name, policy_category, policy_key, policy_value, effective_date, is_active)
       SELECT ?, ?, ?, ?, CURDATE(), 1
        WHERE NOT EXISTS (
          SELECT 1 FROM attendance_policy_settings
           WHERE policy_key = ? AND is_active = 1
        )`,
      [name, category, key, value, key]
    );
  }

  await migrateLegacyPolicyValues(pool);
}

async function migrateLegacyPolicyValues(pool) {
  if (!(await hasColumn(pool, 'attendance_policy_settings', 'setting_key'))) return;
  const [rows] = await pool.execute(
    `SELECT setting_key, setting_value
       FROM attendance_policy_settings
      WHERE setting_key IS NOT NULL`
  );
  const map = new Map([
    ['duplicate_scan_window_seconds', 'duplicate_scan_window_seconds'],
  ]);
  for (const row of rows) {
    const policyKey = map.get(row.setting_key);
    if (!policyKey) continue;
    const [existing] = await pool.execute(
      `SELECT id FROM attendance_policy_settings
        WHERE policy_key = ?
        LIMIT 1`,
      [policyKey]
    );
    if (existing.length) continue;
    const def = DEFAULT_ATTENDANCE_POLICIES.find((item) => item[2] === policyKey);
    await pool.execute(
      `INSERT INTO attendance_policy_settings
         (policy_name, policy_category, policy_key, policy_value, effective_date, is_active)
       VALUES (?, ?, ?, ?, CURDATE(), 1)`,
      [def[0], def[1], policyKey, cleanPolicyValue(row.setting_value)]
    );
  }
}

async function getActiveAttendancePolicy(pool, asOfDate = null) {
  await ensureAttendancePolicySettings(pool);
  const date = normalizeDate(asOfDate);
  const [rows] = await pool.execute(
    `SELECT *
       FROM attendance_policy_settings
      WHERE is_active = 1
        AND policy_key IS NOT NULL
        AND COALESCE(effective_date, CURDATE()) <= ?
      ORDER BY policy_key, effective_date DESC, id DESC`,
    [date]
  );

  const active = new Map(DEFAULT_ATTENDANCE_POLICIES.map(([policy_name, policy_category, policy_key, policy_value]) => [
    policy_key,
    { policy_name, policy_category, policy_key, policy_value, effective_date: date, is_active: 1 },
  ]));
  for (const row of rows) {
    if (!active.has(row.policy_key) || active.get(row.policy_key).id == null) {
      active.set(row.policy_key, row);
    }
  }

  const flat = {};
  for (const [key, row] of active.entries()) flat[key] = row.policy_value;

  const policy = {
    raw: Object.fromEntries(active),
    values: flat,
    work_schedule: `${flat.work_start_time || '08:00'}-${flat.work_end_time || '17:00'}`,
    work_start_time: flat.work_start_time || '08:00',
    work_end_time: flat.work_end_time || '17:00',
    break_start_time: flat.break_start_time || '12:00',
    break_end_time: flat.break_end_time || '13:00',
    standard_work_hours: toNumber(flat.standard_work_hours, 8),
    grace_period_minutes: Math.max(0, Math.floor(toNumber(flat.grace_period_minutes, 10))),
    enable_late_tracking: toBool(flat.enable_late_tracking, true),
    late_threshold_minutes: Math.max(0, Math.floor(toNumber(flat.late_threshold_minutes, 0))),
    count_late_for_payroll: toBool(flat.count_late_for_payroll, true),
    late_deduction_method: flat.late_deduction_method || 'auto_compute',
    late_fixed_deduction_amount: Math.max(0, toNumber(flat.late_fixed_deduction_amount, 0)),
    late_apply_grace_period: toBool(flat.late_apply_grace_period, true),
    late_require_hr_approval: toBool(flat.late_require_hr_approval, true),
    enable_undertime_tracking: toBool(flat.enable_undertime_tracking, true),
    count_undertime_for_payroll: toBool(flat.count_undertime_for_payroll, true),
    undertime_deduction_method: flat.undertime_deduction_method || 'auto_compute',
    undertime_fixed_deduction_amount: Math.max(0, toNumber(flat.undertime_fixed_deduction_amount, 0)),
    undertime_require_hr_approval: toBool(flat.undertime_require_hr_approval, true),
    enable_half_day_rule: toBool(flat.enable_half_day_rule, true),
    half_day_threshold_hours: toNumber(flat.half_day_threshold_hours, 4),
    enable_overtime: toBool(flat.enable_overtime, true),
    overtime_threshold_minutes: Math.max(0, Math.floor(toNumber(flat.overtime_threshold_minutes, 480))),
    overtime_threshold_hours: Math.max(0, toNumber(flat.overtime_threshold_minutes, 480) / 60),
    overtime_approval_required: toBool(flat.overtime_approval_required, true),
    minimum_overtime_minutes: Math.max(0, Math.floor(toNumber(flat.minimum_overtime_minutes, 30))),
    require_hr_validation: toBool(flat.require_hr_validation, true),
    hr_validation_required: toBool(flat.require_hr_validation, true),
    auto_payroll_ready: toBool(flat.auto_payroll_ready, false),
    validation_expiration_days: Math.max(0, Math.floor(toNumber(flat.validation_expiration_days, 3))),
    missing_timeout_handling: flat.missing_timeout_handling || 'Needs Review',
    duplicate_scan_window_seconds: Math.max(0, Math.floor(toNumber(flat.duplicate_scan_window_seconds, 60))),
    payroll_attendance_source: flat.payroll_attendance_source || 'payroll_ready',
    working_days_per_month: Math.max(1, Math.floor(toNumber(flat.working_days_per_month, 26))),
    payroll_ready_rules: flat.payroll_attendance_source === 'validated' ? 'Validated attendance only' : 'Payroll ready attendance only',
    enable_holiday_rules: toBool(flat.enable_holiday_rules, false),
    regular_holiday_multiplier: toNumber(flat.regular_holiday_multiplier, 2),
    special_holiday_multiplier: toNumber(flat.special_holiday_multiplier, 1.3),
    rest_day_multiplier: toNumber(flat.rest_day_multiplier, 1.3),
    holiday_overtime_multiplier: toNumber(flat.holiday_overtime_multiplier, 1.3),
    allow_manual_attendance: toBool(flat.allow_manual_attendance, true),
    allow_hr_correction: toBool(flat.allow_hr_correction, true),
    allow_manager_certification: toBool(flat.allow_manager_certification, false),
    device_failure_handling: flat.device_failure_handling || 'HR Correction Required',
  };
  return policy;
}

function minutesFromTime(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesBetween(start, end) {
  if (!start || !end) return 0;
  let diff = minutesFromTime(end) - minutesFromTime(start);
  if (diff < 0) diff += 24 * 60;
  return Math.max(0, diff);
}

function breakOverlapMinutes(timeIn, timeOut, policy) {
  if (!timeIn || !timeOut) return 0;
  const inMinutes = minutesFromTime(timeIn);
  const outMinutes = minutesFromTime(timeOut);
  const breakStart = minutesFromTime(policy.break_start_time);
  const breakEnd = minutesFromTime(policy.break_end_time);
  if (outMinutes <= inMinutes || breakEnd <= breakStart) return 0;
  return Math.max(0, Math.min(outMinutes, breakEnd) - Math.max(inMinutes, breakStart));
}

function getAttendanceStatusForTimeIn(timeIn, policy) {
  if (!policy.enable_late_tracking) return 'Present';
  const minutes = minutesFromTime(timeIn);
  const start = minutesFromTime(policy.work_start_time);
  const lateAfter = start + policy.grace_period_minutes + policy.late_threshold_minutes;
  return minutes > lateAfter ? 'Late' : 'Present';
}

function computeAttendanceMetrics(record, policy) {
  const timeIn = record?.time_in || record?.timeIn || null;
  const timeOut = record?.time_out || record?.timeOut || null;
  const gracePeriodMinutes = Math.max(0, Math.round(Number(policy.grace_period_minutes ?? 10) || 0));
  const lateThresholdMinutes = Math.max(0, Math.round(Number(policy.late_threshold_minutes ?? 0) || 0));
  const halfDayThresholdHours = Math.max(0, Number(policy.half_day_threshold_hours ?? 4) || 0);
  const grossMinutes = timeIn && timeOut ? minutesBetween(timeIn, timeOut) : 0;
  const netWorkedMinutes = Math.max(0, grossMinutes - breakOverlapMinutes(timeIn, timeOut, policy));
  const standardMinutes = Math.round(Number(policy.standard_work_hours || 8) * 60);
  const scheduledStart = minutesFromTime(policy.work_start_time);
  const scheduledEnd = minutesFromTime(policy.work_end_time);
  const actualIn = minutesFromTime(timeIn);
  const actualOut = minutesFromTime(timeOut);

  const lateAfter = scheduledStart + gracePeriodMinutes + lateThresholdMinutes;
  const lateMinutes = timeIn && policy.enable_late_tracking
    ? Math.max(0, actualIn - lateAfter)
    : 0;

  const undertimeMinutes = timeOut && policy.enable_undertime_tracking
    ? Math.max(0, scheduledEnd - actualOut)
    : 0;

  const scheduledOvertimeMinutes = timeOut && policy.enable_overtime
    ? Math.max(0, actualOut - scheduledEnd)
    : 0;
  const manualOvertimeMinutes = policy.enable_overtime
    ? Math.max(0, Math.round(Number(record?.overtime_hours || 0) * 60))
    : 0;
  const overtimeMinutes = Math.max(manualOvertimeMinutes, scheduledOvertimeMinutes);
  const regularMinutes = policy.enable_overtime
    ? Math.min(netWorkedMinutes, Number(policy.overtime_threshold_minutes || standardMinutes) || standardMinutes)
    : netWorkedMinutes;

  let attendanceStatus = record?.status || 'Present';
  if (!timeIn && timeOut) attendanceStatus = 'Incomplete';
  else if (timeIn && !timeOut && policy.missing_timeout_handling !== 'Auto Close') attendanceStatus = 'Needs Review';
  else if (timeIn && timeOut) {
    attendanceStatus = lateMinutes > 0 ? 'Late' : 'Present';
    if (policy.enable_half_day_rule && regularMinutes > 0 && regularMinutes < Math.round(halfDayThresholdHours * 60)) {
      attendanceStatus = 'Half Day';
    }
  }

  const flags = [];
  if (attendanceStatus === 'Present' || attendanceStatus === 'Half Day') flags.push(attendanceStatus);
  if (lateMinutes > 0) flags.push('Late');
  if (undertimeMinutes > 0) flags.push('Undertime');
  if (overtimeMinutes > 0) flags.push('Overtime');
  if (!flags.length) flags.push(attendanceStatus);

  return {
    grossMinutes,
    netWorkedMinutes,
    regularMinutes,
    overtimeMinutes,
    lateMinutes,
    undertimeMinutes,
    attendanceStatus,
    flags,
  };
}

function getInitialVerificationStatus(scanType, policy, options = {}) {
  if (options.missingTimeIn) return 'NEEDS_REVIEW';
  if (policy.auto_payroll_ready && !policy.require_hr_validation) return 'PAYROLL_READY';
  return 'PENDING_VALIDATION';
}

async function saveAttendancePolicyValues(pool, body, userId) {
  await ensureAttendancePolicySettings(pool);
  const effectiveDate = normalizeDate(body.effective_date);
  const changes = [];
  const keys = Object.keys(body).filter((key) => POLICY_KEYS.has(key));
  const current = await getActiveAttendancePolicy(pool, effectiveDate);

  for (const key of keys) {
    const value = cleanPolicyValue(body[key]);
    const def = DEFAULT_ATTENDANCE_POLICIES.find((item) => item[2] === key);
    const oldValue = current.values[key] ?? null;
    await pool.execute(
      `UPDATE attendance_policy_settings
          SET is_active = 0, updated_by = ?
        WHERE policy_key = ?
          AND effective_date = ?`,
      [userId || null, key, effectiveDate]
    );
    await pool.execute(
      `INSERT INTO attendance_policy_settings
         (policy_name, policy_category, policy_key, policy_value, effective_date, is_active, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [def[0], def[1], key, value, effectiveDate, userId || null, userId || null]
    );
    if (String(oldValue) !== String(value)) changes.push({ key, old_value: oldValue, new_value: value, effective_date: effectiveDate });
  }

  return { changes, policy: await getActiveAttendancePolicy(pool, effectiveDate) };
}

module.exports = {
  DEFAULT_ATTENDANCE_POLICIES,
  ensureAttendancePolicySettings,
  getActiveAttendancePolicy,
  getAttendanceStatusForTimeIn,
  computeAttendanceMetrics,
  getInitialVerificationStatus,
  saveAttendancePolicyValues,
};
