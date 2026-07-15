'use strict';

process.env.NODE_ENV = 'test';
process.env.DB_USER ||= 'test';
process.env.DB_PASSWORD ||= 'test-only';
process.env.DB_NAME ||= 'test';

const assert = require('assert');
const pool = require('../config/db');
const router = require('../server/backup-recovery');
const {
  BackupStepUpError,
  consumeBackupStepUpChallenge,
  _hashTokenForTest,
  _tokenMatchesForTest,
} = require('../services/backupStepUpService');

const {
  BACKUP_TRANSITIONS,
  RESTORE_TRANSITIONS,
  ROLLBACK_TRANSITIONS,
  adminApprovalPolicyFromCount,
  acquireConnectionWithTimeout,
  backupArtifactAvailable,
  backupArtifactVerified,
  backupDatabaseAcquireTimeoutMs,
  backupResponse,
  assertIdempotentReplay,
  assertTransition,
  loadAdminApprovalPolicy,
  requestFingerprint,
  recoverExpiredOperations,
  restoreResponse,
  rollbackResponse,
  workerLease,
} = router._test;

function expectCode(callback, code) {
  assert.throws(callback, error => error?.code === code, `Expected ${code}.`);
}

async function expectRejectedCode(promise, code) {
  await assert.rejects(promise, error => error?.code === code, `Expected ${code}.`);
}

