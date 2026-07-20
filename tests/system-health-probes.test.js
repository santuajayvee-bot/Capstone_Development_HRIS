'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'system-health-test-secret-with-sufficient-length-1234567890';
process.env.AES_ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.MFA_ENABLED = 'false';

const assert = require('assert');
const crypto = require('crypto');
const { ProbeRunner } = require('../services/system-health/probeRunner');
const { probeDatabase } = require('../services/system-health/databaseProbe');
const { probeAuthentication } = require('../services/system-health/probes/authenticationProbe');
const { probeAttendance } = require('../services/system-health/probes/attendanceProbe');
const { probeAttendanceSync } = require('../services/system-health/probes/attendanceSyncProbe');
const { probePayroll } = require('../services/system-health/probes/payrollProbe');
const { probePayslip } = require('../services/system-health/probes/payslipProbe');
const { probeBlockchain } = require('../services/system-health/probes/blockchainProbe');
const { probeBackup } = require('../services/system-health/probes/backupProbe');
const { probeFileStorage } = require('../services/system-health/probes/fileStorageProbe');

const tests = [];
function test(name, callback) { tests.push({ name, callback }); }

function infoTablePool({ tables = {}, columns = {}, handlers = {} } = {}) {
  return {
    pool: { _allConnections: [1], _freeConnections: [1], _connectionQueue: [], config: { connectionLimit: 10 } },
    async getConnection() {
      return {
        released: false,
        async execute(sql, params) {
          if (/SELECT 1 AS ok/.test(sql)) return [[{ ok: 1 }]];
          return this.parent.execute(sql, params);
        },
        release() { this.released = true; },
        parent: null,
      };
    },
    async execute(sql, params = []) {
      if (/INFORMATION_SCHEMA\.TABLES/.test(sql)) return [[{ count: tables[String(params[0])] ? 1 : 0 }]];
      if (/INFORMATION_SCHEMA\.COLUMNS/.test(sql)) {
        const set = new Set(columns[String(params[0])] || []);
        return [params.slice(1).filter(column => set.has(column)).map(COLUMN_NAME => ({ COLUMN_NAME }))];
      }
      for (const [matcher, result] of Object.entries(handlers)) {
        if (sql.includes(matcher)) return typeof result === 'function' ? result(sql, params) : result;
      }
      if (/^SELECT 1 AS readable FROM/.test(sql.trim())) return [[{ readable: 1 }]];
      throw new Error(`Unexpected read-only query: ${sql}`);
    },
  };
}

test('probe runner reuses an in-flight module probe instead of executing duplicates', async () => {
  const runner = new ProbeRunner({ timeoutMs: 1000, cacheMs: 0, logger: { error() {} } });
  let runs = 0;
  const work = async () => {
    runs += 1;
    await new Promise(resolve => setTimeout(resolve, 20));
    return { status: 'ONLINE', probeType: 'SERVICE', probeTarget: 'test.service', checks: { loaded: { passed: true, message: 'Loaded.' } } };
  };
  const [first, second] = await Promise.all([runner.run('duplicate', work), runner.run('duplicate', work)]);
  assert.strictEqual(runs, 1);
  assert.strictEqual(first.status, 'ONLINE');
  assert.strictEqual(second.status, 'ONLINE');
});

test('probe runner returns a safe warning when a probe times out', async () => {
  const runner = new ProbeRunner({ timeoutMs: 20, cacheMs: 0, logger: { error() {} } });
  const result = await runner.run('timeout', () => new Promise(resolve => setTimeout(resolve, 80)), { probeType: 'SERVICE', probeTarget: 'slow.test' });
  assert.strictEqual(result.status, 'WARNING');
  assert.strictEqual(result.failure_code, 'SYSTEM_HEALTH_PROBE_TIMEOUT');
  assert(!JSON.stringify(result).includes('password='));
});

test('database probe acquires, queries, and releases a connection', async () => {
  let released = false;
  const pool = {
    pool: { _allConnections: [1], _freeConnections: [], _connectionQueue: [], config: { connectionLimit: 10 } },
    async getConnection() {
      return { async execute() { return [[{ ok: 1 }]]; }, release() { released = true; } };
    },
  };
  const result = await probeDatabase({ pool, slowWarningMs: 1000 });
  assert.strictEqual(result.status, 'ONLINE');
  assert.strictEqual(result.checks.select_one.passed, true);
  assert.strictEqual(released, true);
});

