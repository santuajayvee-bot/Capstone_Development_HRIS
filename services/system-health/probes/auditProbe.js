'use strict';

const { createProbeResult, ProbeFailure } = require('../probeResult');
const { loadModule } = require('../endpointProbe');
const { existingColumns, identifier, tableExists } = require('./helpers');

async function probeAudit({ pool } = {}) {
  loadModule('server/security-controls', 'Audit writer service');
  const available = await tableExists(pool, 'system_audit_log');
  if (!available) throw new ProbeFailure('AUDIT_TABLE_UNAVAILABLE', 'System audit log is unavailable.');
  const columns = await existingColumns(pool, 'system_audit_log', ['timestamp', 'created_at', 'Created_At', 'action_performed', 'module']);
  const timestamp = ['timestamp', 'created_at', 'Created_At'].find(column => columns.has(column));
  const [rows] = await pool.execute(`SELECT COUNT(*) AS records${timestamp ? `, MAX(${identifier(timestamp)}) AS latest_at` : ''} FROM system_audit_log`);
  const summary = rows[0] || {};
  const expectedColumns = columns.has('action_performed') && columns.has('module') && Boolean(timestamp);
  if (!expectedColumns) throw new ProbeFailure('AUDIT_SCHEMA_INCOMPLETE', 'Audit log schema is incomplete.');
  const count = Number(summary.records || 0);
  return createProbeResult({
    status: 'ONLINE',
    remarks: count > 0
      ? 'Audit writer loaded and audit log read/schema probe succeeded.'
      : 'Audit writer loaded and audit log schema is readable; no recent audit event is claimed because no records exist.',
    probeType: 'SERVICE',
    probeTarget: 'security-controls audit writer + system_audit_log read',
    checks: {
      audit_writer_loaded: { passed: true, message: 'Audit writer service loaded.' },
      audit_table_readable: { passed: true, message: 'Audit log aggregate read succeeded.' },
      expected_columns_present: { passed: true, message: 'Expected audit action, module, and timestamp columns are present.' },
      recent_activity_observed: { passed: count > 0, message: count > 0 ? 'Audit records are present.' : 'No audit record exists; no write canary was performed.' },
    },
    dependencies: {
      system_audit_log: { label: 'System audit log', available: true, count },
      latest_event: { label: 'Latest audit event', value: summary.latest_at || null },
      write_canary: { label: 'Audit write canary', available: false, status: 'Not run; diagnostics remain read-only' },
    },
    validationPassed: true,
  });
}

module.exports = { probeAudit };