async function run() {
  assert.doesNotThrow(() => assertTransition(BACKUP_TRANSITIONS, 'PENDING', 'RUNNING', 'Backup'));
  expectCode(
    () => assertTransition(BACKUP_TRANSITIONS, 'PENDING', 'VERIFIED', 'Backup'),
    'INVALID_LIFECYCLE_TRANSITION'
  );
  expectCode(
    () => assertTransition(RESTORE_TRANSITIONS, 'APPROVED', 'IN_PROGRESS', 'Restore'),
    'INVALID_LIFECYCLE_TRANSITION'
  );
  expectCode(
    () => assertTransition(ROLLBACK_TRANSITIONS, 'AWAITING_APPROVAL', 'IN_PROGRESS', 'Rollback'),
    'INVALID_LIFECYCLE_TRANSITION'
  );
  const singleAdminPolicy = adminApprovalPolicyFromCount(1);
  assert.deepStrictEqual(singleAdminPolicy, {
    approval_mode: 'SINGLE_ADMIN_STEP_UP',
    active_system_admin_count: 1,
    eligible_system_admin_count: 1,
    single_admin_mode: true,
    self_approval_allowed: true,
    maker_checker_required: false,
    administrator_verification_required: true,
    independent_verification_required: false,
    step_up_mfa_required: true,
  });
  const multiAdminPolicy = adminApprovalPolicyFromCount(2);
  assert.strictEqual(multiAdminPolicy.approval_mode, 'SINGLE_ADMIN_STEP_UP');
  assert.strictEqual(multiAdminPolicy.single_admin_mode, true);
  assert.strictEqual(multiAdminPolicy.self_approval_allowed, true);
  assert.strictEqual(multiAdminPolicy.maker_checker_required, false);
  assert.strictEqual(multiAdminPolicy.independent_verification_required, false);
  for (const count of [0, 1, 2, 99]) {
    const fixedPolicy = adminApprovalPolicyFromCount(count);
    assert.strictEqual(fixedPolicy.approval_mode, 'SINGLE_ADMIN_STEP_UP');
    assert.strictEqual(fixedPolicy.single_admin_mode, true);
    assert.strictEqual(fixedPolicy.self_approval_allowed, true);
    assert.strictEqual(fixedPolicy.maker_checker_required, false);
    assert.strictEqual(fixedPolicy.independent_verification_required, false);
    assert.strictEqual(fixedPolicy.step_up_mfa_required, true);
  }

  let policyExecutorCalled = false;
  const loadedPolicy = await loadAdminApprovalPolicy({
    async execute() {
      policyExecutorCalled = true;
      throw new Error('The fixed single-admin policy must not query the database.');
    },
  });
  assert.strictEqual(policyExecutorCalled, false);
  assert.deepStrictEqual(loadedPolicy, {
    approval_mode: 'SINGLE_ADMIN_STEP_UP',
    active_system_admin_count: null,
    eligible_system_admin_count: null,
    single_admin_mode: true,
    self_approval_allowed: true,
    maker_checker_required: false,
    administrator_verification_required: true,
    independent_verification_required: false,
    step_up_mfa_required: true,
  });

  const requestHash = requestFingerprint('RESTORE_REQUEST', { backupId: 9, reason: 'Recovery test' });
  assert.match(requestHash, /^[a-f0-9]{64}$/);
  assert.strictEqual(requestHash, requestFingerprint('RESTORE_REQUEST', { backupId: 9, reason: 'Recovery test' }));
  assert.notStrictEqual(requestHash, requestFingerprint('RESTORE_REQUEST', { backupId: 9, reason: 'Different recovery' }));
  assert.doesNotThrow(() => assertIdempotentReplay({ request_fingerprint: requestHash }, requestHash));
  expectCode(() => assertIdempotentReplay({ request_fingerprint: requestHash }, 'b'.repeat(64)), 'IDEMPOTENCY_CONFLICT');
  const lease = workerLease();
  assert.match(lease.hash, /^[a-f0-9]{64}$/);
  assert(lease.minutes >= 15 && lease.minutes <= 1440);
  assert(backupDatabaseAcquireTimeoutMs() >= 1000 && backupDatabaseAcquireTimeoutMs() <= 30000);

  const immediateConnection = { release() {} };
  assert.strictEqual(
    await acquireConnectionWithTimeout(async () => immediateConnection, 1000),
    immediateConnection
  );
  let lateConnectionReleased = false;
  await expectRejectedCode(
    acquireConnectionWithTimeout(
      () => new Promise(resolve => setTimeout(() => resolve({ release() { lateConnectionReleased = true; } }), 20)),
      5
    ),
    'BACKUP_DATABASE_BUSY'
  );
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.strictEqual(lateConnectionReleased, true, 'A late pool connection must be released after a timeout.');

  const reaperSql = [];
  const recovered = await recoverExpiredOperations({
    async execute(sql) {
      reaperSql.push(sql);
      if (sql.includes('UPDATE backup_sets')) return [{ affectedRows: 1 }];
      if (sql.includes('UPDATE restore_jobs')) return [{ affectedRows: 0 }];
      if (sql.includes('UPDATE module_rollback_requests')) return [{ affectedRows: 2 }];
      if (sql.includes('INSERT INTO system_audit_log')) return [{ affectedRows: 1 }];
      throw new Error(`Unexpected reaper SQL: ${sql}`);
    },
  });
  assert.strictEqual(recovered, 3);
  assert.strictEqual(reaperSql.filter(sql => sql.includes('worker_lease_expires_at < NOW()')).length, 3);
  assert(reaperSql.some(sql => sql.includes('RECOVER_EXPIRED_BACKUP_WORKERS')));

  const verifiedRow = {
    id: 9,
    backup_reference: 'BKP-VERIFIED-9',
    backup_type: 'DATABASE',
    storage_provider: 'LOCAL',
    storage_location_encrypted: 'encrypted-location',
    checksum: 'a'.repeat(64),
    verified_checksum: 'a'.repeat(64),
    verification_status: 'MATCH',
    integrity_status: 'PASSED',
    verified_at: new Date(),
    verified_by: 43,
    created_by: 42,
    status: 'VERIFIED',
    included_modules: JSON.stringify(['payroll']),
  };
  assert.strictEqual(backupArtifactAvailable(verifiedRow), true);
  assert.strictEqual(backupArtifactVerified(verifiedRow), true);
  assert.strictEqual(backupResponse(verifiedRow, 43).is_restorable, true);

  for (const missingEvidence of [
    { ...verifiedRow, storage_location_encrypted: null },
    { ...verifiedRow, checksum: null },
    { ...verifiedRow, verification_status: 'MISMATCH' },
    { ...verifiedRow, integrity_status: 'FAILED' },
    { ...verifiedRow, verified_at: null },
    { ...verifiedRow, verified_by: null },
    { ...verifiedRow, retention_status: 'EXPIRED' },
    { ...verifiedRow, retention_status: 'DELETED', artifact_deleted_at: new Date() },
  ]) {
    assert.strictEqual(backupArtifactVerified(missingEvidence), false);
    assert.strictEqual(backupResponse(missingEvidence, 43).is_restorable, false);
  }

  const completed = { ...verifiedRow, status: 'COMPLETED', verification_status: 'NOT_VERIFIED', integrity_status: 'NOT_CHECKED', verified_at: null, verified_by: null };
  assert.deepStrictEqual(backupResponse(completed, 42).allowed_actions, ['verify']);
  assert.deepStrictEqual(backupResponse(completed, 43).allowed_actions, ['verify']);
  const singleAdminBackup = backupResponse(completed, 42, singleAdminPolicy);
  assert.deepStrictEqual(singleAdminBackup.allowed_actions, ['verify']);
  assert.strictEqual(singleAdminBackup.administrator_verification_required, true);
  assert.strictEqual(singleAdminBackup.independent_verification_required, false);
  assert.strictEqual(singleAdminBackup.maker_checker_required, false);

  const awaitingRestore = {
    id: 21,
    status: 'AWAITING_APPROVAL',
    approval_status: 'PENDING',
    requested_by: 42,
  };
  assert.deepStrictEqual(restoreResponse(awaitingRestore, 42, multiAdminPolicy).allowed_actions, ['approve', 'reject', 'cancel']);
  const singleAdminRestore = restoreResponse(awaitingRestore, 42, singleAdminPolicy);
  assert.deepStrictEqual(singleAdminRestore.allowed_actions, ['approve', 'reject', 'cancel']);
  assert.strictEqual(singleAdminRestore.approval_policy.approval_mode, 'SINGLE_ADMIN_STEP_UP');

  const awaitingRollback = {
    id: 31,
    status: 'AWAITING_APPROVAL',
    approval_status: 'PENDING',
    requested_by: 42,
    artifact_location_encrypted: 'encrypted-location',
    artifact_checksum: 'a'.repeat(64),
    verification_status: 'MATCH',
    integrity_status: 'PASSED',
  };
  assert.deepStrictEqual(
    rollbackResponse(awaitingRollback, 42, multiAdminPolicy).allowed_actions,
    ['approve', 'reject', 'cancel']
  );

  const rawToken = 'single-use-step-up-token';
  const tokenHash = _hashTokenForTest(rawToken);
  assert.strictEqual(_tokenMatchesForTest(rawToken, tokenHash), true);
  assert.strictEqual(_tokenMatchesForTest('wrong-token', tokenHash), false);

  const req = { user: { id: 43 } };
  let consumed = false;
  const executor = {
    async execute(sql) {
      if (sql.includes('SELECT id, user_id')) {
        return [[{
          id: 77,
          user_id: 43,
          purpose: 'RESTORE_EXECUTE',
          resource_type: 'RESTORE_JOB',
          resource_id: 9,
          challenge_token_hash: tokenHash,
          status: 'VERIFIED',
          verified_at: new Date(),
          expires_at: new Date(Date.now() + 60_000),
        }]];
      }
      if (sql.includes("status = 'CONSUMED'")) {
        if (consumed) return [{ affectedRows: 0 }];
        consumed = true;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL in step-up test: ${sql}`);
    },
  };
  const proof = await consumeBackupStepUpChallenge(executor, req, {
    challengeId: 77,
    challengeToken: rawToken,
    purpose: 'RESTORE_EXECUTE',
    resourceType: 'RESTORE_JOB',
    resourceId: 9,
  });
  assert.strictEqual(proof.challengeId, 77);
  await expectRejectedCode(
    consumeBackupStepUpChallenge(executor, req, {
      challengeId: 77,
      challengeToken: rawToken,
      purpose: 'RESTORE_EXECUTE',
      resourceType: 'RESTORE_JOB',
      resourceId: 9,
    }),
    'BACKUP_STEP_UP_CONSUMED'
  );

  await expectRejectedCode(
    consumeBackupStepUpChallenge(executor, req, {
      challengeId: 77,
      challengeToken: rawToken,
      purpose: 'BACKUP_VERIFY',
      resourceType: 'RESTORE_JOB',
      resourceId: 9,
    }),
    'BACKUP_STEP_UP_REQUIRED'
  );

  assert(BackupStepUpError.prototype instanceof Error);
  console.log('Backup and recovery API security tests: PASS');
}

run()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
