'use strict';

const { probeDatabase } = require('./databaseProbe');
const { systemHealthProbeRunner } = require('./probeRunner');
const { probeAuthentication } = require('./probes/authenticationProbe');
const { probeAttendance } = require('./probes/attendanceProbe');
const { probeAttendanceSync } = require('./probes/attendanceSyncProbe');
const { probeEmployee } = require('./probes/employeeProbe');
const { probePayroll } = require('./probes/payrollProbe');
const { probePayslip } = require('./probes/payslipProbe');
const { probeBlockchain } = require('./probes/blockchainProbe');
const { probeBackup } = require('./probes/backupProbe');
const { probeAudit } = require('./probes/auditProbe');
const { probeFileStorage } = require('./probes/fileStorageProbe');

function run(moduleKey, work, options) {
  return systemHealthProbeRunner.run(moduleKey, work, options);
}

module.exports = {
  database: options => run('database', () => probeDatabase(options), { probeType: 'DATABASE', probeTarget: 'mysql2 pool.getConnection + SELECT 1' }),
  authentication: options => run('authentication', () => probeAuthentication(options), { probeType: 'SERVICE', probeTarget: 'auth controller + passwordService + tokenService' }),
  employee: options => run('employee_201', () => probeEmployee(options), { probeType: 'SERVICE', probeTarget: 'employee/201-file controller + limited employee query' }),
  attendance: options => run('attendance', () => probeAttendance(options), { probeType: 'SERVICE', probeTarget: 'attendance controller + attendance-policy-engine + attendance summary query' }),
  attendanceSync: options => run('attendance_sync', () => probeAttendanceSync(options), { probeType: 'EXTERNAL_DEPENDENCY', probeTarget: 'attendance-service + biometric device/sync status' }),
  payroll: options => run('payroll', () => probePayroll(options), { probeType: 'SERVICE', probeTarget: 'payroll controller._systemHealth.calculateCanary' }),
  payslip: options => run('payslip', () => probePayslip(options), { probeType: 'INTEGRITY', probeTarget: 'payslip controller + data-protection AES-256-GCM round trip' }),
  blockchain: options => run('blockchain', () => probeBlockchain(options), { probeType: 'EXTERNAL_DEPENDENCY', probeTarget: 'fabricService.evaluateHealthCheck' }),
  backup: options => run('backup_restore', () => probeBackup(options), { probeType: 'INTEGRITY', probeTarget: 'backup runtime.verifyBackup + restore-drill freshness', cacheMs: 15000 }),
  audit: options => run('audit_trail', () => probeAudit(options), { probeType: 'SERVICE', probeTarget: 'security-controls audit writer + system_audit_log read' }),
  fileStorage: options => run('file_storage', () => probeFileStorage(options), { probeType: 'INTEGRITY', probeTarget: 'encrypted-file-vault system-health temporary scope' }),
  runner: systemHealthProbeRunner,
};
