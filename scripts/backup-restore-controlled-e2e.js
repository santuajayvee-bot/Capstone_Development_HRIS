/*
 * Controlled local backup/rollback integration test.
 *
 * This script intentionally exercises the live HTTP API and database. It is
 * fail-closed, localhost-only, blocked in production, and requires an explicit
 * opt-in environment variable. It never prints JWTs, refresh tokens, MFA
 * secrets/codes, or encrypted storage locations.
 */
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const pool = require('../config/db');
const { createUserSession } = require('../db/authQueries');
const {
  generateAccessToken,
  generateRefreshToken,
  getRefreshTokenExpiryDate,
  hashRefreshToken,
} = require('../services/tokenService');
const {
  _generateTotpCodeForTest: generateTotpCode,
  _getEmployeeMfaProfileForTest: getEmployeeMfaProfile,
} = require('../services/mfaService');
const { DEFAULT_MODULE_SOURCE_MAP } = require('../services/backup/moduleCodeService');
const { getCurrentDpaVersion } = require('../server/dpa-service');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BASE_URL = String(process.env.BACKUP_E2E_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const API_ROOT = '/api/admin/backups';
const TEST_MODULE = 'reports';
const USER_AGENT = 'LGSV-controlled-backup-e2e/1.0';

function assertSafeEnvironment() {
  assert.equal(process.env.ALLOW_CONTROLLED_BACKUP_E2E, 'true', 'Set ALLOW_CONTROLLED_BACKUP_E2E=true to run this controlled test.');
  assert.notEqual(String(process.env.NODE_ENV || 'development').toLowerCase(), 'production', 'Controlled rollback tests are blocked in production.');
  const url = new URL(BASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(url.hostname), 'Controlled rollback tests may target localhost only.');
}

function safeStep(message) {
  process.stdout.write(`[backup-e2e] ${message}\n`);
}

function uniqueKey(prefix) {
  return `${prefix}:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`;
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function moduleHashes(moduleKey) {
  const relativePaths = DEFAULT_MODULE_SOURCE_MAP[moduleKey] || [];
  assert.ok(relativePaths.length > 0, `No source allowlist exists for ${moduleKey}.`);
  const entries = await Promise.all(relativePaths.map(async relativePath => {
    const absolutePath = path.resolve(PROJECT_ROOT, ...relativePath.split('/'));
    assert.ok(absolutePath.startsWith(`${PROJECT_ROOT}${path.sep}`), `Unsafe source path: ${relativePath}`);
    assert.ok(fs.existsSync(absolutePath), `Expected module source is missing: ${relativePath}`);
    return [relativePath, await sha256File(absolutePath)];
  }));
  return Object.fromEntries(entries);
}

function assertHashesEqual(before, after) {
  assert.deepEqual(after, before, 'The controlled rollback changed module source bytes unexpectedly.');
}

async function requestJson(token, method, apiPath, options = {}) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    Origin: BASE_URL,
    'User-Agent': USER_AGENT,
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
  };
  const requestPath = apiPath.startsWith('/api/') ? apiPath : `${API_ROOT}${apiPath}`;
  const response = await fetch(`${BASE_URL}${requestPath}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = { error: 'Non-JSON response received.' }; }
  const expected = options.expectedStatuses || [200];
  if (!expected.includes(response.status)) {
    const safeBody = body && typeof body === 'object'
      ? { error: body.error, code: body.code, message: body.message }
      : null;
    throw new Error(`${method} ${apiPath} returned ${response.status}: ${JSON.stringify(safeBody)}`);
  }
  return { status: response.status, body };
}

async function findTestActors() {
  const [admins] = await pool.execute(
    `SELECT u.id, u.username, u.employee_id AS employee_table_id, u.role_id,
            COALESCE(u.token_version, 0) AS token_version,
            COALESCE(u.force_password_change, 0) AS force_password_change,
            r.name AS role_name, r.access_level, e.Employee_ID
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN employees e ON e.id = u.employee_id
      WHERE u.is_active = 1
        AND LOWER(REPLACE(REPLACE(r.name, ' ', '_'), '-', '_')) IN ('system_admin', 'system_administrator', 'admin')
      ORDER BY u.id`
  );
  assert.ok(admins.length >= 2, 'Two active System Administrator accounts are required for maker-checker testing.');

  let checker = null;
  for (const admin of admins) {
    if (!admin.Employee_ID) continue;
    const profile = await getEmployeeMfaProfile(admin.Employee_ID);
    if (profile?.secret && profile?.enrolledAt) {
      checker = { ...admin, mfaProfile: profile };
      break;
    }
  }
  assert.ok(checker, 'An active System Administrator with enrolled TOTP MFA is required as checker.');
  const maker = admins.find(admin => Number(admin.id) !== Number(checker.id));
  assert.ok(maker, 'A distinct System Administrator is required as maker.');
  assert.equal(Number(maker.force_password_change), 0, 'Maker account must not be forced through password change.');
  assert.equal(Number(checker.force_password_change), 0, 'Checker account must not be forced through password change.');
  return { maker, checker };
}

async function findTemporaryEmployeeLink(checker) {
  const [rows] = await pool.execute(
    `SELECT e.id AS employee_table_id, e.Employee_ID
       FROM employees e
       LEFT JOIN users u ON u.employee_id = e.id
      WHERE u.id IS NULL
        AND e.Employee_ID IS NOT NULL
        AND LOWER(COALESCE(e.status, 'active')) NOT IN
            ('inactive','resigned','terminated','end of contract','retired','offboarded')
      ORDER BY e.id
      LIMIT 1`
  );
  if (rows[0]) return rows[0];
  return {
    employee_table_id: checker.employee_table_id,
    Employee_ID: checker.Employee_ID,
  };
}

async function createControlledSession(user, employeeId) {
  const authUser = {
    id: user.id,
    username: user.username,
    role: user.role_name,
    employeeId,
    roleId: user.role_id,
    accessLevel: user.access_level,
    tokenVersion: user.token_version,
    forcePasswordChange: false,
    mustChangePassword: false,
  };
  const { token, jwtId } = generateAccessToken(authUser);
  const refreshToken = generateRefreshToken();
  await createUserSession({
    Employee_ID: employeeId,
    Refresh_Token_Hash: hashRefreshToken(refreshToken),
    JWT_ID: jwtId,
    IP_Address: '127.0.0.1',
    User_Agent: USER_AGENT,
    Expires_At: getRefreshTokenExpiryDate(),
  });
  return { token, jwtId };
}

async function freshStepUp(checkerToken, checker, purpose, resourceType, resourceId) {
  const challenge = await requestJson(checkerToken, 'POST', '/step-up/challenges', {
    expectedStatuses: [201],
    body: {
      purpose,
      resource_type: resourceType,
      resource_id: resourceId,
    },
  });
  assert.ok(challenge.body?.challenge_id && challenge.body?.challenge_token, 'Step-up challenge response is incomplete.');
  const code = generateTotpCode(checker.mfaProfile.secret);
  const verified = await requestJson(
    checkerToken,
    'POST',
    `/step-up/challenges/${challenge.body.challenge_id}/verify`,
    {
      body: {
        challenge_token: challenge.body.challenge_token,
        code,
      },
    }
  );
  assert.equal(Number(verified.body.step_up_challenge_id), Number(challenge.body.challenge_id));
  return {
    step_up_challenge_id: verified.body.step_up_challenge_id,
    step_up_token: verified.body.step_up_token,
  };
}

async function loadEvidence(backupId, recoveryPointId, rollbackRequestId, checkerId) {
  const [[backupRows], [pointRows], [rollbackRows], [challengeRows], [healthRows], [historyRows]] = await Promise.all([
    pool.execute(
      `SELECT id, backup_reference, backup_type, storage_provider, status, checksum,
              verified_checksum, verification_status, integrity_status, created_by,
              verified_by, file_size, artifact_format, completed_at, verified_at
         FROM backup_sets WHERE id = ?`,
      [backupId]
    ),
    pool.execute(
      `SELECT id, backup_set_id, module_key, status, rollback_available,
              verification_status, integrity_status, artifact_checksum, verified_at
         FROM module_recovery_points WHERE id = ?`,
      [recoveryPointId]
    ),
    pool.execute(
      `SELECT id, recovery_point_id, affected_module, status, approval_status,
              requested_by, approved_by, verification_status, integrity_status,
              attempt_count, started_at, completed_at
         FROM module_rollback_requests WHERE id = ?`,
      [rollbackRequestId]
    ),
    pool.execute(
      `SELECT purpose, resource_type, resource_id, status, user_id, verified_at, consumed_at
         FROM backup_step_up_challenges
        WHERE user_id = ? AND status = 'CONSUMED'
          AND ((purpose = 'BACKUP_VERIFY' AND resource_id = ?)
            OR (purpose IN ('ROLLBACK_APPROVE','ROLLBACK_EXECUTE') AND resource_id = ?))
        ORDER BY id`,
      [checkerId, backupId, rollbackRequestId]
    ),
    pool.execute(
      `SELECT module_key, status, checked_by, last_checked_at, remarks
         FROM system_health_checks WHERE module_key = ?`,
      [TEST_MODULE]
    ),
    pool.execute(
      `SELECT module_key, status, checked_by, checked_at, remarks
         FROM system_health_check_history
        WHERE module_key = ? AND remarks LIKE ?
        ORDER BY checked_at`,
      [TEST_MODULE, `%${rollbackRequestId}%`]
    ),
  ]);

  const backup = backupRows[0];
  const point = pointRows[0];
  const rollback = rollbackRows[0];
  assert.ok(backup, 'Backup database row is missing.');
  assert.ok(point, 'Recovery-point database row is missing.');
  assert.ok(rollback, 'Rollback database row is missing.');
  assert.equal(backup.status, 'VERIFIED');
  assert.equal(backup.verification_status, 'MATCH');
  assert.equal(backup.integrity_status, 'PASSED');
  assert.equal(backup.checksum, backup.verified_checksum);
  assert.equal(Number(backup.verified_by), Number(checkerId));
  assert.equal(point.status, 'AVAILABLE');
  assert.equal(Number(point.rollback_available), 1);
  assert.equal(point.verification_status, 'MATCH');
  assert.equal(point.integrity_status, 'PASSED');
  assert.equal(point.artifact_checksum, backup.checksum);
  assert.equal(rollback.status, 'COMPLETED');
  assert.equal(rollback.approval_status, 'APPROVED');
  assert.equal(Number(rollback.approved_by), Number(checkerId));
  assert.equal(rollback.verification_status, 'MATCH');
  assert.equal(rollback.integrity_status, 'PASSED');
  assert.equal(Number(rollback.attempt_count), 1);
  assert.equal(challengeRows.length, 3, 'Expected three independently consumed MFA proofs.');
  assert.deepEqual(challengeRows.map(row => row.purpose).sort(), ['BACKUP_VERIFY', 'ROLLBACK_APPROVE', 'ROLLBACK_EXECUTE']);
  assert.ok(healthRows.some(row => row.status === 'WARNING'), 'Module health was not moved to post-rollback WARNING.');
  assert.deepEqual(historyRows.map(row => row.status), ['MAINTENANCE', 'WARNING']);

  return { backup, point, rollback, challengeRows, healthRows, historyRows };
}

async function main() {
  assertSafeEnvironment();
  const cleanup = {
    jwtIds: [],
    dpaAcceptanceId: null,
    makerUserId: null,
    makerOriginalEmployeeTableId: null,
    makerLinkChanged: false,
  };
  let summary = null;

  try {
    await pool.execute('SELECT 1');
    const health = await fetch(`${BASE_URL}/health`, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
    assert.ok(health.ok, `Server health endpoint returned ${health.status}.`);

    const { maker, checker } = await findTestActors();
    cleanup.makerUserId = maker.id;
    cleanup.makerOriginalEmployeeTableId = maker.employee_table_id;

    let makerEmployeeTableId = maker.employee_table_id;
    let makerEmployeeId = maker.Employee_ID;
    if (!makerEmployeeId) {
      const temporaryEmployee = await findTemporaryEmployeeLink(checker);
      await pool.execute('UPDATE users SET employee_id = ? WHERE id = ? AND employee_id IS NULL', [temporaryEmployee.employee_table_id, maker.id]);
      makerEmployeeTableId = temporaryEmployee.employee_table_id;
      makerEmployeeId = temporaryEmployee.Employee_ID;
      cleanup.makerLinkChanged = true;
    }
    assert.ok(makerEmployeeId, 'Maker could not be linked to a valid employee authentication identifier.');

    const version = getCurrentDpaVersion();
    const [acceptances] = await pool.execute(
      'SELECT Acceptance_ID FROM DATA_PRIVACY_AGREEMENT_ACCEPTANCE WHERE User_ID = ? AND Agreement_Version = ? LIMIT 1',
      [maker.id, version]
    );
    if (!acceptances.length) {
      const [inserted] = await pool.execute(
        `INSERT INTO DATA_PRIVACY_AGREEMENT_ACCEPTANCE
           (User_ID, Employee_ID, Agreement_Version, Accepted_At, IP_Address, User_Agent)
         VALUES (?, ?, ?, NOW(), '127.0.0.1', ?)`,
        [maker.id, makerEmployeeTableId, version, USER_AGENT]
      );
      cleanup.dpaAcceptanceId = inserted.insertId;
    }

    const makerSession = await createControlledSession(maker, makerEmployeeId);
    const checkerSession = await createControlledSession(checker, checker.Employee_ID);
    cleanup.jwtIds.push(makerSession.jwtId, checkerSession.jwtId);

    await requestJson(makerSession.token, 'GET', '/overview');
    await requestJson(checkerSession.token, 'GET', '/overview');
    safeStep('Authenticated maker and MFA-enabled checker through revocable sessions.');

    const beforeHashes = await moduleHashes(TEST_MODULE);
    const backupKey = uniqueKey('controlled-backup-e2e');
    const marker = new Date().toISOString();
    const backupPayload = {
      backup_name: `CONTROLLED E2E ${TEST_MODULE} ${marker}`,
      backup_type: 'DEPLOYMENT_VERSION',
      storage_provider: 'LOCAL',
      included_modules: [TEST_MODULE],
      notes: 'Controlled localhost integration test of encrypted source-code backup and transactional rollback.',
    };
    const created = await requestJson(makerSession.token, 'POST', '/request', {
      expectedStatuses: [201],
      idempotencyKey: backupKey,
      body: backupPayload,
    });
    const backupId = Number(created.body.backup_set_id);
    assert.ok(backupId > 0, 'Backup request did not return an ID.');
    const replayedBackup = await requestJson(makerSession.token, 'POST', '/request', {
      expectedStatuses: [200],
      idempotencyKey: backupKey,
      body: backupPayload,
    });
    assert.equal(replayedBackup.body.idempotent_replay, true);
    assert.equal(Number(replayedBackup.body.backup_set_id), backupId);
    safeStep(`Created backup set ${backupId}; idempotent replay returned the same transaction.`);

    const prematureVerify = await requestJson(checkerSession.token, 'POST', `/${backupId}/verify`, {
      expectedStatuses: [409],
      body: {},
    });
    assert.equal(prematureVerify.body.code, 'BACKUP_NOT_READY');

    const run = await requestJson(makerSession.token, 'POST', `/${backupId}/run`, { body: {} });
    assert.equal(run.body?.result?.status, 'COMPLETED');
    assert.equal(run.body?.result?.independent_verification_required, true);
    const duplicateRun = await requestJson(makerSession.token, 'POST', `/${backupId}/run`, {
      expectedStatuses: [409],
      body: {},
    });
    assert.equal(duplicateRun.body.code, 'INVALID_LIFECYCLE_TRANSITION');
    safeStep('Worker produced an encrypted local artifact; duplicate execution was blocked by the state machine.');

    const makerVerify = await requestJson(makerSession.token, 'POST', `/${backupId}/verify`, {
      expectedStatuses: [409],
      body: {},
    });
    assert.equal(makerVerify.body.code, 'MAKER_CHECKER_REQUIRED');

    const backupProof = await freshStepUp(checkerSession.token, checker, 'BACKUP_VERIFY', 'BACKUP_SET', backupId);
    const verifiedBackup = await requestJson(checkerSession.token, 'POST', `/${backupId}/verify`, {
      body: backupProof,
    });
    assert.equal(verifiedBackup.body?.verification?.valid, true);
    safeStep('Independent checker matched the server-generated SHA-256 checksum using fresh TOTP step-up MFA.');

    const points = await requestJson(checkerSession.token, 'GET', '/recovery-points');
    const point = points.body.find(item => Number(item.backup_set_id) === backupId && item.module_key === TEST_MODULE);
    assert.ok(point?.rollback_available && point?.artifact_verified, 'Verified rollback recovery point was not published.');
    const recoveryPointId = Number(point.recovery_point_id || point.id);

    const rollbackKey = uniqueKey('controlled-rollback-e2e');
    const rollbackPayload = {
      recovery_point_id: recoveryPointId,
      affected_module: TEST_MODULE,
      reason: 'Controlled localhost end-to-end validation of transactional source-code rollback.',
    };
    const requested = await requestJson(makerSession.token, 'POST', '/rollback-requests', {
      expectedStatuses: [201],
      idempotencyKey: rollbackKey,
      body: rollbackPayload,
    });
    const rollbackRequestId = Number(requested.body.rollback_request_id);
    assert.ok(rollbackRequestId > 0, 'Rollback request did not return an ID.');
    const replayedRollback = await requestJson(makerSession.token, 'POST', '/rollback-requests', {
      idempotencyKey: rollbackKey,
      body: rollbackPayload,
    });
    assert.equal(replayedRollback.body.idempotent_replay, true);
    assert.equal(Number(replayedRollback.body.rollback_request_id), rollbackRequestId);

    const approvalProof = await freshStepUp(checkerSession.token, checker, 'ROLLBACK_APPROVE', 'ROLLBACK_REQUEST', rollbackRequestId);
    const approved = await requestJson(checkerSession.token, 'POST', `/rollback-requests/${rollbackRequestId}/approve`, {
      body: {
        ...approvalProof,
        approval_notes: 'Controlled E2E checker approval after verified checksum and recovery-point review.',
      },
    });
    assert.equal(approved.body.status, 'APPROVED');

    const executeProof = await freshStepUp(checkerSession.token, checker, 'ROLLBACK_EXECUTE', 'ROLLBACK_REQUEST', rollbackRequestId);
    const executed = await requestJson(checkerSession.token, 'POST', `/rollback-requests/${rollbackRequestId}/execute`, {
      body: {
        ...executeProof,
        confirmation_phrase: 'EXECUTE ROLLBACK',
      },
    });
    assert.equal(executed.body.status, 'COMPLETED');
    assert.equal(executed.body?.result?.restored, true);
    assert.equal(executed.body?.result?.integrityPassed, true);
    assert.equal(executed.body?.result?.verified, true);
    safeStep(`Rollback request ${rollbackRequestId} completed transactional code replacement and post-cutover verification.`);

    const afterHashes = await moduleHashes(TEST_MODULE);
    assertHashesEqual(beforeHashes, afterHashes);

    const evidence = await loadEvidence(backupId, recoveryPointId, rollbackRequestId, checker.id);
    const requiredAuditActions = [
      'CREATE_BACKUP:',
      'RUN_BACKUP:',
      'COMPLETE_BACKUP:',
      'VERIFY_BACKUP:',
      `REQUEST_MODULE_ROLLBACK: ${TEST_MODULE}`,
      `APPROVE_MODULE_ROLLBACK: ${TEST_MODULE}`,
      `EXECUTE_MODULE_ROLLBACK: ${TEST_MODULE}`,
      `COMPLETE_MODULE_ROLLBACK: ${TEST_MODULE}`,
    ];
    const [auditRows] = await pool.execute(
      `SELECT action_performed, user_id, timestamp
         FROM system_audit_log
        WHERE module = 'BACKUP_RESTORE'
          AND timestamp >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)
          AND (action_performed LIKE ? OR action_performed LIKE ?)
        ORDER BY timestamp`,
      [`%${evidence.backup.backup_reference}%`, `%${TEST_MODULE}%`]
    );
    for (const action of requiredAuditActions) {
      assert.ok(auditRows.some(row => String(row.action_performed).startsWith(action)), `Missing audit action: ${action}`);
    }
    safeStep('Database state, consumed MFA proofs, audit trail, health history, and file hashes all passed.');

    summary = {
      result: 'PASS',
      module: TEST_MODULE,
      backup_set_id: backupId,
      backup_reference: evidence.backup.backup_reference,
      backup_status: evidence.backup.status,
      checksum_match: evidence.backup.checksum === evidence.backup.verified_checksum,
      recovery_point_id: recoveryPointId,
      rollback_request_id: rollbackRequestId,
      rollback_status: evidence.rollback.status,
      rollback_integrity: evidence.rollback.integrity_status,
      source_files_verified: Object.keys(afterHashes).length,
      source_bytes_unchanged: true,
      mfa_proofs_consumed: evidence.challengeRows.length,
      health_transition: evidence.historyRows.map(row => row.status),
      restart_required: Boolean(executed.body.restart_required),
    };
  } finally {
    if (cleanup.jwtIds.length) {
      await pool.query('DELETE FROM USER_SESSION WHERE JWT_ID IN (?)', [cleanup.jwtIds]).catch(() => {});
    }
    if (cleanup.dpaAcceptanceId) {
      await pool.execute('DELETE FROM DATA_PRIVACY_AGREEMENT_ACCEPTANCE WHERE Acceptance_ID = ?', [cleanup.dpaAcceptanceId]).catch(() => {});
    }
    if (cleanup.makerLinkChanged && cleanup.makerUserId) {
      await pool.execute('UPDATE users SET employee_id = ? WHERE id = ?', [cleanup.makerOriginalEmployeeTableId || null, cleanup.makerUserId]).catch(() => {});
    }
    await pool.end().catch(() => {});
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function runAutomationWorkflow() {
  assertSafeEnvironment();
  const cleanup = {
    jwtIds: [],
    dpaAcceptanceId: null,
    makerUserId: null,
    makerOriginalEmployeeTableId: null,
    makerLinkChanged: false,
  };
  let summary = null;

  try {
    await pool.execute('SELECT 1');
    const health = await fetch(`${BASE_URL}/health`, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
    assert.ok(health.ok, `Server health endpoint returned ${health.status}.`);
    const { maker, checker } = await findTestActors();
    cleanup.makerUserId = maker.id;
    cleanup.makerOriginalEmployeeTableId = maker.employee_table_id;

    let makerEmployeeTableId = maker.employee_table_id;
    let makerEmployeeId = maker.Employee_ID;
    if (!makerEmployeeId) {
      const temporaryEmployee = await findTemporaryEmployeeLink(checker);
      await pool.execute('UPDATE users SET employee_id=? WHERE id=? AND employee_id IS NULL', [temporaryEmployee.employee_table_id, maker.id]);
      makerEmployeeTableId = temporaryEmployee.employee_table_id;
      makerEmployeeId = temporaryEmployee.Employee_ID;
      cleanup.makerLinkChanged = true;
    }
    assert.ok(makerEmployeeId, 'Maker could not be linked to a valid employee authentication identifier.');

    const version = getCurrentDpaVersion();
    const [acceptances] = await pool.execute(
      'SELECT Acceptance_ID FROM DATA_PRIVACY_AGREEMENT_ACCEPTANCE WHERE User_ID=? AND Agreement_Version=? LIMIT 1',
      [maker.id, version]
    );
    if (!acceptances.length) {
      const [inserted] = await pool.execute(
        `INSERT INTO DATA_PRIVACY_AGREEMENT_ACCEPTANCE
           (User_ID,Employee_ID,Agreement_Version,Accepted_At,IP_Address,User_Agent)
         VALUES (?,?,?,NOW(),'127.0.0.1',?)`,
        [maker.id, makerEmployeeTableId, version, USER_AGENT]
      );
      cleanup.dpaAcceptanceId = inserted.insertId;
    }

    const makerSession = await createControlledSession(maker, makerEmployeeId);
    const checkerSession = await createControlledSession(checker, checker.Employee_ID);
    cleanup.jwtIds.push(makerSession.jwtId, checkerSession.jwtId);
    const marker = new Date().toISOString();

    const readiness = await requestJson(checkerSession.token, 'GET', '/provider-readiness');
    assert.ok(readiness.body?.providers?.s3 && readiness.body?.providers?.rdsSnapshot, 'Provider diagnostics are incomplete.');

    const scheduleKey = uniqueKey('controlled-schedule-create');
    const schedulePayload = {
      schedule_name: `CONTROLLED CONFIG BACKUP ${marker}`,
      backup_type: 'CONFIGURATION',
      storage_provider: 'LOCAL',
      included_modules: ['reports'],
      frequency: 'DAILY',
      run_time: '02:00',
      timezone: 'Asia/Manila',
      enabled: false,
    };
    const scheduleCreated = await requestJson(makerSession.token, 'POST', '/schedules', {
      expectedStatuses: [201],
      idempotencyKey: scheduleKey,
      body: schedulePayload,
    });
    const scheduleId = Number(scheduleCreated.body.schedule_id);
    assert.ok(scheduleId > 0);
    const scheduleReplay = await requestJson(makerSession.token, 'POST', '/schedules', {
      idempotencyKey: scheduleKey,
      body: schedulePayload,
    });
    assert.equal(scheduleReplay.body.idempotent_replay, true);

    const scheduleRunKey = uniqueKey('controlled-schedule-run');
    const scheduleProof = await freshStepUp(checkerSession.token, checker, 'SCHEDULE_RUN', 'BACKUP_SCHEDULE', scheduleId);
    const scheduleRun = await requestJson(checkerSession.token, 'POST', `/schedules/${scheduleId}/run-now`, {
      idempotencyKey: scheduleRunKey,
      body: scheduleProof,
    });
    const backupId = Number(scheduleRun.body.backup_set_id || scheduleRun.body?.result?.backupSetId);
    assert.ok(backupId > 0, 'Schedule run did not create a backup transaction.');
    assert.equal(scheduleRun.body?.result?.status, 'COMPLETED');

    const scheduleReplayProof = await freshStepUp(checkerSession.token, checker, 'SCHEDULE_RUN', 'BACKUP_SCHEDULE', scheduleId);
    const scheduleRunReplay = await requestJson(checkerSession.token, 'POST', `/schedules/${scheduleId}/run-now`, {
      idempotencyKey: scheduleRunKey,
      body: scheduleReplayProof,
    });
    assert.equal(scheduleRunReplay.body.idempotent_replay, true);
    assert.equal(Number(scheduleRunReplay.body?.result?.backupSetId), backupId);
    safeStep(`Schedule ${scheduleId} created backup ${backupId}; protected replay returned the same transaction.`);

    const inboxBeforeVerify = await requestJson(checkerSession.token, 'GET', '/notifications');
    const checkerNotification = inboxBeforeVerify.body.notifications.find(item => (
      item.resource_type === 'BACKUP_SET' && Number(item.resource_id) === backupId
    ));
    assert.ok(checkerNotification, 'Checker inbox did not publish the pending backup verification.');
    const notificationRead = await requestJson(
      checkerSession.token,
      'PATCH',
      `/notifications/${checkerNotification.notification_id || checkerNotification.id}/read`,
      { idempotencyKey: uniqueKey('controlled-notification-read'), body: {} }
    );
    assert.equal(notificationRead.body.status, 'READ');

    const verifyProof = await freshStepUp(checkerSession.token, checker, 'BACKUP_VERIFY', 'BACKUP_SET', backupId);
    const verified = await requestJson(checkerSession.token, 'POST', `/${backupId}/verify`, { body: verifyProof });
    assert.equal(verified.body?.verification?.valid, true);

    const policyDraftPayload = {
      policy_name: `CONTROLLED SAFE RETENTION ${marker}`,
      backup_type: 'ALL',
      storage_provider: 'ALL',
      keep_last: 1000,
      max_age_days: 3650,
      delete_expired_artifacts: false,
      enabled: false,
    };
    const policyDraft = await requestJson(makerSession.token, 'PUT', '/retention-policy', {
      expectedStatuses: [201],
      idempotencyKey: uniqueKey('controlled-retention-draft'),
      body: policyDraftPayload,
    });
    const policyId = Number(policyDraft.body.policy_id);
    assert.ok(policyId > 0);
    const policyProof = await freshStepUp(checkerSession.token, checker, 'RETENTION_EXECUTE', 'RETENTION_POLICY', policyId);
    const policyEnabled = await requestJson(checkerSession.token, 'PUT', '/retention-policy', {
      idempotencyKey: uniqueKey('controlled-retention-enable'),
      body: { ...policyDraftPayload, policy_id: policyId, enabled: true, ...policyProof },
    });
    assert.equal(policyEnabled.body?.policy?.enabled, true);
    const cleanupProof = await freshStepUp(checkerSession.token, checker, 'RETENTION_EXECUTE', 'RETENTION_POLICY', policyId);
    const cleanupResult = await requestJson(checkerSession.token, 'POST', '/retention/run', {
      idempotencyKey: uniqueKey('controlled-retention-run'),
      body: { policy_id: policyId, ...cleanupProof },
    });
    assert.equal(cleanupResult.body?.result?.deleted_artifacts, 0, 'Safe controlled retention unexpectedly deleted an artifact.');

    const drillKey = uniqueKey('controlled-drill-create');
    const drillPayload = {
      drill_name: `CONTROLLED LOCAL RESTORE DRILL ${marker}`,
      backup_type: 'CONFIGURATION',
      storage_provider: 'LOCAL',
      affected_module: 'reports',
      frequency: 'WEEKLY',
      run_time: '03:00',
      day_of_week: 7,
      timezone: 'Asia/Manila',
      enabled: false,
    };
    const drillCreated = await requestJson(makerSession.token, 'POST', '/restore-drills', {
      expectedStatuses: [201],
      idempotencyKey: drillKey,
      body: drillPayload,
    });
    const drillId = Number(drillCreated.body.drill_id);
    assert.ok(drillId > 0);
    const drillRunKey = uniqueKey('controlled-drill-run');
    const drillProof = await freshStepUp(checkerSession.token, checker, 'DRILL_RUN', 'RESTORE_DRILL', drillId);
    const drillRun = await requestJson(checkerSession.token, 'POST', `/restore-drills/${drillId}/run-now`, {
      idempotencyKey: drillRunKey,
      body: drillProof,
    });
    assert.equal(drillRun.body?.result?.status, 'PASSED');
    assert.equal(drillRun.body?.result?.liveRestoreApplied, false);
    const drillRunId = Number(drillRun.body.drill_run_id || drillRun.body?.result?.runId);

    const drillReplayProof = await freshStepUp(checkerSession.token, checker, 'DRILL_RUN', 'RESTORE_DRILL', drillId);
    const drillReplay = await requestJson(checkerSession.token, 'POST', `/restore-drills/${drillId}/run-now`, {
      idempotencyKey: drillRunKey,
      body: drillReplayProof,
    });
    assert.equal(drillReplay.body.idempotent_replay, true);
    assert.equal(Number(drillReplay.body?.result?.runId), drillRunId);

    const disablePolicyProof = await freshStepUp(checkerSession.token, checker, 'RETENTION_EXECUTE', 'RETENTION_POLICY', policyId);
    const disabledPolicy = await requestJson(checkerSession.token, 'PUT', '/retention-policy', {
      idempotencyKey: uniqueKey('controlled-retention-disable'),
      body: { ...policyDraftPayload, policy_id: policyId, enabled: false, ...disablePolicyProof },
    });
    assert.equal(disabledPolicy.body?.policy?.enabled, false);

    const paged = await requestJson(checkerSession.token, 'GET', '/?page=999&page_size=5&search=CONTROLLED');
    assert.ok(Array.isArray(paged.body.items));
    assert.ok(Number(paged.body.pagination.page) <= Number(paged.body.pagination.total_pages));
    const drills = await requestJson(checkerSession.token, 'GET', `/restore-drills?search=${encodeURIComponent('CONTROLLED LOCAL')}`);
    assert.ok(drills.body.drills.some(item => Number(item.drill_id) === drillId && item.latest_run));

    const [[backupEvidence], [actionEvidence], [drillEvidence], [auditEvidence]] = await Promise.all([
      pool.execute(
        `SELECT id,status,verification_status,integrity_status,schedule_id,checksum,verified_checksum
           FROM backup_sets WHERE id=?`,
        [backupId]
      ),
      pool.execute(
        `SELECT action_type,status,resource_type,resource_id
           FROM backup_automation_action_requests
          WHERE resource_id IN (?,?,?) ORDER BY id`,
        [scheduleId, policyId, drillId]
      ),
      pool.execute(
        `SELECT id,status,integrity_status,backup_set_id
           FROM backup_restore_drill_runs WHERE id=?`,
        [drillRunId]
      ),
      pool.execute(
        `SELECT action_performed FROM system_audit_log
          WHERE module='BACKUP_RESTORE' AND timestamp>=DATE_SUB(NOW(),INTERVAL 30 MINUTE)
            AND (action_performed LIKE '%BACKUP_SCHEDULE%' OR action_performed LIKE '%RETENTION%'
              OR action_performed LIKE '%RESTORE_DRILL%')`
      ),
    ]);
    assert.equal(backupEvidence[0]?.status, 'VERIFIED');
    assert.equal(backupEvidence[0]?.checksum, backupEvidence[0]?.verified_checksum);
    assert.ok(actionEvidence.length >= 4 && actionEvidence.every(item => item.status === 'COMPLETED'));
    assert.deepEqual(
      [...new Set(actionEvidence.map(item => item.action_type))].sort(),
      ['DRILL_RUN', 'RETENTION_RUN', 'RETENTION_UPDATE', 'SCHEDULE_RUN']
    );
    assert.equal(drillEvidence[0]?.status, 'PASSED');
    assert.equal(drillEvidence[0]?.integrity_status, 'PASSED');
    assert.ok(auditEvidence.length >= 6, 'Automation audit evidence is incomplete.');
    safeStep('Schedule, inbox, retention, drill, pagination, MFA, idempotency, and audit evidence all passed.');

    summary = {
      result: 'PASS',
      schedule_id: scheduleId,
      backup_set_id: backupId,
      backup_status: backupEvidence[0].status,
      checker_notification_id: checkerNotification.notification_id || checkerNotification.id,
      retention_policy_id: policyId,
      retention_policy_enabled_after_test: false,
      retention_deleted_artifacts: cleanupResult.body.result.deleted_artifacts,
      restore_drill_id: drillId,
      restore_drill_run_id: drillRunId,
      restore_drill_status: drillEvidence[0].status,
      production_changed_by_drill: false,
      action_ledger_rows: actionEvidence.length,
      pagination_clamped: true,
    };
  } finally {
    if (cleanup.jwtIds.length) await pool.query('DELETE FROM USER_SESSION WHERE JWT_ID IN (?)', [cleanup.jwtIds]).catch(() => {});
    if (cleanup.dpaAcceptanceId) {
      await pool.execute('DELETE FROM DATA_PRIVACY_AGREEMENT_ACCEPTANCE WHERE Acceptance_ID=?', [cleanup.dpaAcceptanceId]).catch(() => {});
    }
    if (cleanup.makerLinkChanged && cleanup.makerUserId) {
      await pool.execute('UPDATE users SET employee_id=? WHERE id=?', [cleanup.makerOriginalEmployeeTableId || null, cleanup.makerUserId]).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function runPostRestoreHealthCheck() {
  assertSafeEnvironment();
  let jwtId = null;
  try {
    await pool.execute('SELECT 1');
    const { checker } = await findTestActors();
    const checkerSession = await createControlledSession(checker, checker.Employee_ID);
    jwtId = checkerSession.jwtId;
    const checked = await requestJson(
      checkerSession.token,
      'POST',
      '/api/admin/system-health/check/reports',
      { body: {} }
    );
    assert.equal(checked.body?.module?.module_key, TEST_MODULE);
    assert.notEqual(checked.body?.module?.status, 'MAINTENANCE');
    const [rows] = await pool.execute(
      'SELECT module_key, status, checked_by, last_checked_at FROM system_health_checks WHERE module_key = ?',
      [TEST_MODULE]
    );
    assert.equal(rows[0]?.status, checked.body.module.status);
    process.stdout.write(`${JSON.stringify({
      result: 'PASS',
      module: TEST_MODULE,
      post_restart_health_status: checked.body.module.status,
      persisted_health_status: rows[0].status,
      audit_log_recorded: Array.isArray(checked.body.module.recent_logs)
        && checked.body.module.recent_logs.some(log => log?.module === 'SYSTEM_HEALTH'),
    }, null, 2)}\n`);
  } finally {
    if (jwtId) await pool.execute('DELETE FROM USER_SESSION WHERE JWT_ID = ?', [jwtId]).catch(() => {});
    await pool.end().catch(() => {});
  }
}

async function verifyControlledBackup() {
  assertSafeEnvironment();
  const argument = process.argv.find(value => value.startsWith('--verify-backup='));
  const backupId = Number(argument?.split('=')[1]);
  assert.ok(Number.isSafeInteger(backupId) && backupId > 0, 'A valid --verify-backup=<id> value is required.');
  let jwtId = null;
  try {
    const { checker } = await findTestActors();
    const session = await createControlledSession(checker, checker.Employee_ID);
    jwtId = session.jwtId;
    const proof = await freshStepUp(session.token, checker, 'BACKUP_VERIFY', 'BACKUP_SET', backupId);
    const verified = await requestJson(session.token, 'POST', `/${backupId}/verify`, { body: proof });
    assert.equal(verified.body?.verification?.valid, true);
    process.stdout.write(`${JSON.stringify({ result: 'PASS', backup_set_id: backupId, independently_verified: true }, null, 2)}\n`);
  } finally {
    if (jwtId) await pool.execute('DELETE FROM USER_SESSION WHERE JWT_ID=?', [jwtId]).catch(() => {});
    await pool.end().catch(() => {});
  }
}

async function disableControlledRetentionPolicies() {
  assertSafeEnvironment();
  let jwtId = null;
  const disabledIds = [];
  try {
    const { checker } = await findTestActors();
    const session = await createControlledSession(checker, checker.Employee_ID);
    jwtId = session.jwtId;
    const [policies] = await pool.execute(
      `SELECT * FROM backup_retention_policies
        WHERE enabled=1 AND policy_name LIKE 'CONTROLLED SAFE RETENTION %'
        ORDER BY id`
    );
    for (const policy of policies) {
      const proof = await freshStepUp(session.token, checker, 'RETENTION_EXECUTE', 'RETENTION_POLICY', policy.id);
      const response = await requestJson(session.token, 'PUT', '/retention-policy', {
        idempotencyKey: uniqueKey('controlled-retention-cleanup'),
        body: {
          policy_id: policy.id,
          policy_name: policy.policy_name,
          backup_type: policy.backup_type || 'ALL',
          storage_provider: policy.storage_provider || 'ALL',
          keep_last: Number(policy.keep_last),
          max_age_days: Number(policy.max_age_days),
          delete_expired_artifacts: Boolean(policy.delete_expired_artifacts),
          enabled: false,
          ...proof,
        },
      });
      assert.equal(response.body?.policy?.enabled, false);
      disabledIds.push(Number(policy.id));
    }
    process.stdout.write(`${JSON.stringify({ result: 'PASS', disabled_controlled_retention_policy_ids: disabledIds }, null, 2)}\n`);
  } finally {
    if (jwtId) await pool.execute('DELETE FROM USER_SESSION WHERE JWT_ID=?', [jwtId]).catch(() => {});
    await pool.end().catch(() => {});
  }
}

const runner = process.argv.includes('--post-restore-health-check')
  ? runPostRestoreHealthCheck
  : process.argv.includes('--disable-controlled-retention')
    ? disableControlledRetentionPolicies
  : process.argv.some(value => value.startsWith('--verify-backup='))
    ? verifyControlledBackup
  : process.argv.includes('--automation')
    ? runAutomationWorkflow
    : main;

runner().catch(error => {
  process.stderr.write(`[backup-e2e] FAIL: ${error.message}\n`);
  process.exitCode = 1;
});
