'use strict';

const { createProbeResult, ProbeFailure } = require('../probeResult');
const { loadModule } = require('../endpointProbe');
const { readOne, tableExists } = require('./helpers');

async function probeEmployee({ pool } = {}) {
  loadModule('server/201-file-management', 'Employee / 201-file controller');
  const employees = await tableExists(pool, 'employees');
  if (!employees) throw new ProbeFailure('EMPLOYEE_DIRECTORY_UNAVAILABLE', 'Employee directory is unavailable.');
  const rows = await readOne(pool, 'employees');
  if (!Array.isArray(rows)) throw new ProbeFailure('EMPLOYEE_RESPONSE_INVALID', 'Employee read-only probe returned an invalid result.');
  const fileAudit = await tableExists(pool, 'employee_201_file_access_audit');
  if (fileAudit) await readOne(pool, 'employee_201_file_access_audit');
  return createProbeResult({
    status: fileAudit ? 'ONLINE' : 'WARNING',
    remarks: fileAudit
      ? 'Employee/201-file controller loaded and a minimal non-sensitive directory read succeeded.'
      : 'Employee directory read succeeded, but the 201-file access-audit dependency is unavailable.',
    probeType: 'SERVICE',
    probeTarget: 'employee/201-file controller + limited employee query',
    checks: {
      controller_loaded: { passed: true, message: 'Employee / 201-file controller loaded.' },
      limited_directory_read: { passed: true, message: 'Limited read-only employee query returned a valid result shape.' },
      pii_not_selected: { passed: true, message: 'Probe selected no employee PII or compensation fields.' },
      file_access_audit_readable: { passed: fileAudit, message: fileAudit ? '201-file access audit is readable.' : '201-file access audit table is unavailable.' },
    },
    dependencies: {
      employee_directory: { label: 'Employee directory', available: true },
      file_access_audit: { label: '201-file access audit', available: fileAudit },
    },
    validationPassed: true,
  });
}

module.exports = { probeEmployee };
