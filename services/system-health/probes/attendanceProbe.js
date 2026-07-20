'use strict';

const { createProbeResult, ProbeFailure } = require('../probeResult');
const { loadModule, requireFunction } = require('../endpointProbe');
const { ageMinutes, existingColumns, identifier, readOne, tableExists } = require('./helpers');
const { boundedInteger } = require('../probeRunner');

async function probeAttendance({ pool } = {}) {
  loadModule('server/attendance', 'Attendance controller');
  const policy = loadModule('server/attendance-policy-engine', 'Attendance policy engine');
  requireFunction(policy.getInitialVerificationStatus, 'Attendance validation-status logic');
  const tableAvailable = await tableExists(pool, 'attendance_log');
  if (!tableAvailable) throw new ProbeFailure('ATTENDANCE_LOG_UNAVAILABLE', 'Attendance log is unavailable.');
  const columns = await existingColumns(pool, 'attendance_log', ['updated_at', 'last_scan_at', 'created_at', 'date', 'verification_status']);
  const freshnessColumn = ['updated_at', 'last_scan_at', 'created_at', 'date'].find(column => columns.has(column));
  const pendingColumn = columns.has('verification_status') ? 'verification_status' : null;
  const [summaryRows] = await pool.execute(
    `SELECT COUNT(*) AS total_records${freshnessColumn ? `, MAX(${identifier(freshnessColumn)}) AS latest_record` : ''}${pendingColumn ? `, SUM(CASE WHEN ${identifier(pendingColumn)} IN ('PENDING_VALIDATION','INCOMPLETE','NEEDS_REVIEW') THEN 1 ELSE 0 END) AS pending_records` : ''} FROM attendance_log`
  );
  const summary = summaryRows[0] || {};
  const total = Number(summary.total_records || 0);
  const staleMinutes = ageMinutes(summary.latest_record);
  const maxStale = boundedInteger(process.env.SYSTEM_HEALTH_ATTENDANCE_MAX_STALE_MINUTES, 60, 5, 10080);
  const technicalStale = total > 0 && staleMinutes !== null && staleMinutes > maxStale;
  const validationSlaHours = boundedInteger(process.env.SYSTEM_HEALTH_ATTENDANCE_VALIDATION_SLA_HOURS, 24, 1, 720);
  let stuckPending = 0;
  if (pendingColumn && freshnessColumn) {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS stuck_records FROM attendance_log WHERE ${identifier(pendingColumn)} IN ('PENDING_VALIDATION','INCOMPLETE','NEEDS_REVIEW') AND ${identifier(freshnessColumn)} < DATE_SUB(NOW(), INTERVAL ${validationSlaHours} HOUR)`
    );
    stuckPending = Number(rows[0]?.stuck_records || 0);
  }
  const adjustmentAudit = await tableExists(pool, 'attendance_adjustment');
  if (adjustmentAudit) await readOne(pool, 'attendance_adjustment');
  return createProbeResult({
    status: technicalStale || stuckPending > 0 || !adjustmentAudit ? 'WARNING' : 'ONLINE',
    remarks: technicalStale
      ? 'Attendance service read succeeded, but attendance data is beyond the configured freshness window.'
      : stuckPending > 0
        ? 'Attendance service read succeeded, but pending validation records exceed the configured SLA.'
        : !adjustmentAudit
        ? 'Attendance service read succeeded, but the manual-adjustment audit dependency is unavailable.'
        : 'Attendance controller, validation logic, and read-only summary probe succeeded.',
    probeType: 'SERVICE',
    probeTarget: 'attendance controller + attendance-policy-engine + attendance summary query',
    checks: {
      controller_loaded: { passed: true, message: 'Attendance controller loaded.' },
      validation_logic_loaded: { passed: true, message: 'Attendance validation-status logic is callable.' },
      summary_schema_valid: { passed: Number.isFinite(total), message: 'Read-only attendance summary returned expected aggregate fields.' },
      data_freshness: { passed: !technicalStale, message: technicalStale ? 'Latest attendance record exceeds the configured freshness window.' : 'Attendance freshness is within the configured window or no records exist yet.' },
      validation_sla: { passed: stuckPending === 0, message: stuckPending > 0 ? 'Pending attendance validation records exceed the configured SLA.' : 'No pending attendance validation record exceeds the configured SLA.' },
      adjustment_audit_readable: { passed: adjustmentAudit, message: adjustmentAudit ? 'Attendance adjustment audit is readable.' : 'Attendance adjustment audit is unavailable.' },
    },
    dependencies: {
      attendance_log: { label: 'Attendance log', available: true, count: total },
      pending_validation: { label: 'Pending validation (operational metric)', count: Number(summary.pending_records || 0), status: 'Does not affect technical health unless SLA rules are breached' },
      validation_sla_breaches: { label: 'Validation SLA breaches', count: stuckPending, max_age_hours: validationSlaHours },
      latest_record: { label: 'Latest attendance record', value: summary.latest_record || null, age_minutes: staleMinutes },
      adjustment_audit: { label: 'Manual correction audit', available: adjustmentAudit },
    },
    validationPassed: true,
  });
}

module.exports = { probeAttendance };
