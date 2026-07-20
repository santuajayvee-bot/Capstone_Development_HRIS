'use strict';

const { createProbeResult, ProbeFailure } = require('../probeResult');
const { loadModule, requireFunction } = require('../endpointProbe');
const { ageMinutes, existingColumns, isTruthyEnv, readOne, tableExists } = require('./helpers');
const { boundedInteger } = require('../probeRunner');

async function probeAttendanceSync({ pool } = {}) {
  const attendanceService = loadModule('server/attendance-service', 'Biometric attendance service');
  requireFunction(attendanceService.sha256, 'Biometric attendance helper');
  const deviceTable = await tableExists(pool, 'biometric_device');
  const mappingTable = await tableExists(pool, 'biometric_employee_mapping');
  const syncTable = await tableExists(pool, 'biometric_sync_log');
  const required = isTruthyEnv(process.env.SYSTEM_HEALTH_BIOMETRIC_REQUIRED);
  if (!deviceTable) {
    return createProbeResult({
      status: required ? 'OFFLINE' : 'WARNING',
      remarks: required ? 'Biometric attendance is required but device configuration is unavailable.' : 'Biometric attendance is not configured in this environment.',
      probeType: 'EXTERNAL_DEPENDENCY',
      probeTarget: 'attendance-service biometric bridge status',
      checks: {
        service_loaded: { passed: true, message: 'Biometric attendance service loaded.' },
        device_configuration: { passed: false, message: 'Biometric device configuration table is unavailable.' },
      },
      dependencies: { biometric_required: { label: 'Biometric requirement', available: !required, status: required ? 'Required' : 'Optional / not configured' } },
      validationPassed: !required,
      failureCode: required ? 'BIOMETRIC_DEVICE_CONFIG_UNAVAILABLE' : null,
    });
  }
  const deviceColumns = await existingColumns(pool, 'biometric_device', ['is_active', 'last_success_at', 'last_error_at']);
  const activeFilter = deviceColumns.has('is_active') ? 'WHERE is_active=1' : '';
  const [deviceRows] = await pool.execute(
    `SELECT COUNT(*) AS configured_devices${deviceColumns.has('last_success_at') ? ', MAX(last_success_at) AS latest_success' : ''}${deviceColumns.has('last_error_at') ? ', MAX(last_error_at) AS latest_error' : ''} FROM biometric_device ${activeFilter}`
  );
  const devices = deviceRows[0] || {};
  const active = Number(devices.configured_devices || 0);
  const maxAge = boundedInteger(process.env.SYSTEM_HEALTH_BIOMETRIC_MAX_SYNC_AGE_MINUTES, 30, 5, 10080);
  const failureWindow = boundedInteger(process.env.SYSTEM_HEALTH_BIOMETRIC_FAILURE_WINDOW_MINUTES, 60, 5, 10080);
  const maxFailures = boundedInteger(process.env.SYSTEM_HEALTH_BIOMETRIC_MAX_CONSECUTIVE_FAILURES, 3, 1, 100);
  const successAge = ageMinutes(devices.latest_success);
  let recentFailures = 0;
  if (syncTable) {
    const syncColumns = await existingColumns(pool, 'biometric_sync_log', ['status', 'created_at', 'updated_at']);
    if (syncColumns.has('status')) {
      const timestampColumn = syncColumns.has('updated_at') ? 'updated_at' : syncColumns.has('created_at') ? 'created_at' : null;
      const where = timestampColumn ? `AND ${timestampColumn} >= DATE_SUB(NOW(), INTERVAL ${failureWindow} MINUTE)` : '';
      const [rows] = await pool.execute(`SELECT COUNT(*) AS failures FROM biometric_sync_log WHERE status IN ('FAILED','ERROR') ${where}`);
      recentFailures = Number(rows[0]?.failures || 0);
    }
  }
  if (mappingTable) await readOne(pool, 'biometric_employee_mapping');
  const stale = active > 0 && (successAge === null || successAge > maxAge);
  const unresolved = recentFailures >= maxFailures && (!devices.latest_success || new Date(devices.latest_error || 0).getTime() >= new Date(devices.latest_success || 0).getTime());
  const configFailure = required && active === 0;
  const status = configFailure ? 'OFFLINE' : stale || unresolved || !mappingTable ? 'WARNING' : 'ONLINE';
  return createProbeResult({
    status,
    remarks: configFailure ? 'Biometric attendance is required but no active device is configured.' : stale ? 'Biometric service is loaded, but the latest successful sync is stale.' : unresolved ? 'Recent unresolved biometric sync failures need review.' : !mappingTable ? 'Biometric service is loaded, but employee-device mapping is unavailable.' : 'Biometric service, device status, and employee-device mapping probes succeeded.',
    probeType: 'EXTERNAL_DEPENDENCY',
    probeTarget: 'attendance-service + biometric device/sync status',
    checks: {
      service_loaded: { passed: true, message: 'Biometric attendance service loaded and helper is callable.' },
      active_device: { passed: !required || active > 0, message: active > 0 ? 'At least one active biometric device is configured.' : required ? 'No active biometric device is configured.' : 'Biometric devices are optional in this environment.' },
      heartbeat_fresh: { passed: !stale, message: stale ? 'Latest successful biometric sync exceeds the configured age.' : 'Biometric sync freshness is within the configured limit or no device is required.' },
      unresolved_failures: { passed: !unresolved, message: unresolved ? 'Recent biometric failures exceed the configured threshold without a newer success.' : 'No unresolved recent biometric failure pattern was detected.' },
      employee_mapping_readable: { passed: mappingTable, message: mappingTable ? 'Employee-device mapping is readable.' : 'Employee-device mapping is unavailable.' },
    },
    dependencies: {
      biometric_devices: { label: 'Active biometric devices', count: active, status: required ? 'Required' : 'Optional' },
      latest_success: { label: 'Latest successful sync', value: devices.latest_success || null, age_minutes: successAge },
      recent_failures: { label: 'Recent unresolved sync failures', count: recentFailures, window_minutes: failureWindow },
      employee_mapping: { label: 'Employee-device mapping', available: mappingTable },
    },
    validationPassed: status !== 'OFFLINE',
    failureCode: configFailure ? 'BIOMETRIC_DEVICE_REQUIRED' : null,
  });
}

module.exports = { probeAttendanceSync };