test('a reachable table does not hide a failing service method', async () => {
  const runner = new ProbeRunner({ cacheMs: 0, logger: { error() {} } });
  const result = await runner.run('service-throws-with-table', async () => {
    const pool = infoTablePool({ tables: { attendance_log: true } });
    await pool.execute('SELECT 1 AS readable FROM attendance_log LIMIT 1');
    throw new Error('controller failed after its table check');
  }, { probeType: 'SERVICE', probeTarget: 'attendanceService.getHealthSummary' });
  assert.strictEqual(result.status, 'OFFLINE');
  assert.strictEqual(result.failure_code, 'SYSTEM_HEALTH_PROBE_FAILED');
  assert.strictEqual(result.validation_passed, false);
});

test('an invalid database response is not reported as healthy', async () => {
  const runner = new ProbeRunner({ cacheMs: 0, logger: { error() {} } });
  const result = await runner.run('database-invalid-response', () => probeDatabase({
    pool: {
      async getConnection() { return { async execute() { return [[{ ok: 0 }]]; }, release() {} }; },
    },
  }), { probeType: 'DATABASE', probeTarget: 'mysql2 pool.getConnection + SELECT 1' });
  assert.strictEqual(result.status, 'OFFLINE');
  assert.strictEqual(result.failure_code, 'DATABASE_INVALID_RESPONSE');
});

test('a slow but successful database query returns a warning', async () => {
  const result = await probeDatabase({
    slowWarningMs: 100,
    pool: {
      async getConnection() {
        return {
          async execute() { await new Promise(resolve => setTimeout(resolve, 120)); return [[{ ok: 1 }]]; },
          release() {},
        };
      },
    },
  });
  assert.strictEqual(result.status, 'WARNING');
  assert.strictEqual(result.checks.latency_within_threshold.passed, false);
});

test('authentication probe runs only in-memory canaries and no login write', async () => {
  let writes = 0;
  const pool = infoTablePool({ tables: { USER_SESSION: true, system_audit_log: true } });
  const original = pool.execute.bind(pool);
  pool.execute = async (sql, params) => {
    if (/\b(INSERT|UPDATE|DELETE)\b/i.test(sql)) writes += 1;
    return original(sql, params);
  };
  const result = await probeAuthentication({ pool });
  assert.strictEqual(result.status, 'ONLINE');
  assert.strictEqual(result.checks.password_hash_and_verify.passed, true);
  assert.strictEqual(result.checks.jwt_sign_and_verify.passed, true);
  assert.strictEqual(writes, 0);
  const text = JSON.stringify(result);
  assert(!text.includes(process.env.JWT_SECRET), 'Probe result must not expose the JWT secret.');
  assert(!text.includes('system-health-canary'), 'Probe result must not expose the token canary payload.');
  assert(!text.includes('$argon2'), 'Probe result must not expose the in-memory password hash.');
});

function attendancePool(latestRecord) {
  return infoTablePool({
    tables: { attendance_log: true, attendance_adjustment: true },
    columns: { attendance_log: ['updated_at', 'verification_status'] },
    handlers: {
      'FROM attendance_log': [[{ total_records: 2, latest_record: latestRecord, pending_records: 1 }]],
    },
  });
}

test('attendance pending records within the freshness SLA stay technically online', async () => {
  const result = await probeAttendance({ pool: attendancePool(new Date()) });
  assert.strictEqual(result.status, 'ONLINE');
  assert.strictEqual(result.dependencies.pending_validation.count, 1);
});

test('stale attendance data produces a warning without changing records', async () => {
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const result = await probeAttendance({ pool: attendancePool(stale) });
  assert.strictEqual(result.status, 'WARNING');
  assert.strictEqual(result.checks.data_freshness.passed, false);
});

function biometricPool({ latestSuccess, latestError, failures }) {
  return infoTablePool({
    tables: { biometric_device: true, biometric_employee_mapping: true, biometric_sync_log: true },
    columns: {
      biometric_device: ['is_active', 'last_success_at', 'last_error_at'],
      biometric_sync_log: ['status', 'updated_at'],
    },
    handlers: {
      'FROM biometric_device': [[{ configured_devices: 1, latest_success: latestSuccess, latest_error: latestError }]],
      'FROM biometric_sync_log': [[{ failures }]],
    },
  });
}

test('a resolved historical biometric failure does not remain a permanent warning', async () => {
  const result = await probeAttendanceSync({ pool: biometricPool({ latestSuccess: new Date(), latestError: new Date(Date.now() - 60 * 60 * 1000), failures: 9 }) });
  assert.strictEqual(result.status, 'ONLINE');
  assert.strictEqual(result.checks.unresolved_failures.passed, true);
});

test('recent unresolved biometric failures produce a warning', async () => {
  const result = await probeAttendanceSync({ pool: biometricPool({ latestSuccess: new Date(Date.now() - 60 * 60 * 1000), latestError: new Date(), failures: 3 }) });
  assert.strictEqual(result.status, 'WARNING');
  assert.strictEqual(result.checks.unresolved_failures.passed, false);
});

test('payroll probe performs the deterministic in-memory calculation without persistence', async () => {
  const pool = infoTablePool({ tables: { payroll_policy_settings: true, payroll_deduction_settings: true } });
  const result = await probePayroll({ pool });
  assert.strictEqual(result.status, 'ONLINE');
  assert.strictEqual(result.checks.in_memory_calculation.passed, true);
  assert.strictEqual(result.checks.persistence_not_used.passed, true);
});

test('payslip probe validates an in-memory encryption round trip without an insert', async () => {
  const result = await probePayslip({ pool: infoTablePool({ tables: { payslips: true } }) });
  assert.strictEqual(result.status, 'ONLINE');
  assert.strictEqual(result.checks.encryption_round_trip.passed, true);
});

test('configured-but-disabled Fabric returns a truthful warning', async () => {
  const result = await probeBlockchain({ fabricService: { getFabricConfigStatus: () => ({ enabled: false, ready: false }) } });
  assert.strictEqual(result.status, 'WARNING');
  assert.strictEqual(result.failure_code, 'FABRIC_DISABLED');
});

test('Fabric read-only evaluation succeeds without a ledger write', async () => {
  let evaluated = 0;
  const result = await probeBlockchain({ fabricService: {
    getFabricConfigStatus: () => ({ enabled: true, ready: true }),
    async evaluateHealthCheck() { evaluated += 1; return { available: true }; },
  } });
  assert.strictEqual(result.status, 'ONLINE');
  assert.strictEqual(evaluated, 1);
});

function verifiedBackupPool(verifiedAt) {
  return infoTablePool({
    tables: { backup_sets: true, backup_restore_drill_runs: false },
    handlers: {
      'FROM backup_sets': [[{
        id: 1, backup_reference: 'BKP-TEST', backup_type: 'FULL_BACKUP', storage_provider: 'LOCAL',
        storage_location_encrypted: 'encrypted-location', checksum: 'a'.repeat(64), status: 'VERIFIED',
        verification_status: 'MATCH', integrity_status: 'PASSED', verified_at: verifiedAt,
      }]],
    },
  });
}

test('backup beyond its configured RPO is a warning even when its record is verified', async () => {
  const result = await probeBackup({
    pool: verifiedBackupPool(new Date(Date.now() - 26 * 60 * 60 * 1000)),
    decryptText: () => 'local-backup:///health-test',
    runtimeFactory: () => ({ async verifyBackup() { return { valid: true }; } }),
  });
  assert.strictEqual(result.status, 'WARNING');
  assert.strictEqual(result.checks.rpo_freshness.passed, false);
});

test('a missing verified backup artifact is not reported as online', async () => {
  const runner = new ProbeRunner({ cacheMs: 0, logger: { error() {} } });
  const result = await runner.run('backup-missing-artifact', () => probeBackup({
    pool: verifiedBackupPool(new Date()),
    decryptText: () => 'local-backup:///missing-artifact',
    runtimeFactory: () => ({ async verifyBackup() { return { valid: false }; } }),
  }), { probeType: 'INTEGRITY', probeTarget: 'backup runtime.verifyBackup' });
  assert.strictEqual(result.status, 'OFFLINE');
  assert.strictEqual(result.failure_code, 'BACKUP_ARTIFACT_UNAVAILABLE');
});

test('file-storage canary writes, verifies, and removes only its dedicated temporary object', async () => {
  const items = new Map();
  const vault = {
    async storeEncryptedBuffer(scope, value) { assert.strictEqual(scope, 'system-health'); items.set('canary', Buffer.from(value)); return 'system-health/canary.enc'; },
    async readEncryptedBuffer() { return items.get('canary'); },
    async deleteEncryptedFile() { items.delete('canary'); },
  };
  const result = await probeFileStorage({ vault });
  assert.strictEqual(result.status, 'ONLINE');
  assert.strictEqual(items.size, 0);
});

test('sanitized probe failures do not return supplied secret-like text', async () => {
  const runner = new ProbeRunner({ cacheMs: 0, logger: { error() {} } });
  const result = await runner.run('safe-failure', () => {
    throw new Error('password=not-safe-to-return');
  }, { probeType: 'SERVICE', probeTarget: 'safe.service' });
  assert(!JSON.stringify(result).includes('not-safe-to-return'));
});

(async () => {
  for (const item of tests) {
    await item.callback();
    console.log(`PASS ${item.name}`);
  }
  console.log('System Health behavior probes: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
