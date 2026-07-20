const crypto = require('crypto');
const express = require('express');
const pool = require('../config/db');
const { requireAuth, requirePermission, requireRole, ROLES } = require('./middleware');
const { encryptColumnValue, decryptColumnValue } = require('./data-protection');
const {
  BackupStepUpError,
  createBackupStepUpChallenge,
  verifyBackupStepUpChallenge,
  consumeBackupStepUpChallenge,
} = require('../services/backupStepUpService');
const {
  computeNextRunAt,
  createBackupAutomationService,
  createBackupRuntimeFromEnv,
} = require('../services/backup');

const router = express.Router();
const runtime = createBackupRuntimeFromEnv();
const backupAutomation = createBackupAutomationService({
  pool,
  runtime,
  environment: process.env,
  protectText: encryptColumnValue,
  revealText: decryptColumnValue,
  logger: console,
});

const BACKUP_TYPES = new Set(['DATABASE', 'FILES', 'CONFIGURATION', 'MODULE_STATE', 'DEPLOYMENT_VERSION', 'FULL_BACKUP']);
const STORAGE_PROVIDERS = new Set(['LOCAL', 'S3', 'RDS_SNAPSHOT', 'MANUAL']);
const RESTORE_TYPES = new Set(['DATABASE', 'FILES', 'CONFIGURATION', 'MODULE_STATE', 'FULL_BACKUP']);
const MODULES = [
  ['authentication', 'Authentication / Login', true],
  ['account_management', 'Account Management', true],
  ['rbac', 'Role and Access / RBAC', true],
  ['employee_201', 'Employee Management / 201 File', true],
  ['organization_setup', 'Organization Setup', true],
  ['onboarding', 'Applicant Onboarding', true],
  ['attendance', 'Attendance Management', true],
  ['attendance_sync', 'Attendance Sync', true],
  ['leave', 'Leave Management', true],
  ['performance', 'Performance Management', true],
  ['operational_logs', 'Operational Logs', true],
  ['payroll_settings', 'Payroll Settings', true],
  ['payroll', 'Payroll Management', true],
  ['payroll_approval', 'Payroll Approval', true],
  ['payslip', 'Payslip Generation', true],
  ['reports', 'Reports', true],
  ['self_service', 'Employee Self-Service', true],
  ['audit_trail', 'Audit Trail', false],
  ['blockchain', 'Blockchain Support', true],
  ['system_health', 'System Health', true],
  ['support_center', 'Support Center / Incident Management', true],
  ['backup_restore', 'Backup and Restore', true],
  ['file_storage', 'File Upload / Document Storage', true],
  ['notification_service', 'Notification Service', true],
];
const MODULE_MAP = new Map(MODULES.map(([key, name, rollback]) => [key, { key, name, rollback }]));
const BACKUP_TRANSITIONS = {
  PENDING: new Set(['RUNNING', 'CANCELLED']),
  RUNNING: new Set(['COMPLETED', 'FAILED']),
  COMPLETED: new Set(['VERIFIED', 'FAILED', 'CANCELLED']),
  FAILED: new Set(['RUNNING', 'CANCELLED']),
  VERIFIED: new Set(['RESTORED']),
  RESTORED: new Set([]),
  CANCELLED: new Set([]),
};
const RESTORE_TRANSITIONS = {
  AWAITING_APPROVAL: new Set(['APPROVED', 'REJECTED', 'CANCELLED']),
  APPROVED: new Set(['DRY_RUN_IN_PROGRESS', 'CANCELLED']),
  DRY_RUN_IN_PROGRESS: new Set(['DRY_RUN_PASSED', 'FAILED']),
  DRY_RUN_PASSED: new Set(['IN_PROGRESS', 'CANCELLED']),
  IN_PROGRESS: new Set(['VERIFYING', 'FAILED']),
  VERIFYING: new Set(['COMPLETED', 'FAILED']),
};
const ROLLBACK_TRANSITIONS = {
  AWAITING_APPROVAL: new Set(['APPROVED', 'REJECTED', 'CANCELLED']),
  APPROVED: new Set(['IN_PROGRESS', 'CANCELLED']),
  IN_PROGRESS: new Set(['VERIFYING', 'FAILED']),
  VERIFYING: new Set(['COMPLETED', 'FAILED']),
};

class RecoveryError extends Error {
  constructor(message, statusCode = 400, code = 'BACKUP_RECOVERY_ERROR') {
    super(message);
    this.name = 'RecoveryError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function backupDatabaseAcquireTimeoutMs() {
  const configured = Number.parseInt(process.env.BACKUP_DATABASE_ACQUIRE_TIMEOUT_MS || '10000', 10);
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 1000), 30000) : 10000;
}

/**
 * mysql2 queues pool acquisition indefinitely by default.  A queued request is
 * especially confusing in the Backup & Restore screen because its submit
 * button appears to load forever.  Bound that wait and release a connection
 * that arrives after the caller has already received the busy response.
 */
function acquireConnectionWithTimeout(getConnection, timeoutMs = backupDatabaseAcquireTimeoutMs()) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new RecoveryError(
        'Backup service is busy. Please try again in a moment.',
        503,
        'BACKUP_DATABASE_BUSY'
      ));
    }, timeoutMs);
    timer.unref?.();

    Promise.resolve()
      .then(() => getConnection())
      .then(
        connection => {
          if (settled) {
            connection?.release?.();
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(connection);
        },
        error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      );
  });
}

function acquireBackupConnection() {
  return acquireConnectionWithTimeout(
    () => pool.getConnection(),
    backupDatabaseAcquireTimeoutMs()
  );
}

function cleanText(value, maxLength = 500) {
  return String(value ?? '').trim().replace(/[<>]/g, '').slice(0, maxLength);
}

function normalizeEnum(value, allowed, fieldName) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!allowed.has(normalized)) throw new RecoveryError(`${fieldName} is invalid.`, 400, 'INVALID_BACKUP_INPUT');
  return normalized;
}

function positiveId(value, fieldName = 'id') {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new RecoveryError(`${fieldName} is invalid.`, 400, 'INVALID_BACKUP_INPUT');
  return parsed;
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function protectedText(value) {
  const text = cleanText(value, 10000);
  return text ? encryptColumnValue(text) : null;
}

function workerLease() {
  const configuredMinutes = Number.parseInt(process.env.BACKUP_WORKER_LEASE_MINUTES || '120', 10);
  const minutes = Number.isFinite(configuredMinutes) ? Math.min(Math.max(configuredMinutes, 15), 1440) : 120;
  const token = crypto.randomBytes(32).toString('base64url');
  return {
    hash: crypto.createHash('sha256').update(token, 'utf8').digest('hex'),
    minutes,
  };
}

async function recoverExpiredOperations(executor = pool) {
  const failureMessage = protectedText('Worker lease expired before the operation completed. Review logs and retry safely.');
  const results = [];
  results.push(await executor.execute(
    `UPDATE backup_sets
        SET status='FAILED', failed_at=NOW(), failure_message_encrypted=?,
            worker_lease_token_hash=NULL, worker_lease_expires_at=NULL
      WHERE status='RUNNING' AND worker_lease_expires_at IS NOT NULL AND worker_lease_expires_at < NOW()`,
    [failureMessage]
  ));
  results.push(await executor.execute(
    `UPDATE restore_jobs
        SET dry_run_status=CASE WHEN status='DRY_RUN_IN_PROGRESS' THEN 'FAILED' ELSE dry_run_status END,
            status='FAILED', integrity_status='ERROR', failed_at=NOW(), failure_message_encrypted=?,
            worker_lease_token_hash=NULL, worker_lease_expires_at=NULL
      WHERE status IN ('DRY_RUN_IN_PROGRESS','IN_PROGRESS')
        AND worker_lease_expires_at IS NOT NULL AND worker_lease_expires_at < NOW()`,
    [failureMessage]
  ));
  results.push(await executor.execute(
    `UPDATE module_rollback_requests
        SET status='FAILED', integrity_status='ERROR', failed_at=NOW(), failure_message_encrypted=?,
            worker_lease_token_hash=NULL, worker_lease_expires_at=NULL
      WHERE status='IN_PROGRESS' AND worker_lease_expires_at IS NOT NULL AND worker_lease_expires_at < NOW()`,
    [failureMessage]
  ));
  const recovered = results.reduce((total, entry) => total + Number(entry?.[0]?.affectedRows || 0), 0);
  if (recovered > 0) {
    await executor.execute(
      `INSERT INTO system_audit_log
         (user_id, employee_id, action_performed, module, new_value, ip_address, user_agent, timestamp)
       VALUES (NULL, NULL, 'RECOVER_EXPIRED_BACKUP_WORKERS', 'BACKUP_RESTORE', ?, 'system', 'backup-reaper', NOW())`,
      [JSON.stringify({ recovered_operations: recovered })]
    ).catch(() => {});
  }
  return recovered;
}

function revealText(value) {
  if (!value) return null;
  try { return decryptColumnValue(value); } catch (_) { return null; }
}

function makeReference(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function normalizeModules(value) {
  const input = Array.isArray(value) ? value : parseJson(value, []);
  const selected = [...new Set((Array.isArray(input) ? input : []).map(item => cleanText(item, 80)).filter(key => MODULE_MAP.has(key)))];
  return selected.length ? selected : [...MODULE_MAP.keys()];
}

function idempotencyKey(req) {
  const value = cleanText(req.get('Idempotency-Key') || req.body?.idempotency_key, 128);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new RecoveryError('A valid Idempotency-Key is required.', 400, 'IDEMPOTENCY_KEY_REQUIRED');
  }
  return value;
}

function requestFingerprint(kind, payload) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ kind, ...payload }), 'utf8')
    .digest('hex');
}

function assertIdempotentReplay(existing, fingerprint) {
  if (!existing || existing.request_fingerprint !== fingerprint) {
    throw new RecoveryError(
      'This Idempotency-Key was already used for a different request.',
      409,
      'IDEMPOTENCY_CONFLICT'
    );
  }
}

function sameActor(left, right) {
  return Number(left || 0) > 0 && Number(left) === Number(right || 0);
}

const DEFAULT_ADMIN_APPROVAL_POLICY = Object.freeze({
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

function adminApprovalPolicyFromCount(value) {
  const parsed = Number(value);
  const activeSystemAdminCount = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  return {
    approval_mode: 'SINGLE_ADMIN_STEP_UP',
    active_system_admin_count: activeSystemAdminCount,
    eligible_system_admin_count: activeSystemAdminCount,
    single_admin_mode: true,
    self_approval_allowed: true,
    maker_checker_required: false,
    administrator_verification_required: true,
    independent_verification_required: false,
    step_up_mfa_required: true,
  };
}

async function loadAdminApprovalPolicy(executor = pool) {
  // This workflow intentionally supports one System Administrator. The
  // authorization policy must never depend on how many admin rows happen to
  // exist, so loading it performs no database query.
  void executor;
  return { ...DEFAULT_ADMIN_APPROVAL_POLICY };
}

function approvalAuditDetails(approvalPolicy, makerUserId, actorUserId, stepUpProof = null) {
  const policy = approvalPolicy || DEFAULT_ADMIN_APPROVAL_POLICY;
  return {
    approval_mode: policy.approval_mode,
    active_system_admin_count: policy.active_system_admin_count,
    eligible_system_admin_count: policy.eligible_system_admin_count,
    maker_checker_required: policy.maker_checker_required,
    administrator_verification_required: true,
    independent_verification_required: policy.independent_verification_required,
    single_admin_mode: policy.single_admin_mode,
    maker_user_id: Number(makerUserId),
    actor_user_id: Number(actorUserId),
    same_actor_authorized: sameActor(makerUserId, actorUserId) && policy.single_admin_mode === true,
    step_up_mfa_required: true,
    step_up_challenge_id: stepUpProof?.challengeId || null,
    step_up_verified_at: stepUpProof?.verifiedAt || null,
  };
}

function assertTransition(map, current, next, entityName) {
  if (!(map[current] || new Set()).has(next)) {
    throw new RecoveryError(`${entityName} cannot move from ${current} to ${next}.`, 409, 'INVALID_LIFECYCLE_TRANSITION');
  }
}

function errorResponse(res, error, fallback) {
  const known = error instanceof RecoveryError || error instanceof BackupStepUpError || Number(error?.statusCode) >= 400;
  if (!known) console.error('[backup-recovery]', error.message);
  return res.status(known ? Number(error.statusCode || 400) : 500).json({
    error: known ? error.message : fallback,
    code: known ? error.code || 'BACKUP_RECOVERY_ERROR' : 'BACKUP_RECOVERY_FAILED',
  });
}

async function audit(executor, req, action, details = {}) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  await executor.execute(
    `INSERT INTO system_audit_log
       (user_id, employee_id, action_performed, module, new_value, ip_address, user_agent, timestamp)
     VALUES (?, ?, ?, 'BACKUP_RESTORE', ?, ?, ?, NOW())`,
    [req.user.id, req.user.employeeId || null, action, JSON.stringify(details), ip, req.headers['user-agent'] || 'unknown']
  );
}

async function recordRecoveryHealth(executor, {
  moduleKey,
  status,
  remarks,
  actorId,
  operationReference,
}) {
  if (!moduleKey || !MODULE_MAP.has(moduleKey)) return;
  const normalizedStatus = String(status || '').toUpperCase();
  if (!['ONLINE', 'WARNING', 'OFFLINE', 'MAINTENANCE'].includes(normalizedStatus)) {
    throw new RecoveryError('Recovery health status is invalid.', 500, 'RECOVERY_HEALTH_STATUS_INVALID');
  }
  const moduleName = MODULE_MAP.get(moduleKey).name;
  const safeRemarks = cleanText(remarks, 500);
  await executor.execute(
    `INSERT INTO system_health_checks
       (module_key, module_name, status, remarks, endpoint_checked, checked_by,
        last_checked_at, last_success_at, last_failure_at)
     VALUES (?, ?, ?, ?, '/api/admin/backups', ?, NOW(),
             CASE WHEN ?='ONLINE' THEN NOW() ELSE NULL END,
             CASE WHEN ?='OFFLINE' THEN NOW() ELSE NULL END)
     ON DUPLICATE KEY UPDATE
       module_name=VALUES(module_name), status=VALUES(status), remarks=VALUES(remarks),
       endpoint_checked=VALUES(endpoint_checked), checked_by=VALUES(checked_by),
       last_checked_at=NOW(),
       last_success_at=CASE WHEN VALUES(status)='ONLINE' THEN NOW() ELSE last_success_at END,
       last_failure_at=CASE WHEN VALUES(status)='OFFLINE' THEN NOW() ELSE last_failure_at END`,
    [moduleKey, moduleName, normalizedStatus, safeRemarks, actorId, normalizedStatus, normalizedStatus]
  );
  await executor.execute(
    `INSERT INTO system_health_check_history
       (run_id, module_key, module_name, status, remarks, endpoint_checked,
        trigger_type, checked_by, checked_at)
     VALUES (?, ?, ?, ?, ?, '/api/admin/backups', 'MANUAL', ?, NOW())`,
    [cleanText(`recovery-${operationReference}-${Date.now()}`, 64), moduleKey, moduleName, normalizedStatus, safeRemarks, actorId]
  );
}

function backupArtifactAvailable(row) {
  const retentionActive = !row.retention_status || row.retention_status === 'ACTIVE';
  return Boolean(
    row.storage_location_encrypted
    && row.checksum
    && retentionActive
    && !row.artifact_deleted_at
    && ['COMPLETED', 'VERIFIED', 'RESTORED'].includes(row.status)
  );
}

function backupArtifactVerified(row) {
  return Boolean(
    backupArtifactAvailable(row)
    && row.verification_status === 'MATCH'
    && row.integrity_status === 'PASSED'
    && row.verified_at
    && row.verified_by
  );
}

function backupResponse(row, actorId = null, approvalPolicy = DEFAULT_ADMIN_APPROVAL_POLICY) {
  const artifactAvailable = backupArtifactAvailable(row);
  const artifactVerified = backupArtifactVerified(row);
  const isRestorable = artifactVerified && ['VERIFIED', 'RESTORED'].includes(row.status) && row.backup_type !== 'DEPLOYMENT_VERSION';
  const includedModules = normalizeModules(parseJson(row.included_modules, []));
  const allowedActions = [];
  if (['PENDING', 'FAILED'].includes(row.status)) allowedActions.push('run');
  if (row.status === 'COMPLETED') allowedActions.push('verify');
  if (isRestorable) allowedActions.push('restore');
  if (artifactVerified && row.backup_type === 'DEPLOYMENT_VERSION') allowedActions.push('rollback');
  return {
    id: row.id,
    backup_id: row.id,
    backup_set_id: row.id,
    backup_reference: row.backup_reference,
    backup_name: row.backup_name,
    backup_type: row.backup_type,
    storage_provider: row.storage_provider,
    storage_target: row.storage_provider,
    storage_location: revealText(row.storage_location_encrypted),
    status: row.status,
    approval_status: row.approval_status,
    included_modules: includedModules,
    checksum: row.checksum,
    manifest_hash: row.checksum,
    checksum_algorithm: row.checksum_algorithm || 'SHA-256',
    verified_checksum: row.verified_checksum,
    verification_status: row.verification_status,
    integrity_status: row.integrity_status,
    artifact_format: row.artifact_format,
    artifact_available: artifactAvailable,
    artifact_verified: artifactVerified,
    is_restorable: isRestorable,
    file_size: row.file_size,
    attempt_count: Number(row.attempt_count || 0),
    created_by: row.created_by,
    created_by_username: row.created_by_username || null,
    verified_by: row.verified_by,
    verified_by_username: row.verified_by_username || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    verified_at: row.verified_at,
    restored_at: row.restored_at,
    expires_at: row.expires_at || null,
    retention_status: row.retention_status || 'ACTIVE',
    artifact_deleted_at: row.artifact_deleted_at || null,
    failed_at: row.failed_at,
    failure_message: revealText(row.failure_message_encrypted),
    remarks: revealText(row.remarks_encrypted),
    adapter_metadata: parseJson(revealText(row.adapter_metadata_encrypted), null),
    approval_policy: { ...(approvalPolicy || DEFAULT_ADMIN_APPROVAL_POLICY) },
    administrator_verification_required: true,
    independent_verification_required: (approvalPolicy || DEFAULT_ADMIN_APPROVAL_POLICY).independent_verification_required,
    maker_checker_required: (approvalPolicy || DEFAULT_ADMIN_APPROVAL_POLICY).maker_checker_required,
    allowed_actions: allowedActions,
    can_verify: allowedActions.includes('verify'),
    can_restore: allowedActions.includes('restore'),
  };
}

function restoreResponse(row, actorId = null, approvalPolicy = DEFAULT_ADMIN_APPROVAL_POLICY) {
  const allowedActions = [];
  if (row.status === 'AWAITING_APPROVAL') allowedActions.push('approve', 'reject');
  if (row.status === 'APPROVED') allowedActions.push('dry_run');
  if (row.status === 'DRY_RUN_PASSED' && row.approval_status === 'APPROVED' && row.integrity_status === 'PASSED') allowedActions.push('execute');
  if (row.status === 'VERIFYING') allowedActions.push('verify_target');
  if (['AWAITING_APPROVAL', 'APPROVED', 'DRY_RUN_PASSED'].includes(row.status)) allowedActions.push('cancel');
  return {
    id: row.id,
    restore_job_id: row.id,
    backup_set_id: row.backup_set_id,
    backup_reference: row.backup_reference,
    restore_type: row.restore_type,
    affected_module: row.affected_module,
    status: row.status,
    approval_status: row.approval_status,
    dry_run_status: row.dry_run_status,
    integrity_status: row.integrity_status,
    requested_by: row.requested_by,
    requested_by_username: row.requested_by_username,
    approved_by: row.approved_by,
    approved_by_username: row.approved_by_username,
    approved_at: row.approved_at,
    rejected_at: row.rejected_at,
    step_up_verified_at: row.step_up_verified_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    dry_run_started_at: row.dry_run_started_at,
    dry_run_completed_at: row.dry_run_completed_at,
    reason: revealText(row.reason_encrypted),
    result_message: revealText(row.result_message_encrypted),
    dry_run_result: parseJson(revealText(row.dry_run_result_encrypted), null),
    integrity_report: parseJson(revealText(row.integrity_report_encrypted), null),
    failure_message: revealText(row.failure_message_encrypted),
    created_at: row.created_at,
    approval_policy: { ...(approvalPolicy || DEFAULT_ADMIN_APPROVAL_POLICY) },
    administrator_verification_required: true,
    independent_verification_required: (approvalPolicy || DEFAULT_ADMIN_APPROVAL_POLICY).independent_verification_required,
    maker_checker_required: (approvalPolicy || DEFAULT_ADMIN_APPROVAL_POLICY).maker_checker_required,
    allowed_actions: allowedActions,
    can_approve: allowedActions.includes('approve'),
    can_dry_run: allowedActions.includes('dry_run'),
    can_execute: allowedActions.includes('execute'),
  };
}

function rollbackResponse(row, actorId = null, approvalPolicy = DEFAULT_ADMIN_APPROVAL_POLICY) {
  const artifactAvailable = Boolean(revealText(row.artifact_location_encrypted) && row.artifact_checksum);
  const artifactVerified = Boolean(artifactAvailable && row.verification_status === 'MATCH' && row.integrity_status === 'PASSED');
  const allowedActions = [];
  if (
    artifactVerified
    && row.status === 'AWAITING_APPROVAL'
  ) allowedActions.push('approve', 'reject');
  if (artifactVerified && row.status === 'APPROVED') allowedActions.push('execute');
  if (['AWAITING_APPROVAL', 'APPROVED'].includes(row.status)) allowedActions.push('cancel');
  return {
    id: row.id,
    rollback_request_id: row.id,
    recovery_point_id: row.recovery_point_id,
    affected_module: row.affected_module,
    current_version: row.current_version,
    target_version: row.target_version,
    artifact_location: revealText(row.artifact_location_encrypted),
    artifact_checksum: row.artifact_checksum,
    artifact_available: artifactAvailable,
    artifact_verified: artifactVerified,
    verification_status: row.verification_status,
    integrity_status: row.integrity_status,
    status: row.status,
    approval_status: row.approval_status,
    requested_by: row.requested_by,
    requested_by_username: row.requested_by_username,
    approved_by: row.approved_by,
    approved_by_username: row.approved_by_username,
    approved_at: row.approved_at,
    step_up_verified_at: row.step_up_verified_at,
    reason: revealText(row.reason_encrypted),
    result_message: revealText(row.result_message_encrypted),
    integrity_report: parseJson(revealText(row.integrity_report_encrypted), null),
    created_at: row.created_at,
    completed_at: row.completed_at,
    approval_policy: { ...(approvalPolicy || DEFAULT_ADMIN_APPROVAL_POLICY) },
    administrator_verification_required: true,
    independent_verification_required: (approvalPolicy || DEFAULT_ADMIN_APPROVAL_POLICY).independent_verification_required,
    maker_checker_required: (approvalPolicy || DEFAULT_ADMIN_APPROVAL_POLICY).maker_checker_required,
    allowed_actions: allowedActions,
    can_approve: allowedActions.includes('approve'),
    can_execute: allowedActions.includes('execute'),
  };
}

function recoveryPointResponse(row) {
  const verified = row.status === 'AVAILABLE'
    && row.verification_status === 'MATCH'
    && row.integrity_status === 'PASSED'
    && row.verified_at;
  return {
    id: row.id,
    recovery_point_id: row.id,
    recovery_reference: row.recovery_reference,
    module_key: row.module_key,
    module_name: row.module_name,
    current_version: row.current_version,
    stable_version: row.stable_version,
    deployment_commit: row.deployment_commit,
    artifact_location: revealText(row.artifact_location_encrypted),
    artifact_checksum: row.artifact_checksum,
    artifact_size_bytes: row.artifact_size_bytes,
    storage_provider: row.storage_provider,
    status: row.status,
    verification_status: row.verification_status,
    integrity_status: row.integrity_status,
    verified_at: row.verified_at,
    health_status_at_backup: row.health_status_at_backup,
    backup_set_id: row.backup_set_id,
    backup_reference: row.backup_reference,
    rollback_available: Boolean(row.rollback_available && verified),
    artifact_verified: Boolean(verified),
    created_by: row.created_by,
    created_by_username: row.created_by_username,
    created_at: row.created_at,
    expires_at: row.expires_at,
    remarks: revealText(row.remarks_encrypted),
  };
}

async function listBackups(actorId, limit = 100, executor = pool, approvalPolicy = null) {
  const [rows] = await executor.execute(
    `SELECT bs.*, creator.username AS created_by_username, verifier.username AS verified_by_username
       FROM backup_sets bs
       LEFT JOIN users creator ON creator.id = bs.created_by
       LEFT JOIN users verifier ON verifier.id = bs.verified_by
      ORDER BY bs.created_at DESC, bs.id DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 200)}`
  );
  const policy = approvalPolicy || await loadAdminApprovalPolicy(executor);
  return rows.map(row => backupResponse(row, actorId, policy));
}

async function listRecoveryPoints(limit = 100, executor = pool) {
  const [rows] = await executor.execute(
    `SELECT mrp.*, bs.backup_reference, creator.username AS created_by_username
       FROM module_recovery_points mrp
       LEFT JOIN backup_sets bs ON bs.id = mrp.backup_set_id
       LEFT JOIN users creator ON creator.id = mrp.created_by
      ORDER BY mrp.created_at DESC, mrp.id DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 200)}`
  );
  return rows.map(recoveryPointResponse);
}

async function listRestoreJobs(actorId, limit = 100, executor = pool, approvalPolicy = null) {
  const [rows] = await executor.execute(
    `SELECT rj.*, bs.backup_reference,
            requester.username AS requested_by_username,
            approver.username AS approved_by_username
       FROM restore_jobs rj
       JOIN backup_sets bs ON bs.id = rj.backup_set_id
       LEFT JOIN users requester ON requester.id = rj.requested_by
       LEFT JOIN users approver ON approver.id = rj.approved_by
      ORDER BY rj.created_at DESC, rj.id DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 200)}`
  );
  const policy = approvalPolicy || await loadAdminApprovalPolicy(executor);
  return rows.map(row => restoreResponse(row, actorId, policy));
}

async function listRollbackRequests(actorId, limit = 100, executor = pool, approvalPolicy = null) {
  const [rows] = await executor.execute(
    `SELECT mrr.*, requester.username AS requested_by_username,
            approver.username AS approved_by_username
       FROM module_rollback_requests mrr
       LEFT JOIN users requester ON requester.id = mrr.requested_by
       LEFT JOIN users approver ON approver.id = mrr.approved_by
      ORDER BY mrr.created_at DESC, mrr.id DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 200)}`
  );
  const policy = approvalPolicy || await loadAdminApprovalPolicy(executor);
  return rows.map(row => rollbackResponse(row, actorId, policy));
}

function requestedPagination(query = {}) {
  return ['page', 'page_size', 'search', 'status', 'type', 'module'].some(key => query[key] !== undefined);
}

function paginationOptions(query = {}) {
  const pageValue = Number.parseInt(query.page || '1', 10);
  const sizeValue = Number.parseInt(query.page_size || '20', 10);
  const page = Number.isFinite(pageValue) ? Math.min(Math.max(pageValue, 1), 1000000) : 1;
  const pageSize = Number.isFinite(sizeValue) ? Math.min(Math.max(sizeValue, 5), 100) : 20;
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    search: cleanText(query.search, 120),
    status: cleanText(query.status || 'ALL', 40).toUpperCase(),
    type: cleanText(query.type || 'ALL', 40).toUpperCase(),
    module: cleanText(query.module, 80),
  };
}

function paginatedResult(items, total, options) {
  const totalItems = Number(total || 0);
  const totalPages = Math.max(Math.ceil(totalItems / options.pageSize), 1);
  return {
    items,
    pagination: {
      page: options.page,
      page_size: options.pageSize,
      total_items: totalItems,
      total_pages: totalPages,
      has_previous: options.page > 1,
      has_next: options.page < totalPages,
    },
  };
}

function clampPaginationToTotal(options, total) {
  const totalPages = Math.max(Math.ceil(Number(total || 0) / options.pageSize), 1);
  if (options.page > totalPages) options.page = totalPages;
  options.offset = (options.page - 1) * options.pageSize;
  return options;
}

function addSearchClause(where, params, search, columns) {
  if (!search) return;
  const pattern = `%${search}%`;
  where.push(`(${columns.map(column => `${column} LIKE ?`).join(' OR ')})`);
  columns.forEach(() => params.push(pattern));
}

async function listBackupsPaginated(actorId, query = {}, executor = pool, approvalPolicy = null) {
  const options = paginationOptions(query);
  const where = [];
  const params = [];
  addSearchClause(where, params, options.search, [
    'bs.backup_reference', 'bs.backup_name', 'bs.backup_type', 'bs.storage_provider',
    'bs.included_modules', 'creator.username',
  ]);
  if (options.status !== 'ALL') {
    if (!Object.prototype.hasOwnProperty.call(BACKUP_TRANSITIONS, options.status) && !['RESTORED', 'CANCELLED'].includes(options.status)) {
      throw new RecoveryError('Backup status filter is invalid.', 400, 'INVALID_BACKUP_FILTER');
    }
    where.push('bs.status = ?');
    params.push(options.status);
  }
  if (options.type !== 'ALL') {
    if (!BACKUP_TYPES.has(options.type)) throw new RecoveryError('Backup type filter is invalid.', 400, 'INVALID_BACKUP_FILTER');
    where.push('bs.backup_type = ?');
    params.push(options.type);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[countRow]] = await executor.execute(
    `SELECT COUNT(*) AS total
       FROM backup_sets bs
       LEFT JOIN users creator ON creator.id = bs.created_by
       ${whereSql}`,
    params
  );
  clampPaginationToTotal(options, countRow.total);
  const [rows] = await executor.execute(
    `SELECT bs.*, creator.username AS created_by_username, verifier.username AS verified_by_username
       FROM backup_sets bs
       LEFT JOIN users creator ON creator.id = bs.created_by
       LEFT JOIN users verifier ON verifier.id = bs.verified_by
       ${whereSql}
      ORDER BY bs.created_at DESC, bs.id DESC
      LIMIT ${options.pageSize} OFFSET ${options.offset}`,
    params
  );
  const policy = approvalPolicy || await loadAdminApprovalPolicy(executor);
  return paginatedResult(rows.map(row => backupResponse(row, actorId, policy)), countRow.total, options);
}

async function listRecoveryPointsPaginated(query = {}, executor = pool) {
  const options = paginationOptions(query);
  const where = [];
  const params = [];
  addSearchClause(where, params, options.search, [
    'mrp.recovery_reference', 'mrp.module_key', 'mrp.module_name', 'bs.backup_reference',
  ]);
  if (options.module) {
    where.push('mrp.module_key = ?');
    params.push(options.module);
  }
  if (options.status !== 'ALL') {
    const statusMap = { READY: 1, NOT_READY: 0 };
    if (!Object.prototype.hasOwnProperty.call(statusMap, options.status)) {
      throw new RecoveryError('Recovery readiness filter is invalid.', 400, 'INVALID_BACKUP_FILTER');
    }
    where.push(statusMap[options.status]
      ? "(mrp.status='AVAILABLE' AND mrp.rollback_available=1 AND mrp.verification_status='MATCH' AND mrp.integrity_status='PASSED' AND mrp.verified_at IS NOT NULL)"
      : "(mrp.status<>'AVAILABLE' OR mrp.rollback_available<>1 OR mrp.verification_status<>'MATCH' OR mrp.integrity_status<>'PASSED' OR mrp.verified_at IS NULL)");
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[countRow]] = await executor.execute(
    `SELECT COUNT(*) AS total
       FROM module_recovery_points mrp
       LEFT JOIN backup_sets bs ON bs.id = mrp.backup_set_id
       ${whereSql}`,
    params
  );
  clampPaginationToTotal(options, countRow.total);
  const [rows] = await executor.execute(
    `SELECT mrp.*, bs.backup_reference, creator.username AS created_by_username
       FROM module_recovery_points mrp
       LEFT JOIN backup_sets bs ON bs.id = mrp.backup_set_id
       LEFT JOIN users creator ON creator.id = mrp.created_by
       ${whereSql}
      ORDER BY mrp.created_at DESC, mrp.id DESC
      LIMIT ${options.pageSize} OFFSET ${options.offset}`,
    params
  );
  return paginatedResult(rows.map(recoveryPointResponse), countRow.total, options);
}

async function listRestoreJobsPaginated(actorId, query = {}, executor = pool, approvalPolicy = null) {
  const options = paginationOptions(query);
  const where = [];
  const params = [];
  addSearchClause(where, params, options.search, [
    'bs.backup_reference', 'rj.restore_type', 'rj.affected_module', 'requester.username',
  ]);
  if (options.status !== 'ALL') {
    if (!Object.prototype.hasOwnProperty.call(RESTORE_TRANSITIONS, options.status) && !['COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED'].includes(options.status)) {
      throw new RecoveryError('Restore status filter is invalid.', 400, 'INVALID_BACKUP_FILTER');
    }
    where.push('rj.status = ?');
    params.push(options.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const joins = `FROM restore_jobs rj
       JOIN backup_sets bs ON bs.id = rj.backup_set_id
       LEFT JOIN users requester ON requester.id = rj.requested_by
       LEFT JOIN users approver ON approver.id = rj.approved_by`;
  const [[countRow]] = await executor.execute(`SELECT COUNT(*) AS total ${joins} ${whereSql}`, params);
  clampPaginationToTotal(options, countRow.total);
  const [rows] = await executor.execute(
    `SELECT rj.*, bs.backup_reference,
            requester.username AS requested_by_username,
            approver.username AS approved_by_username
       ${joins} ${whereSql}
      ORDER BY rj.created_at DESC, rj.id DESC
      LIMIT ${options.pageSize} OFFSET ${options.offset}`,
    params
  );
  const policy = approvalPolicy || await loadAdminApprovalPolicy(executor);
  return paginatedResult(rows.map(row => restoreResponse(row, actorId, policy)), countRow.total, options);
}

async function listRollbackRequestsPaginated(actorId, query = {}, executor = pool, approvalPolicy = null) {
  const options = paginationOptions(query);
  const where = [];
  const params = [];
  addSearchClause(where, params, options.search, [
    'mrr.affected_module', 'mrr.current_version', 'mrr.target_version', 'requester.username',
  ]);
  if (options.status !== 'ALL') {
    if (!Object.prototype.hasOwnProperty.call(ROLLBACK_TRANSITIONS, options.status) && !['COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED'].includes(options.status)) {
      throw new RecoveryError('Rollback status filter is invalid.', 400, 'INVALID_BACKUP_FILTER');
    }
    where.push('mrr.status = ?');
    params.push(options.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const joins = `FROM module_rollback_requests mrr
       LEFT JOIN users requester ON requester.id = mrr.requested_by
       LEFT JOIN users approver ON approver.id = mrr.approved_by`;
  const [[countRow]] = await executor.execute(`SELECT COUNT(*) AS total ${joins} ${whereSql}`, params);
  clampPaginationToTotal(options, countRow.total);
  const [rows] = await executor.execute(
    `SELECT mrr.*, requester.username AS requested_by_username,
            approver.username AS approved_by_username
       ${joins} ${whereSql}
      ORDER BY mrr.created_at DESC, mrr.id DESC
      LIMIT ${options.pageSize} OFFSET ${options.offset}`,
    params
  );
  const policy = approvalPolicy || await loadAdminApprovalPolicy(executor);
  return paginatedResult(rows.map(row => rollbackResponse(row, actorId, policy)), countRow.total, options);
}

const AUTOMATION_FREQUENCIES = new Set(['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY']);

function booleanInput(value, fallback = false) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (value === true || value === 1 || ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
  if (value === false || value === 0 || ['false', '0', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  throw new RecoveryError('Boolean setting is invalid.', 400, 'INVALID_AUTOMATION_INPUT');
}

function nullablePositiveId(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  return positiveId(value, fieldName);
}

function normalizeRunTime(value, required) {
  const raw = String(value || '').trim();
  if (!raw && !required) return null;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(raw)) {
    throw new RecoveryError('run_time must use 24-hour HH:mm format.', 400, 'INVALID_AUTOMATION_TIME');
  }
  return raw.length === 5 ? `${raw}:00` : raw;
}

function normalizeAutomationTiming(input = {}) {
  const frequency = normalizeEnum(input.frequency || 'DAILY', AUTOMATION_FREQUENCIES, 'frequency');
  const runTime = normalizeRunTime(input.run_time, frequency !== 'HOURLY');
  const dayOfWeek = frequency === 'WEEKLY' ? Number(input.day_of_week) : null;
  const dayOfMonth = frequency === 'MONTHLY' ? Number(input.day_of_month) : null;
  if (frequency === 'WEEKLY' && (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7)) {
    throw new RecoveryError('day_of_week must be 1 (Monday) through 7 (Sunday).', 400, 'INVALID_AUTOMATION_DAY');
  }
  if (frequency === 'MONTHLY' && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31)) {
    throw new RecoveryError('day_of_month must be between 1 and 31.', 400, 'INVALID_AUTOMATION_DAY');
  }
  const timezone = cleanText(input.timezone || 'Asia/Manila', 64);
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date()); }
  catch (_) { throw new RecoveryError('Timezone is invalid.', 400, 'INVALID_AUTOMATION_TIMEZONE'); }
  return {
    frequency,
    run_time: runTime,
    day_of_week: dayOfWeek,
    day_of_month: dayOfMonth,
    timezone,
  };
}

function automationNextRun(timing, enabled) {
  if (!enabled) return null;
  const next = computeNextRunAt(timing, new Date());
  if (!(next instanceof Date) || Number.isNaN(next.getTime())) {
    throw new RecoveryError('Unable to calculate the next automation run.', 400, 'INVALID_AUTOMATION_TIME');
  }
  return next;
}

function scheduleResponse(row) {
  return {
    id: row.id,
    schedule_id: row.id,
    schedule_reference: row.schedule_reference,
    schedule_name: row.name,
    name: row.name,
    backup_type: row.backup_type,
    storage_provider: row.storage_provider,
    included_modules: normalizeModules(parseJson(row.included_modules, [])),
    frequency: row.frequency,
    run_time: row.run_time,
    day_of_week: row.day_of_week,
    day_of_month: row.day_of_month,
    timezone: row.timezone,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    last_status: row.last_status,
    enabled: Boolean(row.enabled),
    retention_policy_id: row.retention_policy_id,
    created_by: row.created_by,
    created_by_username: row.created_by_username || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function retentionPolicyResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    policy_id: row.id,
    policy_reference: row.policy_reference,
    policy_name: row.policy_name,
    backup_type: row.backup_type || 'ALL',
    storage_provider: row.storage_provider || 'ALL',
    keep_last: Number(row.keep_last),
    max_age_days: Number(row.max_age_days),
    delete_expired_artifacts: Boolean(row.delete_expired_artifacts),
    enabled: Boolean(row.enabled),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function drillScheduleResponse(row) {
  const latestResult = row.latest_result_message_encrypted
    ? parseJson(revealText(row.latest_result_message_encrypted), null)
    : null;
  const latestFailure = row.latest_failure_message_encrypted
    ? revealText(row.latest_failure_message_encrypted)
    : null;
  return {
    id: row.id,
    drill_id: row.id,
    schedule_reference: row.schedule_reference,
    drill_name: row.name,
    name: row.name,
    selection_strategy: row.selection_strategy,
    backup_type: row.backup_type_filter || 'ALL',
    storage_provider: row.storage_provider_filter || 'ALL',
    affected_module: row.module_key_filter || null,
    frequency: row.frequency,
    run_time: row.run_time,
    day_of_week: row.day_of_week,
    day_of_month: row.day_of_month,
    timezone: row.timezone,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    last_status: row.last_status,
    enabled: Boolean(row.enabled),
    latest_run_id: row.latest_run_id || null,
    latest_run_status: row.latest_run_status || null,
    latest_integrity_status: row.latest_integrity_status || null,
    latest_result_message: latestResult,
    latest_failure_message: latestFailure,
    latest_completed_at: row.latest_completed_at || null,
    latest_run: row.latest_run_id ? {
      id: row.latest_run_id,
      run_id: row.latest_run_id,
      backup_set_id: row.latest_backup_set_id || null,
      status: row.latest_run_status || null,
      integrity_status: row.latest_integrity_status || null,
      result: latestResult,
      failure_message: latestFailure,
      completed_at: row.latest_completed_at || null,
    } : null,
    created_by: row.created_by,
    created_by_username: row.created_by_username || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function notificationResponse(row) {
  return {
    id: row.id,
    notification_id: row.id,
    category: row.category,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    action_required: Boolean(row.action_required),
    title: row.title,
    message: row.message,
    status: row.status,
    read_at: row.read_at,
    resolved_at: row.resolved_at,
    created_at: row.created_at,
    action_tab: row.resource_type === 'BACKUP_SET'
      ? 'sets'
      : row.resource_type === 'RESTORE_JOB'
        ? 'restore'
        : row.resource_type === 'ROLLBACK_REQUEST'
          ? 'rollback'
          : row.resource_type === 'RESTORE_DRILL'
            ? 'settings'
            : 'overview',
  };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function integerInRange(value, minimum, maximum, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RecoveryError(`${fieldName} must be between ${minimum} and ${maximum}.`, 400, 'INVALID_AUTOMATION_INPUT');
  }
  return parsed;
}

function normalizeRequiredModules(value) {
  const input = Array.isArray(value) ? value : parseJson(value, null);
  if (!Array.isArray(input) || !input.length) {
    throw new RecoveryError('At least one valid module is required.', 400, 'INVALID_BACKUP_MODULE');
  }
  const modules = [...new Set(input.map(item => cleanText(item, 80)))];
  if (modules.some(moduleKey => !MODULE_MAP.has(moduleKey))) {
    throw new RecoveryError('One or more included modules are invalid.', 400, 'INVALID_BACKUP_MODULE');
  }
  return modules;
}

function normalizeExecutableProvider(value, backupType) {
  const provider = normalizeEnum(value || 'LOCAL', STORAGE_PROVIDERS, 'storage_provider');
  if (provider === 'MANUAL') {
    throw new RecoveryError('Select LOCAL, S3, or RDS_SNAPSHOT for executable backups.', 400, 'EXECUTABLE_BACKUP_PROVIDER_REQUIRED');
  }
  if (provider === 'RDS_SNAPSHOT' && backupType !== 'DATABASE') {
    throw new RecoveryError('RDS snapshots can only be scheduled for DATABASE backups.', 400, 'BACKUP_PROVIDER_TYPE_MISMATCH');
  }
  return provider;
}

function scheduleMutation(body = {}, existing = null) {
  const name = cleanText(
    hasOwn(body, 'schedule_name') ? body.schedule_name : (hasOwn(body, 'name') ? body.name : existing?.name),
    160
  );
  if (name.length < 3) throw new RecoveryError('Schedule name must contain at least 3 characters.', 400, 'INVALID_AUTOMATION_INPUT');
  const backupType = normalizeEnum(
    hasOwn(body, 'backup_type') ? body.backup_type : existing?.backup_type,
    BACKUP_TYPES,
    'backup_type'
  );
  const storageProvider = normalizeExecutableProvider(
    hasOwn(body, 'storage_provider') ? body.storage_provider : existing?.storage_provider,
    backupType
  );
  const includedModules = normalizeRequiredModules(
    hasOwn(body, 'included_modules') ? body.included_modules : parseJson(existing?.included_modules, [])
  );
  const timing = normalizeAutomationTiming({
    frequency: hasOwn(body, 'frequency') ? body.frequency : existing?.frequency,
    run_time: hasOwn(body, 'run_time') ? body.run_time : existing?.run_time,
    day_of_week: hasOwn(body, 'day_of_week') ? body.day_of_week : existing?.day_of_week,
    day_of_month: hasOwn(body, 'day_of_month') ? body.day_of_month : existing?.day_of_month,
    timezone: hasOwn(body, 'timezone') ? body.timezone : existing?.timezone,
  });
  const enabled = booleanInput(hasOwn(body, 'enabled') ? body.enabled : existing?.enabled, true);
  const retentionPolicyId = hasOwn(body, 'retention_policy_id')
    ? nullablePositiveId(body.retention_policy_id, 'retention_policy_id')
    : (existing?.retention_policy_id || null);
  return {
    name,
    backup_type: backupType,
    storage_provider: storageProvider,
    included_modules: includedModules,
    ...timing,
    enabled,
    retention_policy_id: retentionPolicyId,
    next_run_at: automationNextRun(timing, enabled),
  };
}

function retentionMutation(body = {}, existing = null) {
  const policyName = cleanText(
    hasOwn(body, 'policy_name') ? body.policy_name : existing?.policy_name,
    160
  );
  if (policyName.length < 3) throw new RecoveryError('Policy name must contain at least 3 characters.', 400, 'INVALID_AUTOMATION_INPUT');
  const rawType = String(hasOwn(body, 'backup_type') ? body.backup_type : (existing?.backup_type || 'ALL')).trim().toUpperCase();
  const rawProvider = String(hasOwn(body, 'storage_provider') ? body.storage_provider : (existing?.storage_provider || 'ALL')).trim().toUpperCase();
  const backupType = rawType === 'ALL' ? null : normalizeEnum(rawType, BACKUP_TYPES, 'backup_type');
  const storageProvider = rawProvider === 'ALL'
    ? null
    : normalizeExecutableProvider(rawProvider, backupType || 'DATABASE');
  if (storageProvider === 'RDS_SNAPSHOT' && backupType && backupType !== 'DATABASE') {
    throw new RecoveryError('RDS retention can only target DATABASE snapshot backups.', 400, 'BACKUP_PROVIDER_TYPE_MISMATCH');
  }
  return {
    policy_name: policyName,
    backup_type: backupType,
    storage_provider: storageProvider,
    keep_last: integerInRange(hasOwn(body, 'keep_last') ? body.keep_last : existing?.keep_last, 1, 1000, 'keep_last'),
    max_age_days: integerInRange(hasOwn(body, 'max_age_days') ? body.max_age_days : existing?.max_age_days, 1, 3650, 'max_age_days'),
    delete_expired_artifacts: booleanInput(
      hasOwn(body, 'delete_expired_artifacts') ? body.delete_expired_artifacts : existing?.delete_expired_artifacts,
      false
    ),
    enabled: booleanInput(hasOwn(body, 'enabled') ? body.enabled : existing?.enabled, false),
  };
}

function drillMutation(body = {}, existing = null) {
  const name = cleanText(
    hasOwn(body, 'drill_name') ? body.drill_name : (hasOwn(body, 'name') ? body.name : existing?.name),
    160
  );
  if (name.length < 3) throw new RecoveryError('Drill name must contain at least 3 characters.', 400, 'INVALID_AUTOMATION_INPUT');
  const rawType = String(
    hasOwn(body, 'backup_type')
      ? body.backup_type
      : (existing ? (existing.backup_type_filter || 'ALL') : 'DATABASE')
  ).trim().toUpperCase();
  const backupType = rawType === 'ALL' ? null : normalizeEnum(rawType, BACKUP_TYPES, 'backup_type');
  if (backupType === 'DEPLOYMENT_VERSION') {
    throw new RecoveryError('Deployment artifacts use the controlled rollback workflow, not restore drills.', 400, 'INVALID_RESTORE_DRILL_TYPE');
  }
  const rawProvider = String(
    hasOwn(body, 'storage_provider') ? body.storage_provider : (existing?.storage_provider_filter || 'ALL')
  ).trim().toUpperCase();
  const storageProvider = rawProvider === 'ALL'
    ? null
    : normalizeEnum(rawProvider, new Set(['LOCAL', 'S3', 'RDS_SNAPSHOT']), 'storage_provider');
  if (storageProvider === 'RDS_SNAPSHOT' && backupType && backupType !== 'DATABASE') {
    throw new RecoveryError('RDS restore drills can only select DATABASE snapshots.', 400, 'BACKUP_PROVIDER_TYPE_MISMATCH');
  }
  const rawModule = hasOwn(body, 'affected_module') ? body.affected_module : existing?.module_key_filter;
  const moduleKey = cleanText(rawModule, 80) || null;
  if (moduleKey && !MODULE_MAP.has(moduleKey)) throw new RecoveryError('Affected module is invalid.', 400, 'INVALID_BACKUP_MODULE');
  const timing = normalizeAutomationTiming({
    frequency: hasOwn(body, 'frequency') ? body.frequency : existing?.frequency,
    run_time: hasOwn(body, 'run_time') ? body.run_time : existing?.run_time,
    day_of_week: hasOwn(body, 'day_of_week') ? body.day_of_week : existing?.day_of_week,
    day_of_month: hasOwn(body, 'day_of_month') ? body.day_of_month : existing?.day_of_month,
    timezone: hasOwn(body, 'timezone') ? body.timezone : existing?.timezone,
  });
  const enabled = booleanInput(hasOwn(body, 'enabled') ? body.enabled : existing?.enabled, true);
  return {
    name,
    backup_type_filter: backupType,
    storage_provider_filter: storageProvider,
    module_key_filter: moduleKey,
    ...timing,
    enabled,
    next_run_at: automationNextRun(timing, enabled),
  };
}

async function assertRetentionPolicyExists(executor, policyId) {
  if (!policyId) return;
  const [rows] = await executor.execute('SELECT id FROM backup_retention_policies WHERE id=? LIMIT 1', [policyId]);
  if (!rows.length) throw new RecoveryError('Retention policy was not found.', 404, 'RETENTION_POLICY_NOT_FOUND');
}

async function claimAutomationAction(connection, req, {
  actionType,
  resourceType,
  resourceId,
  purpose,
  fingerprintPayload = null,
}) {
  const key = idempotencyKey(req);
  const fingerprint = requestFingerprint('BACKUP_AUTOMATION_ACTION', {
    actionType,
    actorId: Number(req.user.id),
    resourceId: Number(resourceId),
    resourceType,
    payload: fingerprintPayload,
  });
  const [existingRows] = await connection.execute(
    'SELECT * FROM backup_automation_action_requests WHERE idempotency_key=? FOR UPDATE',
    [key]
  );
  const existing = existingRows[0] || null;
  if (existing) assertIdempotentReplay(existing, fingerprint);

  const proof = await consumeBackupStepUpChallenge(connection, req, {
    challengeId: req.body?.step_up_challenge_id,
    challengeToken: req.body?.step_up_token,
    purpose,
    resourceType,
    resourceId,
  });

  if (existing?.status === 'COMPLETED') {
    return {
      actionId: Number(existing.id),
      idempotencyKey: key,
      operationTime: existing.operation_time,
      replay: true,
      result: parseJson(existing.result_json, {}),
    };
  }
  if (existing?.status === 'IN_PROGRESS') {
    const staleAfterMs = Math.max(15, Math.min(Number(process.env.BACKUP_WORKER_LEASE_MINUTES || 120), 1440)) * 60 * 1000;
    const updatedAt = new Date(existing.updated_at).getTime();
    if (Number.isFinite(updatedAt) && Date.now() - updatedAt < staleAfterMs) {
      throw new RecoveryError('This protected action is already in progress.', 409, 'AUTOMATION_ACTION_IN_PROGRESS');
    }
  }

  if (existing) {
    const retryTime = existing.status === 'FAILED' ? new Date() : existing.operation_time;
    await connection.execute(
      `UPDATE backup_automation_action_requests
          SET status='IN_PROGRESS', operation_time=?, result_json=NULL, failure_code=NULL,
              requested_by=?, step_up_challenge_id=?, completed_at=NULL, failed_at=NULL, updated_at=NOW()
        WHERE id=?`,
      [retryTime, req.user.id, proof.challengeId, existing.id]
    );
    return {
      actionId: Number(existing.id),
      idempotencyKey: key,
      operationTime: retryTime,
      replay: false,
      retried: true,
    };
  }

  const operationTime = new Date();
  const [insert] = await connection.execute(
    `INSERT INTO backup_automation_action_requests
       (idempotency_key,request_fingerprint,action_type,resource_type,resource_id,status,
        operation_time,requested_by,step_up_challenge_id)
     VALUES (?,?,?,?,?,'IN_PROGRESS',?,?,?)`,
    [key, fingerprint, actionType, resourceType, resourceId, operationTime, req.user.id, proof.challengeId]
  );
  return {
    actionId: Number(insert.insertId),
    idempotencyKey: key,
    operationTime,
    replay: false,
    retried: false,
  };
}

async function completeAutomationAction(actionId, result) {
  const safeResult = JSON.stringify(result || {});
  const [update] = await pool.execute(
    `UPDATE backup_automation_action_requests
        SET status='COMPLETED',result_json=?,completed_at=NOW(),failed_at=NULL,failure_code=NULL,updated_at=NOW()
      WHERE id=? AND status='IN_PROGRESS'`,
    [safeResult, actionId]
  );
  if (update.affectedRows !== 1) {
    throw new RecoveryError('Protected action completion could not be recorded.', 409, 'AUTOMATION_ACTION_STATE_CONFLICT');
  }
}

async function failAutomationAction(actionId, error) {
  const code = cleanText(error?.code || 'BACKUP_AUTOMATION_FAILED', 80).replace(/[^A-Za-z0-9_:-]/g, '_') || 'BACKUP_AUTOMATION_FAILED';
  await pool.execute(
    `UPDATE backup_automation_action_requests
        SET status='FAILED',failure_code=?,failed_at=NOW(),completed_at=NULL,result_json=NULL,updated_at=NOW()
      WHERE id=? AND status='IN_PROGRESS'`,
    [code, actionId]
  ).catch(() => {});
}

async function buildCoverage(actorId, approvalPolicy = null) {
  const [backups, recoveryPoints, healthRows] = await Promise.all([
    listBackups(actorId, 200, pool, approvalPolicy),
    listRecoveryPoints(200),
    pool.execute('SELECT module_key, status, last_checked_at FROM system_health_checks').then(([rows]) => rows).catch(() => []),
  ]);
  const verifiedBackups = backups.filter(item => item.artifact_verified);
  const healthMap = new Map(healthRows.map(row => [row.module_key, row]));
  const fileModules = new Set(['employee_201', 'payslip', 'file_storage']);
  return [...MODULE_MAP.values()].map(module => {
    const backup = verifiedBackups.find(item => item.backup_type === 'FULL_BACKUP' || item.included_modules.includes(module.key)) || null;
    const point = recoveryPoints.find(item => item.module_key === module.key && item.artifact_verified) || null;
    const healthKey = module.key === 'system_health' ? 'backup_restore' : module.key;
    const health = healthMap.get(healthKey) || null;
    const dataCovered = Boolean(backup && ['DATABASE', 'MODULE_STATE', 'FULL_BACKUP'].includes(backup.backup_type));
    const fileApplicable = fileModules.has(module.key);
    const filesCovered = Boolean(backup && ['FILES', 'FULL_BACKUP'].includes(backup.backup_type));
    const configCovered = Boolean(backup && ['CONFIGURATION', 'MODULE_STATE', 'FULL_BACKUP'].includes(backup.backup_type));
    return {
      module_key: module.key,
      module_name: module.name,
      data_backup_coverage: dataCovered ? 'Covered' : 'Not Covered',
      file_backup_coverage: fileApplicable ? (filesCovered ? 'Covered' : 'Not Covered') : 'Not Applicable',
      config_backup_coverage: configCovered ? 'Covered' : 'Not Covered',
      recovery_point_available: Boolean(point),
      current_version: point?.current_version || process.env.APP_VERSION || '1.0.0',
      stable_version: point?.stable_version || process.env.APP_VERSION || '1.0.0',
      last_known_stable_version: point?.stable_version || null,
      last_backup_timestamp: backup?.verified_at || null,
      last_backup_type: backup?.backup_type || null,
      last_health_status: health?.status || point?.health_status_at_backup || 'UNKNOWN',
      under_maintenance: health?.status === 'MAINTENANCE',
      recovery_point_id: point?.id || null,
      backup_set_id: backup?.id || null,
      artifact_available: Boolean(backup?.artifact_available),
      artifact_verified: Boolean(backup?.artifact_verified),
      is_restorable: Boolean(backup?.is_restorable),
      rollback_available: Boolean(module.rollback && point?.rollback_available),
      allowed_actions: [
        ...(backup?.is_restorable ? ['restore'] : []),
        ...(module.rollback && point?.rollback_available ? ['rollback'] : []),
      ],
      recommended_action: backup
        ? 'Keep the verified artifact and recovery test current.'
        : 'Create and verify a backup artifact with fresh step-up MFA.',
    };
  });
}

async function buildOverview(actorId) {
  const approvalPolicy = await loadAdminApprovalPolicy(pool);
  const [backups, restoreJobs, rollbackRequests, recoveryPoints, coverage, summaryRows] = await Promise.all([
    listBackups(actorId, 200, pool, approvalPolicy),
    listRestoreJobs(actorId, 50, pool, approvalPolicy),
    listRollbackRequests(actorId, 50, pool, approvalPolicy),
    listRecoveryPoints(50),
    buildCoverage(actorId, approvalPolicy),
    pool.execute(
      `SELECT COUNT(*) AS total_backup_sets,
              SUM(CASE WHEN status IN ('VERIFIED','RESTORED')
                            AND verification_status='MATCH' AND integrity_status='PASSED'
                            AND verified_at IS NOT NULL AND verified_by IS NOT NULL
                            AND storage_location_encrypted IS NOT NULL AND checksum IS NOT NULL
                            AND retention_status='ACTIVE' AND artifact_deleted_at IS NULL
                       THEN 1 ELSE 0 END) AS verified_backup_sets,
              SUM(CASE WHEN status='FAILED' OR verification_status IN ('MISMATCH','ERROR')
                       THEN 1 ELSE 0 END) AS failed_backup_jobs,
              SUM(CASE WHEN status IN ('PENDING','RUNNING','COMPLETED') THEN 1 ELSE 0 END) AS active_backup_jobs
         FROM backup_sets`
    ).then(([rows]) => rows).catch(() => []),
  ]);
  const aggregate = summaryRows[0] || {};
  const verified = backups.filter(item => item.artifact_verified);
  const latest = type => verified.find(item => item.backup_type === type) || null;
  const failed = Number(aggregate.failed_backup_jobs || 0);
  const active = Number(aggregate.active_backup_jobs || 0);
  const totalBackupSets = Number(aggregate.total_backup_sets || 0);
  const verifiedBackupSets = Number(aggregate.verified_backup_sets || 0);
  const providerReadiness = backupAutomation.providerReadiness();
  return {
    generated_at: new Date().toISOString(),
    status: failed ? 'Failed' : verifiedBackupSets ? (active ? 'Warning' : 'Healthy') : 'Warning',
    cards: {
      latest_database_backup: latest('DATABASE'),
      latest_file_backup: latest('FILES'),
      latest_configuration_backup: latest('CONFIGURATION'),
      latest_module_recovery_point: recoveryPoints.find(item => item.artifact_verified) || null,
      latest_deployment_version: latest('DEPLOYMENT_VERSION'),
      backup_status: failed ? 'Failed' : verifiedBackupSets ? 'Healthy' : 'Warning',
      total_backup_sets: totalBackupSets,
      verified_backup_sets: verifiedBackupSets,
      failed_backup_jobs: failed,
      last_restore_attempt: restoreJobs[0] || null,
    },
    coverage,
    backup_sets: backups.slice(0, 20),
    restore_jobs: restoreJobs,
    rollback_requests: rollbackRequests,
    settings: {
      database_provider: process.env.AWS_RDS_DB_INSTANCE_IDENTIFIER ? 'RDS snapshot adapter' : 'Local MySQL dump adapter',
      file_provider: process.env.AWS_S3_BUCKET ? 'Amazon S3 adapter' : 'Private local storage adapter',
      config_provider: 'Encrypted non-secret configuration artifact',
      deployment_provider: process.env.AWS_S3_BUCKET
        ? 'Encrypted Amazon S3 source-code artifact'
        : 'Encrypted local source-code artifact',
      source_code_backup_configured: true,
      module_code_cutover_enabled: String(process.env.NODE_ENV || 'development').toLowerCase() !== 'production'
        || String(process.env.BACKUP_CODE_CUTOVER_ENABLED || '').toLowerCase() === 'true',
      aws_region_configured: Boolean(process.env.AWS_REGION),
      s3_bucket_configured: Boolean(process.env.AWS_S3_BUCKET),
      rds_snapshot_configured: Boolean(process.env.AWS_RDS_DB_INSTANCE_IDENTIFIER),
      rds_restore_verification_configured: Boolean(
        process.env.BACKUP_RDS_VERIFY_DB_USER
        && process.env.BACKUP_RDS_VERIFY_DB_PASSWORD
        && process.env.BACKUP_RDS_VERIFY_DB_NAME
        && String(process.env.BACKUP_RDS_VERIFY_DB_SSL || '').toLowerCase() === 'true'
      ),
      live_restore_enabled: String(process.env.BACKUP_LIVE_RESTORE_ENABLED || '').toLowerCase() === 'true',
      backup_worker_enabled: true,
      local_adapter_configured: true,
      isolated_restore_configured: Boolean(
        process.env.BACKUP_DRY_RUN_DB_HOST
        && process.env.BACKUP_DRY_RUN_DB_USER
        && process.env.BACKUP_DRY_RUN_DB_PASSWORD
      ),
      approval_policy: approvalPolicy,
      admin_approval_mode: approvalPolicy.approval_mode,
      active_system_admin_count: approvalPolicy.active_system_admin_count,
      eligible_system_admin_count: approvalPolicy.eligible_system_admin_count,
      single_admin_mode: approvalPolicy.single_admin_mode,
      self_approval_allowed: approvalPolicy.self_approval_allowed,
      maker_checker_required: approvalPolicy.maker_checker_required,
      administrator_verification_required: true,
      independent_verification_required: approvalPolicy.independent_verification_required,
      step_up_mfa_required: true,
      automation_enabled: String(process.env.BACKUP_AUTOMATION_ENABLED || 'true').toLowerCase() !== 'false',
      retention_automation_enabled: String(process.env.BACKUP_RETENTION_AUTOMATION_ENABLED || 'true').toLowerCase() !== 'false',
      restore_drill_automation_enabled: String(process.env.BACKUP_RESTORE_DRILL_AUTOMATION_ENABLED || 'true').toLowerCase() !== 'false',
      backup_scheduler_enabled: String(process.env.BACKUP_AUTOMATION_ENABLED || 'true').toLowerCase() !== 'false',
      retention_cleanup_enabled: String(process.env.BACKUP_RETENTION_AUTOMATION_ENABLED || 'true').toLowerCase() !== 'false',
      restore_drill_worker_enabled: String(process.env.BACKUP_RESTORE_DRILL_AUTOMATION_ENABLED || 'true').toLowerCase() !== 'false',
      provider_readiness: providerReadiness,
    },
  };
}

router.use(requireAuth);
router.use(requireRole(ROLES.admin_any));
router.use(requirePermission('admin_panel:access'));

router.get('/', async (req, res) => {
  try {
    return res.json(requestedPagination(req.query)
      ? await listBackupsPaginated(req.user.id, req.query)
      : await listBackups(req.user.id));
  }
  catch (error) { return errorResponse(res, error, 'Failed to load backup history.'); }
});

router.get('/overview', async (req, res) => {
  try { return res.json(await buildOverview(req.user.id)); }
  catch (error) { return errorResponse(res, error, 'Failed to load backup dashboard.'); }
});

router.get('/recovery-points', async (req, res) => {
  try {
    return res.json(requestedPagination(req.query)
      ? await listRecoveryPointsPaginated(req.query)
      : await listRecoveryPoints(100));
  }
  catch (error) { return errorResponse(res, error, 'Failed to load module recovery points.'); }
});

router.get('/restore-jobs', async (req, res) => {
  try {
    return res.json(requestedPagination(req.query)
      ? await listRestoreJobsPaginated(req.user.id, req.query)
      : await listRestoreJobs(req.user.id, 100));
  }
  catch (error) { return errorResponse(res, error, 'Failed to load restore jobs.'); }
});

router.get('/rollback-requests', async (req, res) => {
  try {
    return res.json(requestedPagination(req.query)
      ? await listRollbackRequestsPaginated(req.user.id, req.query)
      : await listRollbackRequests(req.user.id, 100));
  }
  catch (error) { return errorResponse(res, error, 'Failed to load rollback requests.'); }
});

router.get('/provider-readiness', async (_req, res) => {
  return res.json({
    generated_at: new Date().toISOString(),
    providers: backupAutomation.providerReadiness(),
  });
});

router.get('/schedules', async (req, res) => {
  try {
    const options = paginationOptions({ page_size: '100', ...req.query });
    const where = [];
    const params = [];
    addSearchClause(where, params, options.search, [
      's.schedule_reference', 's.name', 's.backup_type', 's.storage_provider', 's.included_modules',
    ]);
    if (options.status !== 'ALL') {
      if (options.status === 'ENABLED') where.push('s.enabled=1');
      else if (options.status === 'DISABLED') where.push('s.enabled=0');
      else if (['NEVER', 'QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED'].includes(options.status)) {
        where.push('s.last_status=?');
        params.push(options.status);
      } else throw new RecoveryError('Schedule status filter is invalid.', 400, 'INVALID_BACKUP_FILTER');
    }
    if (options.type !== 'ALL') {
      if (!BACKUP_TYPES.has(options.type)) throw new RecoveryError('Backup type filter is invalid.', 400, 'INVALID_BACKUP_FILTER');
      where.push('s.backup_type=?');
      params.push(options.type);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [[countRow]] = await pool.execute(`SELECT COUNT(*) AS total FROM backup_schedules s ${whereSql}`, params);
    clampPaginationToTotal(options, countRow.total);
    const [rows] = await pool.execute(
      `SELECT s.*, creator.username AS created_by_username
         FROM backup_schedules s
         LEFT JOIN users creator ON creator.id=s.created_by
         ${whereSql}
        ORDER BY s.enabled DESC,s.next_run_at IS NULL,s.next_run_at ASC,s.id DESC
        LIMIT ${options.pageSize} OFFSET ${options.offset}`,
      params
    );
    const result = paginatedResult(rows.map(scheduleResponse), countRow.total, options);
    return res.json({ ...result, schedules: result.items });
  } catch (error) {
    return errorResponse(res, error, 'Failed to load backup schedules.');
  }
});

router.post('/schedules', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const key = idempotencyKey(req);
    const schedule = scheduleMutation(req.body || {});
    const fingerprint = requestFingerprint('BACKUP_SCHEDULE_CREATE', {
      ...schedule,
      included_modules: [...schedule.included_modules].sort(),
      next_run_at: undefined,
    });
    await connection.beginTransaction();
    const [existingRows] = await connection.execute(
      'SELECT * FROM backup_schedules WHERE idempotency_key=? FOR UPDATE',
      [key]
    );
    if (existingRows.length) {
      assertIdempotentReplay(existingRows[0], fingerprint);
      await connection.commit();
      return res.json({
        message: 'Existing backup schedule returned for this idempotency key.',
        schedule: scheduleResponse(existingRows[0]),
        schedule_id: existingRows[0].id,
        idempotent_replay: true,
      });
    }
    await assertRetentionPolicyExists(connection, schedule.retention_policy_id);
    const reference = makeReference('BKS');
    const [insert] = await connection.execute(
      `INSERT INTO backup_schedules
         (schedule_reference,idempotency_key,request_fingerprint,name,backup_type,storage_provider,
          included_modules,frequency,run_time,day_of_week,day_of_month,timezone,next_run_at,enabled,
          retention_policy_id,created_by,updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [reference, key, fingerprint, schedule.name, schedule.backup_type, schedule.storage_provider,
        JSON.stringify(schedule.included_modules), schedule.frequency, schedule.run_time, schedule.day_of_week,
        schedule.day_of_month, schedule.timezone, schedule.next_run_at, schedule.enabled ? 1 : 0,
        schedule.retention_policy_id, req.user.id, req.user.id]
    );
    await audit(connection, req, `CREATE_BACKUP_SCHEDULE: ${reference}`, {
      schedule_id: insert.insertId,
      backup_type: schedule.backup_type,
      storage_provider: schedule.storage_provider,
      frequency: schedule.frequency,
      enabled: schedule.enabled,
    });
    const [createdRows] = await connection.execute('SELECT * FROM backup_schedules WHERE id=?', [insert.insertId]);
    await connection.commit();
    return res.status(201).json({
      message: schedule.enabled ? 'Backup schedule created and enabled.' : 'Disabled backup schedule created.',
      schedule: scheduleResponse(createdRows[0]),
      schedule_id: insert.insertId,
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to create backup schedule.');
  } finally { connection.release(); }
});

router.patch('/schedules/:scheduleId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    idempotencyKey(req);
    const scheduleId = positiveId(req.params.scheduleId, 'schedule_id');
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM backup_schedules WHERE id=? FOR UPDATE', [scheduleId]);
    const existing = rows[0];
    if (!existing) throw new RecoveryError('Backup schedule was not found.', 404, 'BACKUP_SCHEDULE_NOT_FOUND');
    const schedule = scheduleMutation(req.body || {}, existing);
    const timingChanged = ['frequency', 'run_time', 'day_of_week', 'day_of_month', 'timezone']
      .some(field => hasOwn(req.body, field));
    const enabledChanged = hasOwn(req.body, 'enabled') && Boolean(existing.enabled) !== schedule.enabled;
    if (schedule.enabled && !timingChanged && !enabledChanged && existing.next_run_at) {
      schedule.next_run_at = existing.next_run_at;
    }
    await assertRetentionPolicyExists(connection, schedule.retention_policy_id);
    await connection.execute(
      `UPDATE backup_schedules
          SET name=?,backup_type=?,storage_provider=?,included_modules=?,frequency=?,run_time=?,
              day_of_week=?,day_of_month=?,timezone=?,next_run_at=?,enabled=?,retention_policy_id=?,updated_by=?
        WHERE id=?`,
      [schedule.name, schedule.backup_type, schedule.storage_provider, JSON.stringify(schedule.included_modules),
        schedule.frequency, schedule.run_time, schedule.day_of_week, schedule.day_of_month, schedule.timezone,
        schedule.next_run_at, schedule.enabled ? 1 : 0, schedule.retention_policy_id, req.user.id, scheduleId]
    );
    await audit(connection, req, `UPDATE_BACKUP_SCHEDULE: ${existing.schedule_reference}`, {
      schedule_id: scheduleId,
      enabled: schedule.enabled,
      next_run_at: schedule.next_run_at,
    });
    const [updatedRows] = await connection.execute('SELECT * FROM backup_schedules WHERE id=?', [scheduleId]);
    await connection.commit();
    return res.json({
      message: `Backup schedule ${schedule.enabled ? 'saved' : 'disabled'}.`,
      schedule: scheduleResponse(updatedRows[0]),
      schedule_id: scheduleId,
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to update backup schedule.');
  } finally { connection.release(); }
});

router.post('/schedules/:scheduleId/run-now', async (req, res) => {
  const scheduleId = positiveId(req.params.scheduleId, 'schedule_id');
  const connection = await pool.getConnection();
  let action = null;
  try {
    await connection.beginTransaction();
    const [scheduleRows] = await connection.execute('SELECT * FROM backup_schedules WHERE id=? FOR UPDATE', [scheduleId]);
    const schedule = scheduleRows[0];
    if (!schedule) throw new RecoveryError('Backup schedule was not found.', 404, 'BACKUP_SCHEDULE_NOT_FOUND');
    const [activeRows] = await connection.execute(
      `SELECT id FROM backup_sets
        WHERE schedule_id=? AND status IN ('PENDING','RUNNING')
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [scheduleId]
    );
    if (activeRows.length) throw new RecoveryError('This schedule already has an active backup job.', 409, 'BACKUP_SCHEDULE_ALREADY_RUNNING');
    action = await claimAutomationAction(connection, req, {
      actionType: 'SCHEDULE_RUN',
      resourceType: 'BACKUP_SCHEDULE',
      resourceId: scheduleId,
      purpose: 'SCHEDULE_RUN',
    });
    if (action.replay) {
      await connection.commit();
      connection.release();
      return res.json({
        message: 'Existing schedule run result returned for this idempotency key.',
        result: action.result,
        idempotent_replay: true,
      });
    }
    await audit(connection, req, `RUN_BACKUP_SCHEDULE_NOW: ${schedule.schedule_reference}`, {
      schedule_id: scheduleId,
      action_request_id: action.actionId,
    });
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    connection.release();
    return errorResponse(res, error, 'Failed to start the backup schedule.');
  }
  connection.release();

  try {
    const workerResult = await backupAutomation.runScheduleById(scheduleId, {
      actorId: req.user.id,
      scheduledFor: action.operationTime,
    });
    const approvalPolicy = await loadAdminApprovalPolicy(pool);
    const result = {
      ...workerResult,
      approval_policy: approvalPolicy,
      administrator_verification_required: true,
      independent_verification_required: approvalPolicy.independent_verification_required,
      maker_checker_required: approvalPolicy.maker_checker_required,
    };
    await completeAutomationAction(action.actionId, result);
    await backupAutomation.reconcileNotifications().catch(() => {});
    return res.json({
      message: 'Scheduled backup completed. Verify it with fresh step-up MFA.',
      result,
      schedule_id: scheduleId,
      backup_set_id: result.backupSetId,
      approval_policy: approvalPolicy,
      administrator_verification_required: true,
      independent_verification_required: approvalPolicy.independent_verification_required,
      maker_checker_required: approvalPolicy.maker_checker_required,
    });
  } catch (error) {
    await failAutomationAction(action.actionId, error);
    return errorResponse(res, error, 'Scheduled backup execution failed.');
  }
});

router.get('/retention-policy', async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT p.*, creator.username AS created_by_username
         FROM backup_retention_policies p
         LEFT JOIN users creator ON creator.id=p.created_by
        ORDER BY p.enabled DESC,p.updated_at DESC,p.id DESC
        LIMIT 100`
    );
    const policies = rows.map(retentionPolicyResponse);
    return res.json({ policy: policies[0] || null, policies, items: policies });
  } catch (error) {
    return errorResponse(res, error, 'Failed to load the backup retention policy.');
  }
});

router.put('/retention-policy', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const requestedPolicyId = req.body?.policy_id || req.body?.id || null;
    await connection.beginTransaction();
    if (!requestedPolicyId) {
      const key = idempotencyKey(req);
      const policy = retentionMutation(req.body || {});
      if (policy.enabled) {
        throw new RecoveryError(
          'Create the policy as a disabled draft before enabling it with step-up MFA.',
          409,
          'RETENTION_POLICY_DRAFT_REQUIRED'
        );
      }
      const fingerprint = requestFingerprint('RETENTION_POLICY_CREATE', policy);
      const [existingRows] = await connection.execute(
        'SELECT * FROM backup_retention_policies WHERE idempotency_key=? FOR UPDATE',
        [key]
      );
      if (existingRows.length) {
        assertIdempotentReplay(existingRows[0], fingerprint);
        await connection.commit();
        return res.json({
          message: 'Existing disabled retention-policy draft returned for this idempotency key.',
          policy: retentionPolicyResponse(existingRows[0]),
          policy_id: existingRows[0].id,
          idempotent_replay: true,
        });
      }
      const reference = makeReference('BRP');
      const [insert] = await connection.execute(
        `INSERT INTO backup_retention_policies
           (policy_reference,idempotency_key,request_fingerprint,policy_name,backup_type,storage_provider,
            keep_last,max_age_days,delete_expired_artifacts,enabled,created_by,updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`,
        [reference, key, fingerprint, policy.policy_name, policy.backup_type, policy.storage_provider,
          policy.keep_last, policy.max_age_days, policy.delete_expired_artifacts ? 1 : 0,
          req.user.id, req.user.id]
      );
      await audit(connection, req, `CREATE_RETENTION_POLICY_DRAFT: ${reference}`, {
        policy_id: insert.insertId,
        enabled: false,
        physical_deletion_executed: false,
      });
      const [createdRows] = await connection.execute('SELECT * FROM backup_retention_policies WHERE id=?', [insert.insertId]);
      await connection.commit();
      return res.status(201).json({
        message: 'Disabled retention-policy draft created. MFA is required to enable it.',
        policy: retentionPolicyResponse(createdRows[0]),
        policy_id: insert.insertId,
      });
    }

    const policyId = positiveId(requestedPolicyId, 'policy_id');
    const [rows] = await connection.execute('SELECT * FROM backup_retention_policies WHERE id=? FOR UPDATE', [policyId]);
    const existing = rows[0];
    if (!existing) throw new RecoveryError('Retention policy was not found.', 404, 'RETENTION_POLICY_NOT_FOUND');
    const policy = retentionMutation(req.body || {}, existing);
    const action = await claimAutomationAction(connection, req, {
      actionType: 'RETENTION_UPDATE',
      resourceType: 'RETENTION_POLICY',
      resourceId: policyId,
      purpose: 'RETENTION_EXECUTE',
      fingerprintPayload: policy,
    });
    if (action.replay) {
      await connection.commit();
      return res.json({
        message: 'Existing retention-policy update returned for this idempotency key.',
        ...action.result,
        idempotent_replay: true,
      });
    }
    await connection.execute(
      `UPDATE backup_retention_policies
          SET policy_name=?,backup_type=?,storage_provider=?,keep_last=?,max_age_days=?,
              delete_expired_artifacts=?,enabled=?,updated_by=?
        WHERE id=?`,
      [policy.policy_name, policy.backup_type, policy.storage_provider, policy.keep_last, policy.max_age_days,
        policy.delete_expired_artifacts ? 1 : 0, policy.enabled ? 1 : 0, req.user.id, policyId]
    );
    const [updatedRows] = await connection.execute('SELECT * FROM backup_retention_policies WHERE id=?', [policyId]);
    const result = { policy: retentionPolicyResponse(updatedRows[0]), policy_id: policyId };
    await connection.execute(
      `UPDATE backup_automation_action_requests
          SET status='COMPLETED',result_json=?,completed_at=NOW(),failed_at=NULL,failure_code=NULL
        WHERE id=? AND status='IN_PROGRESS'`,
      [JSON.stringify(result), action.actionId]
    );
    await audit(connection, req, `UPDATE_RETENTION_POLICY: ${existing.policy_reference}`, {
      policy_id: policyId,
      enabled: policy.enabled,
      delete_expired_artifacts: policy.delete_expired_artifacts,
      keep_last: policy.keep_last,
      max_age_days: policy.max_age_days,
      physical_deletion_executed: false,
    });
    await connection.commit();
    return res.json({
      message: `Retention policy ${policy.enabled ? 'enabled and saved' : 'disabled and saved'}.`,
      ...result,
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to save the backup retention policy.');
  } finally { connection.release(); }
});

router.post('/retention/run', async (req, res) => {
  const policyId = positiveId(req.body?.policy_id, 'policy_id');
  const connection = await pool.getConnection();
  let action = null;
  let preservedVerified = 0;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM backup_retention_policies WHERE id=? FOR UPDATE', [policyId]);
    const policy = rows[0];
    if (!policy) throw new RecoveryError('Retention policy was not found.', 404, 'RETENTION_POLICY_NOT_FOUND');
    if (!policy.enabled) throw new RecoveryError('Enable the retention policy before running cleanup.', 409, 'RETENTION_POLICY_DISABLED');
    const [[eligibleRow]] = await connection.execute(
      `SELECT COUNT(*) AS total FROM backup_sets
        WHERE status IN ('VERIFIED','RESTORED') AND artifact_deleted_at IS NULL
          AND storage_location_encrypted IS NOT NULL AND checksum IS NOT NULL
          AND (? IS NULL OR backup_type=?) AND (? IS NULL OR storage_provider=?)`,
      [policy.backup_type, policy.backup_type, policy.storage_provider, policy.storage_provider]
    );
    preservedVerified = Math.min(Number(eligibleRow.total || 0), Number(policy.keep_last || 0));
    action = await claimAutomationAction(connection, req, {
      actionType: 'RETENTION_RUN',
      resourceType: 'RETENTION_POLICY',
      resourceId: policyId,
      purpose: 'RETENTION_EXECUTE',
    });
    if (action.replay) {
      await connection.commit();
      connection.release();
      return res.json({
        message: 'Existing retention cleanup result returned for this idempotency key.',
        result: action.result,
        idempotent_replay: true,
      });
    }
    await audit(connection, req, `RUN_BACKUP_RETENTION: ${policy.policy_reference}`, {
      policy_id: policyId,
      action_request_id: action.actionId,
      delete_expired_artifacts: Boolean(policy.delete_expired_artifacts),
    });
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    connection.release();
    return errorResponse(res, error, 'Failed to start retention cleanup.');
  }
  connection.release();

  try {
    const actions = await backupAutomation.runRetention({ policyId, actorId: req.user.id });
    const result = {
      policy_id: policyId,
      expired_count: actions.filter(item => ['EXPIRED', 'DELETE_PENDING', 'DELETED'].includes(item.status)).length,
      deletion_pending: actions.filter(item => item.status === 'DELETE_PENDING').length,
      deleted_artifacts: actions.filter(item => item.status === 'DELETED').length,
      errors: actions.filter(item => item.status === 'ERROR').length,
      preserved_verified: preservedVerified,
      actions,
    };
    await completeAutomationAction(action.actionId, result);
    await audit(pool, req, `COMPLETE_BACKUP_RETENTION: ${policyId}`, {
      policy_id: policyId,
      expired_count: result.expired_count,
      deleted_artifacts: result.deleted_artifacts,
      errors: result.errors,
      database_evidence_preserved: true,
    }).catch(() => {});
    return res.json({ message: 'Retention cleanup completed.', result });
  } catch (error) {
    await failAutomationAction(action.actionId, error);
    return errorResponse(res, error, 'Backup retention cleanup failed safely.');
  }
});

router.get('/notifications', async (req, res) => {
  try {
    await backupAutomation.reconcileNotifications().catch(error => {
      console.error('[backup-action-notifications]', error.message);
    });
    const options = paginationOptions({ page_size: '100', ...req.query });
    const where = ['n.recipient_user_id=?'];
    const params = [req.user.id];
    addSearchClause(where, params, options.search, [
      'n.title', 'n.message', 'n.category', 'n.resource_type', 'CAST(n.resource_id AS CHAR)',
    ]);
    if (options.status !== 'ALL') {
      if (!['UNREAD', 'READ', 'RESOLVED'].includes(options.status)) {
        throw new RecoveryError('Notification status filter is invalid.', 400, 'INVALID_BACKUP_FILTER');
      }
      where.push('n.status=?');
      params.push(options.status);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const [[countRow]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM backup_action_notifications n ${whereSql}`,
      params
    );
    clampPaginationToTotal(options, countRow.total);
    const [rows] = await pool.execute(
      `SELECT n.* FROM backup_action_notifications n ${whereSql}
        ORDER BY n.status='UNREAD' DESC,n.action_required DESC,n.created_at DESC,n.id DESC
        LIMIT ${options.pageSize} OFFSET ${options.offset}`,
      params
    );
    const [[unreadRow]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM backup_action_notifications
        WHERE recipient_user_id=? AND status='UNREAD'`,
      [req.user.id]
    );
    const result = paginatedResult(rows.map(notificationResponse), countRow.total, options);
    return res.json({ ...result, notifications: result.items, unread_count: Number(unreadRow.total || 0) });
  } catch (error) {
    return errorResponse(res, error, 'Failed to load backup action notifications.');
  }
});

router.patch('/notifications/:notificationId/read', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    idempotencyKey(req);
    const notificationId = positiveId(req.params.notificationId, 'notification_id');
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT * FROM backup_action_notifications
        WHERE id=? AND recipient_user_id=? FOR UPDATE`,
      [notificationId, req.user.id]
    );
    const notification = rows[0];
    if (!notification) throw new RecoveryError('Notification was not found.', 404, 'BACKUP_NOTIFICATION_NOT_FOUND');
    if (notification.status === 'UNREAD') {
      await connection.execute(
        `UPDATE backup_action_notifications
            SET status='READ',read_at=NOW(),resolved_at=NULL,updated_at=NOW()
          WHERE id=? AND recipient_user_id=? AND status='UNREAD'`,
        [notificationId, req.user.id]
      );
    }
    const [updatedRows] = await connection.execute(
      'SELECT * FROM backup_action_notifications WHERE id=? AND recipient_user_id=?',
      [notificationId, req.user.id]
    );
    await connection.commit();
    const updated = notificationResponse(updatedRows[0]);
    return res.json({
      message: notification.status === 'UNREAD' ? 'Notification marked as read.' : 'Notification was already read.',
      notification: updated,
      notification_id: notificationId,
      status: updated.status,
      read_at: updated.read_at,
      idempotent_replay: notification.status !== 'UNREAD',
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to mark the notification as read.');
  } finally { connection.release(); }
});

router.get('/restore-drills', async (req, res) => {
  try {
    const options = paginationOptions({ page_size: '100', ...req.query });
    const where = [];
    const params = [];
    addSearchClause(where, params, options.search, [
      's.schedule_reference', 's.name', 's.backup_type_filter', 's.storage_provider_filter', 's.module_key_filter',
    ]);
    if (options.status !== 'ALL') {
      if (options.status === 'ENABLED') where.push('s.enabled=1');
      else if (options.status === 'DISABLED') where.push('s.enabled=0');
      else if (['NEVER', 'QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'SKIPPED'].includes(options.status)) {
        where.push('s.last_status=?');
        params.push(options.status);
      } else throw new RecoveryError('Restore drill status filter is invalid.', 400, 'INVALID_BACKUP_FILTER');
    }
    if (options.type !== 'ALL') {
      if (!BACKUP_TYPES.has(options.type)) throw new RecoveryError('Restore drill type filter is invalid.', 400, 'INVALID_BACKUP_FILTER');
      where.push('s.backup_type_filter=?');
      params.push(options.type);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [[countRow]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM backup_restore_drill_schedules s ${whereSql}`,
      params
    );
    clampPaginationToTotal(options, countRow.total);
    const [rows] = await pool.execute(
      `SELECT s.*,creator.username AS created_by_username,
              latest.id AS latest_run_id,latest.status AS latest_run_status,
              latest.integrity_status AS latest_integrity_status,
              latest.result_message_encrypted AS latest_result_message_encrypted,
              latest.failure_message_encrypted AS latest_failure_message_encrypted,
              latest.completed_at AS latest_completed_at,latest.backup_set_id AS latest_backup_set_id
         FROM backup_restore_drill_schedules s
         LEFT JOIN users creator ON creator.id=s.created_by
         LEFT JOIN backup_restore_drill_runs latest
           ON latest.id=(SELECT MAX(run2.id) FROM backup_restore_drill_runs run2 WHERE run2.schedule_id=s.id)
         ${whereSql}
        ORDER BY s.enabled DESC,s.next_run_at IS NULL,s.next_run_at ASC,s.id DESC
        LIMIT ${options.pageSize} OFFSET ${options.offset}`,
      params
    );
    const result = paginatedResult(rows.map(drillScheduleResponse), countRow.total, options);
    return res.json({ ...result, drills: result.items });
  } catch (error) {
    return errorResponse(res, error, 'Failed to load restore drills.');
  }
});

router.post('/restore-drills', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const key = idempotencyKey(req);
    const drill = drillMutation(req.body || {});
    const fingerprint = requestFingerprint('RESTORE_DRILL_CREATE', { ...drill, next_run_at: undefined });
    await connection.beginTransaction();
    const [existingRows] = await connection.execute(
      'SELECT * FROM backup_restore_drill_schedules WHERE idempotency_key=? FOR UPDATE',
      [key]
    );
    if (existingRows.length) {
      assertIdempotentReplay(existingRows[0], fingerprint);
      await connection.commit();
      return res.json({
        message: 'Existing restore drill returned for this idempotency key.',
        drill: drillScheduleResponse(existingRows[0]),
        drill_id: existingRows[0].id,
        idempotent_replay: true,
      });
    }
    const reference = makeReference('RDSD');
    const [insert] = await connection.execute(
      `INSERT INTO backup_restore_drill_schedules
         (schedule_reference,idempotency_key,request_fingerprint,name,selection_strategy,
          backup_type_filter,storage_provider_filter,module_key_filter,frequency,run_time,
          day_of_week,day_of_month,timezone,next_run_at,enabled,created_by,updated_by)
       VALUES (?,?,?,?,'LATEST_VERIFIED',?,?,?,?,?,?,?,?,?,?,?,?)`,
      [reference, key, fingerprint, drill.name, drill.backup_type_filter, drill.storage_provider_filter,
        drill.module_key_filter, drill.frequency, drill.run_time, drill.day_of_week, drill.day_of_month,
        drill.timezone, drill.next_run_at, drill.enabled ? 1 : 0, req.user.id, req.user.id]
    );
    await audit(connection, req, `CREATE_RESTORE_DRILL: ${reference}`, {
      drill_schedule_id: insert.insertId,
      backup_type_filter: drill.backup_type_filter,
      storage_provider_filter: drill.storage_provider_filter,
      module_key_filter: drill.module_key_filter,
      isolated_only: true,
      enabled: drill.enabled,
    });
    const [createdRows] = await connection.execute('SELECT * FROM backup_restore_drill_schedules WHERE id=?', [insert.insertId]);
    await connection.commit();
    return res.status(201).json({
      message: drill.enabled ? 'Isolated restore drill created and enabled.' : 'Disabled restore drill created.',
      drill: drillScheduleResponse(createdRows[0]),
      drill_id: insert.insertId,
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to create the restore drill.');
  } finally { connection.release(); }
});

router.patch('/restore-drills/:drillId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    idempotencyKey(req);
    const drillId = positiveId(req.params.drillId, 'drill_id');
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM backup_restore_drill_schedules WHERE id=? FOR UPDATE', [drillId]);
    const existing = rows[0];
    if (!existing) throw new RecoveryError('Restore drill was not found.', 404, 'RESTORE_DRILL_SCHEDULE_NOT_FOUND');
    const drill = drillMutation(req.body || {}, existing);
    const timingChanged = ['frequency', 'run_time', 'day_of_week', 'day_of_month', 'timezone']
      .some(field => hasOwn(req.body, field));
    const enabledChanged = hasOwn(req.body, 'enabled') && Boolean(existing.enabled) !== drill.enabled;
    if (drill.enabled && !timingChanged && !enabledChanged && existing.next_run_at) {
      drill.next_run_at = existing.next_run_at;
    }
    await connection.execute(
      `UPDATE backup_restore_drill_schedules
          SET name=?,backup_type_filter=?,storage_provider_filter=?,module_key_filter=?,frequency=?,run_time=?,
              day_of_week=?,day_of_month=?,timezone=?,next_run_at=?,enabled=?,updated_by=?
        WHERE id=?`,
      [drill.name, drill.backup_type_filter, drill.storage_provider_filter, drill.module_key_filter,
        drill.frequency, drill.run_time, drill.day_of_week, drill.day_of_month, drill.timezone,
        drill.next_run_at, drill.enabled ? 1 : 0, req.user.id, drillId]
    );
    await audit(connection, req, `UPDATE_RESTORE_DRILL: ${existing.schedule_reference}`, {
      drill_schedule_id: drillId,
      enabled: drill.enabled,
      next_run_at: drill.next_run_at,
      isolated_only: true,
    });
    const [updatedRows] = await connection.execute('SELECT * FROM backup_restore_drill_schedules WHERE id=?', [drillId]);
    await connection.commit();
    return res.json({
      message: `Restore drill ${drill.enabled ? 'saved' : 'disabled'}.`,
      drill: drillScheduleResponse(updatedRows[0]),
      drill_id: drillId,
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to update the restore drill.');
  } finally { connection.release(); }
});

router.post('/restore-drills/:drillId/run-now', async (req, res) => {
  const drillId = positiveId(req.params.drillId, 'drill_id');
  const connection = await pool.getConnection();
  let action = null;
  try {
    await connection.beginTransaction();
    const [drillRows] = await connection.execute(
      'SELECT * FROM backup_restore_drill_schedules WHERE id=? FOR UPDATE',
      [drillId]
    );
    const drill = drillRows[0];
    if (!drill) throw new RecoveryError('Restore drill was not found.', 404, 'RESTORE_DRILL_SCHEDULE_NOT_FOUND');
    const [activeRows] = await connection.execute(
      `SELECT id FROM backup_restore_drill_runs
        WHERE schedule_id=? AND status IN ('QUEUED','RUNNING')
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [drillId]
    );
    if (activeRows.length) throw new RecoveryError('This restore drill is already running.', 409, 'RESTORE_DRILL_ALREADY_RUNNING');
    action = await claimAutomationAction(connection, req, {
      actionType: 'DRILL_RUN',
      resourceType: 'RESTORE_DRILL',
      resourceId: drillId,
      purpose: 'DRILL_RUN',
    });
    if (action.replay) {
      await connection.commit();
      connection.release();
      return res.json({
        message: 'Existing restore drill result returned for this idempotency key.',
        result: action.result,
        idempotent_replay: true,
      });
    }
    await audit(connection, req, `RUN_RESTORE_DRILL_NOW: ${drill.schedule_reference}`, {
      drill_schedule_id: drillId,
      action_request_id: action.actionId,
      isolated_only: true,
    });
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    connection.release();
    return errorResponse(res, error, 'Failed to start the restore drill.');
  }
  connection.release();

  try {
    const result = await backupAutomation.runDrillById(drillId, {
      actorId: req.user.id,
      scheduledFor: action.operationTime,
    });
    await completeAutomationAction(action.actionId, result);
    return res.json({
      message: result.status === 'PASSED'
        ? 'Isolated restore drill passed. No production restore was applied.'
        : 'Restore drill completed without changing production.',
      result,
      drill_id: drillId,
      drill_run_id: result.runId,
    });
  } catch (error) {
    await failAutomationAction(action.actionId, error);
    return errorResponse(res, error, 'Isolated restore drill failed safely.');
  }
});

router.post('/step-up/challenges', async (req, res) => {
  try {
    const result = await createBackupStepUpChallenge(req, {
      purpose: req.body?.purpose,
      resourceType: req.body?.resource_type,
      resourceId: req.body?.resource_id,
    });
    return res.status(201).json(result);
  } catch (error) {
    return errorResponse(res, error, 'Failed to create step-up challenge.');
  }
});

router.post('/step-up/challenges/:challengeId/verify', async (req, res) => {
  try {
    const result = await verifyBackupStepUpChallenge(req, {
      challengeId: req.params.challengeId,
      challengeToken: req.body?.challenge_token,
      code: req.body?.code,
    });
    return res.json(result);
  } catch (error) {
    return errorResponse(res, error, 'Failed to verify step-up challenge.');
  }
});

router.post('/request', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const key = idempotencyKey(req);
    const backupType = normalizeEnum(req.body?.backup_type || 'DATABASE', BACKUP_TYPES, 'backup_type');
    const storageProvider = normalizeEnum(req.body?.storage_provider || req.body?.storage_target || 'LOCAL', STORAGE_PROVIDERS, 'storage_provider');
    if (storageProvider === 'MANUAL') {
      throw new RecoveryError('Manual metadata records are not executable backups. Select LOCAL, S3, or RDS_SNAPSHOT.', 400, 'EXECUTABLE_BACKUP_PROVIDER_REQUIRED');
    }
    const includedModules = normalizeModules(req.body?.included_modules);
    const reference = makeReference('BKP');
    const requestedBackupName = cleanText(req.body?.backup_name, 160);
    const backupName = requestedBackupName || `${backupType.replace(/_/g, ' ')} ${reference}`;
    const notes = cleanText(req.body?.notes, 2000);
    const fingerprint = requestFingerprint('BACKUP_REQUEST', {
      backupName: requestedBackupName,
      backupType,
      includedModules: [...includedModules].sort(),
      notes,
      storageProvider,
    });
    await connection.beginTransaction();
    const approvalPolicy = await loadAdminApprovalPolicy(connection);
    const [existing] = await connection.execute('SELECT * FROM backup_sets WHERE idempotency_key = ? FOR UPDATE', [key]);
    if (existing.length) {
      assertIdempotentReplay(existing[0], fingerprint);
      await connection.commit();
      return res.status(200).json({
        message: 'Existing backup request returned for this idempotency key.',
        backup: backupResponse(existing[0], req.user.id, approvalPolicy),
        backup_set_id: existing[0].id,
        backup_reference: existing[0].backup_reference,
        approval_policy: approvalPolicy,
        idempotent_replay: true,
      });
    }
    const [result] = await connection.execute(
      `INSERT INTO backup_sets
         (idempotency_key, request_fingerprint, backup_reference, backup_name, backup_type, storage_provider,
          status, approval_status, included_modules, checksum_algorithm, verification_status,
          integrity_status, created_by, updated_by, remarks_encrypted)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 'NOT_REQUIRED', ?, 'SHA-256',
               'NOT_VERIFIED', 'NOT_CHECKED', ?, ?, ?)`,
      [key, fingerprint, reference, backupName, backupType, storageProvider, JSON.stringify(includedModules), req.user.id, req.user.id, protectedText(notes)]
    );
    await audit(connection, req, `CREATE_BACKUP: ${reference}`, {
      backup_set_id: result.insertId,
      backup_type: backupType,
      storage_provider: storageProvider,
      included_modules: includedModules,
      status: 'PENDING',
      approval_policy: approvalPolicy,
    });
    await connection.commit();
    return res.status(201).json({
      message: 'Backup request queued.',
      backup_set_id: result.insertId,
      backup_id: result.insertId,
      backup_reference: reference,
      status: 'PENDING',
      approval_policy: approvalPolicy,
      administrator_verification_required: true,
      independent_verification_required: approvalPolicy.independent_verification_required,
      maker_checker_required: approvalPolicy.maker_checker_required,
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to create backup request.');
  } finally {
    connection.release();
  }
});

async function executeBackupSet(req, backupId) {
  const lease = workerLease();
  const leaseHash = lease.hash;
  const connection = await pool.getConnection();
  let backup;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM backup_sets WHERE id = ? FOR UPDATE', [backupId]);
    backup = rows[0];
    if (!backup) throw new RecoveryError('Backup set not found.', 404, 'BACKUP_NOT_FOUND');
    assertTransition(BACKUP_TRANSITIONS, backup.status, 'RUNNING', 'Backup');
    await connection.execute(
      `UPDATE backup_sets
          SET status = 'RUNNING', started_at = NOW(), failed_at = NULL,
              failure_message_encrypted = NULL, attempt_count = attempt_count + 1,
              worker_lease_token_hash = ?, worker_lease_expires_at = DATE_ADD(NOW(), INTERVAL ${lease.minutes} MINUTE),
              updated_by = ?
        WHERE id = ?`,
      [leaseHash, req.user.id, backupId]
    );
    await audit(connection, req, `RUN_BACKUP: ${backup.backup_reference}`, { backup_set_id: backupId, status: 'RUNNING' });
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    connection.release();
    throw error;
  }
  connection.release();

  try {
    const result = await runtime.createBackup({
      backupReference: backup.backup_reference,
      backupName: backup.backup_name,
      backupType: backup.backup_type,
      storageProvider: backup.storage_provider,
      includedModules: parseJson(backup.included_modules, []),
    });
    const completed = await pool.getConnection();
    try {
      await completed.beginTransaction();
      const [update] = await completed.execute(
        `UPDATE backup_sets
            SET status = 'COMPLETED', storage_location_encrypted = ?, checksum = ?,
                file_size = ?, artifact_format = ?, checksum_algorithm = 'SHA-256',
                verification_status = 'NOT_VERIFIED', integrity_status = ?,
                adapter_metadata_encrypted = ?, completed_at = NOW(), failed_at = NULL,
                failure_message_encrypted = NULL, worker_lease_token_hash = NULL,
                worker_lease_expires_at = NULL, updated_by = ?
          WHERE id = ? AND status = 'RUNNING' AND worker_lease_token_hash = ?`,
        [
          protectedText(result.storageLocation),
          result.checksum,
          Number.isSafeInteger(Number(result.fileSize)) ? Number(result.fileSize) : null,
          cleanText(result.artifactFormat || result.descriptor?.type || 'BACKUP_ARTIFACT', 40),
          result.integrityReport ? 'PASSED' : 'NOT_CHECKED',
          protectedText(JSON.stringify({
            storageProvider: result.storageProvider,
            fileCount: result.fileCount,
            descriptor: result.descriptor || null,
            integrityReport: result.integrityReport || null,
          })),
          req.user.id,
          backupId,
          leaseHash,
        ]
      );
      if (update.affectedRows !== 1) throw new RecoveryError('Backup worker lease expired or was replaced.', 409, 'BACKUP_WORKER_LEASE_LOST');
      const approvalPolicy = await loadAdminApprovalPolicy(completed);
      await audit(completed, req, `COMPLETE_BACKUP: ${backup.backup_reference}`, {
        backup_set_id: backupId,
        status: 'COMPLETED',
        checksum_recorded: true,
        administrator_verification_required: true,
        independent_verification_required: approvalPolicy.independent_verification_required,
        maker_checker_required: approvalPolicy.maker_checker_required,
        approval_policy: approvalPolicy,
      });
      await completed.commit();
      return {
        ...result,
        status: 'COMPLETED',
        approval_policy: approvalPolicy,
        administrator_verification_required: true,
        independent_verification_required: approvalPolicy.independent_verification_required,
        maker_checker_required: approvalPolicy.maker_checker_required,
      };
    } catch (error) {
      await completed.rollback().catch(() => {});
      throw error;
    } finally {
      completed.release();
    }
  } catch (error) {
    await pool.execute(
      `UPDATE backup_sets
          SET status = 'FAILED', failed_at = NOW(), failure_message_encrypted = ?,
              worker_lease_token_hash = NULL, worker_lease_expires_at = NULL, updated_by = ?
        WHERE id = ? AND worker_lease_token_hash = ?`,
      [protectedText(error.message || 'Backup worker failed.'), req.user.id, backupId, leaseHash]
    ).catch(() => {});
    throw error;
  }
}

router.post('/:backupId/run', async (req, res) => {
  try {
    const backupId = positiveId(req.params.backupId, 'backup_set_id');
    const result = await executeBackupSet(req, backupId);
    return res.json({
      message: 'Backup artifact created. Verify it with fresh step-up MFA.',
      backup_set_id: backupId,
      approval_policy: result.approval_policy,
      administrator_verification_required: true,
      independent_verification_required: result.independent_verification_required,
      maker_checker_required: result.maker_checker_required,
      result,
    });
  } catch (error) {
    return errorResponse(res, error, 'Failed to execute backup.');
  }
});

router.post('/:backupId/verify', async (req, res) => {
  const backupId = positiveId(req.params.backupId, 'backup_set_id');
  const connection = await pool.getConnection();
  let backup;
  let stepUp;
  let approvalPolicy = DEFAULT_ADMIN_APPROVAL_POLICY;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM backup_sets WHERE id = ? FOR UPDATE', [backupId]);
    backup = rows[0];
    if (!backup) throw new RecoveryError('Backup set not found.', 404, 'BACKUP_NOT_FOUND');
    approvalPolicy = await loadAdminApprovalPolicy(connection);
    if (backup.status !== 'COMPLETED') throw new RecoveryError('Only completed backups can be verified.', 409, 'BACKUP_NOT_READY');
    if (!backup.storage_location_encrypted || !backup.checksum) throw new RecoveryError('Backup artifact metadata is incomplete.', 409, 'BACKUP_ARTIFACT_MISSING');
    stepUp = await consumeBackupStepUpChallenge(connection, req, {
      challengeId: req.body?.step_up_challenge_id,
      challengeToken: req.body?.step_up_token,
      purpose: 'BACKUP_VERIFY',
      resourceType: 'BACKUP_SET',
      resourceId: backupId,
    });
    await connection.execute(
      `UPDATE backup_sets
          SET verification_status = 'VERIFYING', integrity_status = 'CHECKING',
              step_up_challenge_id = ?, step_up_verified_at = ?, updated_by = ?
        WHERE id = ?`,
      [stepUp.challengeId, stepUp.verifiedAt, req.user.id, backupId]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    connection.release();
    return errorResponse(res, error, 'Failed to start backup verification.');
  }
  connection.release();

  try {
    const verification = await runtime.verifyBackup({
      backupReference: backup.backup_reference,
      backupType: backup.backup_type,
      storageProvider: backup.storage_provider,
      storageLocation: revealText(backup.storage_location_encrypted),
      expectedChecksum: backup.checksum,
    });
    const valid = Boolean(verification.valid);
    const finalize = await pool.getConnection();
    try {
      await finalize.beginTransaction();
      await finalize.execute(
        `UPDATE backup_sets
            SET status = ?, verification_status = ?, integrity_status = ?,
                verified_checksum = ?, verified_by = ?, verified_at = ?, updated_by = ?
          WHERE id = ? AND verification_status = 'VERIFYING'`,
        [
          valid ? 'VERIFIED' : 'COMPLETED',
          valid ? 'MATCH' : 'MISMATCH',
          valid ? 'PASSED' : 'FAILED',
          verification.actualChecksum || null,
          valid ? req.user.id : null,
          valid ? new Date() : null,
          req.user.id,
          backupId,
        ]
      );
      if (valid && ['MODULE_STATE', 'DEPLOYMENT_VERSION', 'FULL_BACKUP'].includes(backup.backup_type)) {
        const modules = normalizeModules(parseJson(backup.included_modules, []));
        for (const moduleKey of modules) {
          const module = MODULE_MAP.get(moduleKey);
          const recoveryIdempotency = `recovery:${backupId}:${moduleKey}`;
          const recoveryReference = `RCP-${backup.backup_reference}-${moduleKey}`.slice(0, 80);
          const currentVersion = process.env.APP_VERSION || '1.0.0';
          const stableVersion = process.env[`MODULE_${moduleKey.toUpperCase()}_STABLE_VERSION`] || currentVersion;
          const rollbackAvailable = Boolean(
            module.rollback
            && ['DEPLOYMENT_VERSION', 'FULL_BACKUP'].includes(backup.backup_type)
          );
          const [healthRows] = await finalize.execute('SELECT status FROM system_health_checks WHERE module_key = ? LIMIT 1', [moduleKey]);
          await finalize.execute(
            `INSERT INTO module_recovery_points
               (idempotency_key, recovery_reference, module_key, module_name, current_version,
                stable_version, deployment_commit, artifact_location_encrypted, storage_provider,
                health_status_at_backup, backup_set_id, rollback_available, created_by, updated_by,
                status, artifact_checksum, checksum_algorithm, artifact_size_bytes,
                verification_status, integrity_status, verified_at, remarks_encrypted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, 'SHA-256', ?, 'MATCH', 'PASSED', NOW(), ?)
             ON DUPLICATE KEY UPDATE
               status = 'AVAILABLE', artifact_checksum = VALUES(artifact_checksum),
               verification_status = 'MATCH', integrity_status = 'PASSED', verified_at = NOW(),
               updated_by = VALUES(updated_by), updated_at = NOW()`,
            [
              recoveryIdempotency,
              recoveryReference,
              moduleKey,
              module.name,
              currentVersion,
              stableVersion,
              process.env.APP_COMMIT_SHA || process.env.GIT_COMMIT || 'local-dev',
              backup.storage_location_encrypted,
              backup.storage_provider,
              healthRows[0]?.status || 'UNKNOWN',
              backupId,
              rollbackAvailable ? 1 : 0,
              req.user.id,
              req.user.id,
              backup.checksum,
              backup.file_size,
              protectedText(`Verified recovery point from ${backup.backup_reference}.`),
            ]
          );
        }
      }
      await audit(finalize, req, `${valid ? 'VERIFY_BACKUP' : 'BACKUP_VERIFICATION_MISMATCH'}: ${backup.backup_reference}`, {
        backup_set_id: backupId,
        result: valid ? 'MATCH' : 'MISMATCH',
        checksum_algorithm: 'SHA-256',
        ...approvalAuditDetails(approvalPolicy, backup.created_by, req.user.id, stepUp),
      });
      await finalize.commit();
    } catch (error) {
      await finalize.rollback().catch(() => {});
      throw error;
    } finally {
      finalize.release();
    }
    if (!valid) return res.status(409).json({
      error: 'Backup checksum verification failed.',
      code: 'BACKUP_CHECKSUM_MISMATCH',
      approval_policy: approvalPolicy,
      administrator_verification_required: true,
      independent_verification_required: approvalPolicy.independent_verification_required,
      maker_checker_required: approvalPolicy.maker_checker_required,
    });
    return res.json({
      message: 'Backup artifact verified by the System Administrator with fresh step-up MFA.',
      backup_set_id: backupId,
      approval_policy: approvalPolicy,
      administrator_verification_required: true,
      independent_verification_required: approvalPolicy.independent_verification_required,
      maker_checker_required: approvalPolicy.maker_checker_required,
      verification,
    });
  } catch (error) {
    await pool.execute(
      `UPDATE backup_sets SET verification_status = 'ERROR', integrity_status = 'ERROR',
              failure_message_encrypted = ?, updated_by = ? WHERE id = ?`,
      [protectedText(error.message || 'Backup verification failed.'), req.user.id, backupId]
    ).catch(() => {});
    return errorResponse(res, error, 'Backup verification failed.');
  }
});

router.post('/:backupId/restore', async (req, res) => {
  let connection;
  try {
    connection = await acquireBackupConnection();
    if (String(req.body?.confirmation_phrase || '').trim() !== 'RESTORE') {
      throw new RecoveryError('Type RESTORE to confirm this recovery request.', 400, 'RESTORE_CONFIRMATION_REQUIRED');
    }
    const backupId = positiveId(req.params.backupId, 'backup_set_id');
    const key = idempotencyKey(req);
    const restoreType = normalizeEnum(req.body?.restore_type, RESTORE_TYPES, 'restore_type');
    const affectedModule = cleanText(req.body?.affected_module, 80) || null;
    const reason = cleanText(req.body?.reason, 2000);
    if (reason.length < 5) throw new RecoveryError('A restore reason is required.', 400, 'RESTORE_REASON_REQUIRED');
    if (affectedModule && !MODULE_MAP.has(affectedModule)) throw new RecoveryError('Affected module is invalid.', 400, 'INVALID_BACKUP_MODULE');
    const fingerprint = requestFingerprint('RESTORE_REQUEST', {
      affectedModule,
      backupId,
      reason,
      restoreType,
    });

    await connection.beginTransaction();
    const approvalPolicy = await loadAdminApprovalPolicy(connection);
    const [existing] = await connection.execute('SELECT id, request_fingerprint FROM restore_jobs WHERE idempotency_key = ? FOR UPDATE', [key]);
    if (existing.length) {
      assertIdempotentReplay(existing[0], fingerprint);
      const jobs = await listRestoreJobs(req.user.id, 200, connection);
      const job = jobs.find(item => Number(item.id) === Number(existing[0].id));
      await connection.commit();
      return res.json({
        message: 'Existing restore request returned for this idempotency key.',
        restore_job_id: existing[0].id,
        restore_job: job,
        approval_policy: approvalPolicy,
        idempotent_replay: true,
      });
    }
    const [backupRows] = await connection.execute('SELECT * FROM backup_sets WHERE id = ? FOR UPDATE', [backupId]);
    const backup = backupRows[0];
    if (!backup) throw new RecoveryError('Backup set not found.', 404, 'BACKUP_NOT_FOUND');
    if (!backupArtifactVerified(backup) || !['VERIFIED', 'RESTORED'].includes(backup.status)) {
      throw new RecoveryError('Only MFA-protected administrator-verified backup artifacts can be restored.', 409, 'BACKUP_NOT_VERIFIED');
    }
    if (backup.backup_type === 'DEPLOYMENT_VERSION') throw new RecoveryError('Deployment artifacts use the rollback workflow.', 409, 'USE_ROLLBACK_WORKFLOW');
    if (backup.backup_type !== 'FULL_BACKUP' && restoreType !== backup.backup_type) {
      throw new RecoveryError('Restore type must match the selected backup.', 400, 'RESTORE_TYPE_MISMATCH');
    }
    const includedModules = normalizeModules(parseJson(backup.included_modules, []));
    if (affectedModule && !includedModules.includes(affectedModule)) {
      throw new RecoveryError('Selected backup does not cover the affected module.', 409, 'BACKUP_MODULE_NOT_INCLUDED');
    }
    const [active] = await connection.execute(
      `SELECT id FROM restore_jobs
        WHERE backup_set_id = ? AND COALESCE(affected_module, '') = COALESCE(?, '')
          AND status IN ('AWAITING_APPROVAL','APPROVED','DRY_RUN_IN_PROGRESS','DRY_RUN_PASSED','IN_PROGRESS','VERIFYING')
        LIMIT 1 FOR UPDATE`,
      [backupId, affectedModule]
    );
    if (active.length) throw new RecoveryError('An active restore job already exists for this backup and module.', 409, 'RESTORE_ALREADY_ACTIVE');

    const [result] = await connection.execute(
      `INSERT INTO restore_jobs
         (idempotency_key, request_fingerprint, backup_set_id, restore_type, affected_module, status,
          approval_status, requested_by, reason_encrypted, result_message_encrypted,
          dry_run_status, integrity_status, expected_checksum, updated_by)
       VALUES (?, ?, ?, ?, ?, 'AWAITING_APPROVAL', 'PENDING', ?, ?, ?,
               'NOT_STARTED', 'NOT_CHECKED', ?, ?)`,
      [
        key,
        fingerprint,
        backupId,
        restoreType,
        affectedModule,
        req.user.id,
        protectedText(reason),
        protectedText('Awaiting System Administrator approval with fresh step-up MFA.'),
        backup.checksum,
        req.user.id,
      ]
    );
    await audit(connection, req, `REQUEST_RESTORE: ${backup.backup_reference}`, {
      restore_job_id: result.insertId,
      backup_set_id: backupId,
      restore_type: restoreType,
      affected_module: affectedModule,
      status: 'AWAITING_APPROVAL',
      approval_policy: approvalPolicy,
    });
    await connection.commit();
    return res.status(201).json({
      message: 'Restore request is awaiting MFA-protected System Administrator approval.',
      restore_job_id: result.insertId,
      status: 'AWAITING_APPROVAL',
      approval_policy: approvalPolicy,
      administrator_verification_required: true,
      independent_verification_required: approvalPolicy.independent_verification_required,
      maker_checker_required: approvalPolicy.maker_checker_required,
    });
  } catch (error) {
    await connection?.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to request restore.');
  } finally {
    connection?.release();
  }
});

router.post('/restore-jobs/:jobId/approve', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const jobId = positiveId(req.params.jobId, 'restore_job_id');
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM restore_jobs WHERE id = ? FOR UPDATE', [jobId]);
    const job = rows[0];
    if (!job) throw new RecoveryError('Restore job not found.', 404, 'RESTORE_NOT_FOUND');
    const approvalPolicy = await loadAdminApprovalPolicy(connection);
    assertTransition(RESTORE_TRANSITIONS, job.status, 'APPROVED', 'Restore job');
    const proof = await consumeBackupStepUpChallenge(connection, req, {
      challengeId: req.body?.step_up_challenge_id,
      challengeToken: req.body?.step_up_token,
      purpose: 'RESTORE_APPROVE',
      resourceType: 'RESTORE_JOB',
      resourceId: jobId,
    });
    await connection.execute(
      `UPDATE restore_jobs
          SET status = 'APPROVED', approval_status = 'APPROVED', approved_by = ?, approved_at = NOW(),
              approval_notes_encrypted = ?, step_up_challenge_id = ?, step_up_verified_at = ?,
              result_message_encrypted = ?, updated_by = ?
        WHERE id = ?`,
      [
        req.user.id,
        protectedText(req.body?.approval_notes || 'Restore approved after MFA-protected administrator review.'),
        proof.challengeId,
        proof.verifiedAt,
        protectedText('Approved. A successful isolated dry-run is required before execution.'),
        req.user.id,
        jobId,
      ]
    );
    await audit(connection, req, `APPROVE_RESTORE_JOB: ${jobId}`, {
      restore_job_id: jobId,
      status: 'APPROVED',
      ...approvalAuditDetails(approvalPolicy, job.requested_by, req.user.id, proof),
    });
    await connection.commit();
    return res.json({
      message: 'Restore approved with fresh step-up MFA. Run the isolated dry-run next.',
      restore_job_id: jobId,
      status: 'APPROVED',
      approval_policy: approvalPolicy,
      administrator_verification_required: true,
      independent_verification_required: approvalPolicy.independent_verification_required,
      maker_checker_required: approvalPolicy.maker_checker_required,
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to approve restore.');
  } finally { connection.release(); }
});

router.post('/restore-jobs/:jobId/dry-run', async (req, res) => {
  const jobId = positiveId(req.params.jobId, 'restore_job_id');
  const lease = workerLease();
  const connection = await pool.getConnection();
  let job;
  let backup;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT rj.*, bs.backup_reference, bs.backup_type, bs.storage_provider,
              bs.storage_location_encrypted, bs.checksum
         FROM restore_jobs rj JOIN backup_sets bs ON bs.id = rj.backup_set_id
        WHERE rj.id = ? FOR UPDATE`,
      [jobId]
    );
    job = rows[0];
    backup = rows[0];
    if (!job) throw new RecoveryError('Restore job not found.', 404, 'RESTORE_NOT_FOUND');
    if (job.approval_status !== 'APPROVED') throw new RecoveryError('Restore requires MFA-protected administrator approval.', 409, 'RESTORE_NOT_APPROVED');
    assertTransition(RESTORE_TRANSITIONS, job.status, 'DRY_RUN_IN_PROGRESS', 'Restore job');
    const proof = await consumeBackupStepUpChallenge(connection, req, {
      challengeId: req.body?.step_up_challenge_id,
      challengeToken: req.body?.step_up_token,
      purpose: 'RESTORE_DRY_RUN',
      resourceType: 'RESTORE_JOB',
      resourceId: jobId,
    });
    await connection.execute(
      `UPDATE restore_jobs
          SET status = 'DRY_RUN_IN_PROGRESS', dry_run_status = 'RUNNING',
              dry_run_started_at = NOW(), integrity_status = 'CHECKING',
              step_up_challenge_id = ?, step_up_verified_at = ?,
              worker_lease_token_hash=?, worker_lease_expires_at=DATE_ADD(NOW(), INTERVAL ${lease.minutes} MINUTE),
              updated_by = ?
        WHERE id = ?`,
      [proof.challengeId, proof.verifiedAt, lease.hash, req.user.id, jobId]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    connection.release();
    return errorResponse(res, error, 'Failed to start restore dry-run.');
  }
  connection.release();

  try {
    const report = await runtime.runRestoreDryRun({
      backupReference: backup.backup_reference,
      backupType: backup.backup_type,
      storageProvider: backup.storage_provider,
      storageLocation: revealText(backup.storage_location_encrypted),
      expectedChecksum: backup.checksum,
      affectedModule: job.affected_module,
    });
    const passed = Boolean(report.safeToRestore);
    await pool.execute(
      `UPDATE restore_jobs
          SET status = ?, dry_run_status = ?, dry_run_completed_at = NOW(),
              dry_run_target_encrypted = ?, dry_run_result_encrypted = ?,
              integrity_status = ?, integrity_checked_at = NOW(), integrity_report_encrypted = ?,
              result_message_encrypted = ?, worker_lease_token_hash=NULL,
              worker_lease_expires_at=NULL, updated_by = ?
        WHERE id = ? AND status = 'DRY_RUN_IN_PROGRESS' AND worker_lease_token_hash=?`,
      [
        passed ? 'DRY_RUN_PASSED' : 'FAILED',
        passed ? 'PASSED' : 'FAILED',
        protectedText(report.targetDatabase || report.target || 'isolated-validation'),
        protectedText(JSON.stringify(report)),
        passed ? 'PASSED' : 'FAILED',
        protectedText(JSON.stringify(report.databaseIntegrity || report.inventory || report.checks || {})),
        protectedText(passed ? 'Isolated restore dry-run passed.' : 'Isolated restore dry-run failed.'),
        req.user.id,
        jobId,
        lease.hash,
      ]
    );
    if (!passed) return res.status(409).json({ error: 'Restore dry-run failed integrity checks.', code: 'RESTORE_DRY_RUN_FAILED', report });
    return res.json({ message: 'Isolated restore dry-run passed.', restore_job_id: jobId, status: 'DRY_RUN_PASSED', report });
  } catch (error) {
    await pool.execute(
      `UPDATE restore_jobs SET status = 'FAILED', dry_run_status = 'FAILED', integrity_status = 'ERROR',
              failed_at = NOW(), failure_message_encrypted = ?, worker_lease_token_hash=NULL,
              worker_lease_expires_at=NULL, updated_by = ?
        WHERE id = ? AND (worker_lease_token_hash=? OR worker_lease_token_hash IS NULL)`,
      [protectedText(error.message || 'Restore dry-run failed.'), req.user.id, jobId, lease.hash]
    ).catch(() => {});
    return errorResponse(res, error, 'Restore dry-run failed.');
  }
});

router.post('/restore-jobs/:jobId/execute', async (req, res) => {
  const jobId = positiveId(req.params.jobId, 'restore_job_id');
  const lease = workerLease();
  if (String(req.body?.confirmation_phrase || '').trim() !== 'EXECUTE RESTORE') {
    return res.status(400).json({ error: 'Type EXECUTE RESTORE to apply the approved recovery.', code: 'RESTORE_EXECUTION_CONFIRMATION_REQUIRED' });
  }
  const connection = await pool.getConnection();
  let record;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT rj.*, bs.backup_reference, bs.backup_type, bs.storage_provider,
              bs.storage_location_encrypted, bs.checksum
         FROM restore_jobs rj JOIN backup_sets bs ON bs.id = rj.backup_set_id
        WHERE rj.id = ? FOR UPDATE`,
      [jobId]
    );
    record = rows[0];
    if (!record) throw new RecoveryError('Restore job not found.', 404, 'RESTORE_NOT_FOUND');
    if (record.approval_status !== 'APPROVED' || record.dry_run_status !== 'PASSED' || record.integrity_status !== 'PASSED') {
      throw new RecoveryError('Approved restore and a successful dry-run are required.', 409, 'RESTORE_PREREQUISITES_MISSING');
    }
    assertTransition(RESTORE_TRANSITIONS, record.status, 'IN_PROGRESS', 'Restore job');
    const proof = await consumeBackupStepUpChallenge(connection, req, {
      challengeId: req.body?.step_up_challenge_id,
      challengeToken: req.body?.step_up_token,
      purpose: 'RESTORE_EXECUTE',
      resourceType: 'RESTORE_JOB',
      resourceId: jobId,
    });
    await connection.execute(
      `UPDATE restore_jobs SET status = 'IN_PROGRESS', started_at = NOW(), attempt_count = attempt_count + 1,
              restore_target_encrypted = ?, step_up_challenge_id = ?, step_up_verified_at = ?,
              worker_lease_token_hash=?, worker_lease_expires_at=DATE_ADD(NOW(), INTERVAL ${lease.minutes} MINUTE),
              updated_by = ?
        WHERE id = ?`,
      [protectedText(process.env.BACKUP_RESTORE_DB_NAME || 'configured-recovery-target'), proof.challengeId, proof.verifiedAt, lease.hash, req.user.id, jobId]
    );
    await recordRecoveryHealth(connection, {
      moduleKey: record.affected_module,
      status: 'MAINTENANCE',
      remarks: `Controlled restore job ${jobId} is executing.`,
      actorId: req.user.id,
      operationReference: `restore-${jobId}-start`,
    });
    await audit(connection, req, `EXECUTE_RESTORE_JOB: ${jobId}`, { restore_job_id: jobId, status: 'IN_PROGRESS' });
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    connection.release();
    return errorResponse(res, error, 'Failed to start restore execution.');
  }
  connection.release();

  try {
    const result = await runtime.applyRestore({
      backupReference: record.backup_reference,
      backupType: record.backup_type,
      storageProvider: record.storage_provider,
      storageLocation: revealText(record.storage_location_encrypted),
      expectedChecksum: record.checksum,
      affectedModule: record.affected_module,
      newRdsInstanceIdentifier: record.storage_provider === 'RDS_SNAPSHOT'
        ? `lgsv-restore-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${jobId}`.slice(0, 63)
        : undefined,
    });
    if (result.pendingVerification || (result.initiated && !result.integrityPassed)) {
      await pool.execute(
        `UPDATE restore_jobs SET status='VERIFYING', integrity_status='CHECKING',
                restore_target_encrypted=?, result_message_encrypted=?, worker_lease_token_hash=NULL,
                worker_lease_expires_at=NULL, updated_by=?
          WHERE id=? AND status='IN_PROGRESS' AND worker_lease_token_hash=?`,
        [
          protectedText(result.newDbInstanceIdentifier || 'isolated-rds-recovery-target'),
          protectedText('Restore target was created and is awaiting post-restore integrity verification.'),
          req.user.id,
          jobId,
          lease.hash,
        ]
      );
      return res.status(202).json({
        message: 'Restore target created. Post-restore integrity verification is pending.',
        restore_job_id: jobId,
        status: 'VERIFYING',
        result,
      });
    }
    const integrityPassed = result.integrityPassed === true || Boolean(
      result.restored
      && result.artifactVerification?.valid
      && (result.databaseRestore?.restored !== false)
    );
    const finalize = await pool.getConnection();
    try {
      await finalize.beginTransaction();
      await finalize.execute(
        `UPDATE restore_jobs SET status='VERIFYING', integrity_status='CHECKING', updated_by=?
          WHERE id=? AND status='IN_PROGRESS' AND worker_lease_token_hash=?`,
        [req.user.id, jobId, lease.hash]
      );
      await finalize.execute(
        `UPDATE restore_jobs
            SET status = ?, integrity_status = ?, integrity_checked_at = NOW(), integrity_report_encrypted = ?,
                restored_checksum = ?, result_message_encrypted = ?, completed_at = NOW(),
                worker_lease_token_hash=NULL, worker_lease_expires_at=NULL, updated_by = ?
          WHERE id = ? AND status = 'VERIFYING' AND worker_lease_token_hash=?`,
        [
          integrityPassed ? 'COMPLETED' : 'FAILED',
          integrityPassed ? 'PASSED' : 'FAILED',
          protectedText(JSON.stringify(result.integrityReport || result.databaseIntegrity || result)),
          integrityPassed ? record.checksum : null,
          protectedText(integrityPassed ? 'Restore completed and post-restore integrity checks passed.' : 'Restore completed but integrity validation failed.'),
          req.user.id,
          jobId,
          lease.hash,
        ]
      );
      if (integrityPassed) {
        await finalize.execute('UPDATE backup_sets SET status = \'RESTORED\', restored_at = NOW(), updated_by = ? WHERE id = ?', [req.user.id, record.backup_set_id]);
      }
      await recordRecoveryHealth(finalize, {
        moduleKey: record.affected_module,
        status: integrityPassed ? 'WARNING' : 'OFFLINE',
        remarks: integrityPassed
          ? `Restore job ${jobId} passed integrity checks. Run a fresh module health check before returning it to normal service.`
          : `Restore job ${jobId} failed post-restore integrity checks.`,
        actorId: req.user.id,
        operationReference: `restore-${jobId}-complete`,
      });
      await audit(finalize, req, `${integrityPassed ? 'COMPLETE_RESTORE_JOB' : 'FAIL_RESTORE_INTEGRITY'}: ${jobId}`, {
        restore_job_id: jobId,
        integrity_status: integrityPassed ? 'PASSED' : 'FAILED',
      });
      await finalize.commit();
    } catch (error) {
      await finalize.rollback().catch(() => {});
      throw error;
    } finally { finalize.release(); }
    if (!integrityPassed) return res.status(409).json({ error: 'Post-restore integrity verification failed.', code: 'RESTORE_INTEGRITY_FAILED' });
    return res.json({ message: 'Restore completed and integrity verified.', restore_job_id: jobId, status: 'COMPLETED', result });
  } catch (error) {
    await pool.execute(
      `UPDATE restore_jobs SET status='FAILED', integrity_status='ERROR', failed_at=NOW(),
              failure_message_encrypted=?, worker_lease_token_hash=NULL, worker_lease_expires_at=NULL,
              updated_by=? WHERE id=? AND (worker_lease_token_hash=? OR worker_lease_token_hash IS NULL)`,
      [protectedText(error.message || 'Restore execution failed.'), req.user.id, jobId, lease.hash]
    ).catch(() => {});
    await recordRecoveryHealth(pool, {
      moduleKey: record?.affected_module,
      status: 'OFFLINE',
      remarks: `Restore job ${jobId} failed and requires administrator review.`,
      actorId: req.user.id,
      operationReference: `restore-${jobId}-failed`,
    }).catch(() => {});
    return errorResponse(res, error, 'Restore execution failed.');
  }
});

router.post('/restore-jobs/:jobId/verify-target', async (req, res) => {
  const jobId = positiveId(req.params.jobId, 'restore_job_id');
  const connection = await pool.getConnection();
  let record;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT rj.*, bs.backup_reference, bs.backup_type, bs.storage_provider,
              bs.storage_location_encrypted, bs.adapter_metadata_encrypted, bs.checksum
         FROM restore_jobs rj JOIN backup_sets bs ON bs.id=rj.backup_set_id
        WHERE rj.id=? FOR UPDATE`,
      [jobId]
    );
    record = rows[0];
    if (!record) throw new RecoveryError('Restore job not found.', 404, 'RESTORE_NOT_FOUND');
    if (record.status !== 'VERIFYING' || record.storage_provider !== 'RDS_SNAPSHOT') {
      throw new RecoveryError('Only a pending RDS restore target can be verified.', 409, 'RESTORE_TARGET_NOT_PENDING');
    }
    const proof = await consumeBackupStepUpChallenge(connection, req, {
      challengeId: req.body?.step_up_challenge_id,
      challengeToken: req.body?.step_up_token,
      purpose: 'RESTORE_VERIFY',
      resourceType: 'RESTORE_JOB',
      resourceId: jobId,
    });
    await connection.execute(
      `UPDATE restore_jobs
          SET integrity_status='CHECKING', step_up_challenge_id=?, step_up_verified_at=?, updated_by=?
        WHERE id=? AND status='VERIFYING'`,
      [proof.challengeId, proof.verifiedAt, req.user.id, jobId]
    );
    await audit(connection, req, `VERIFY_RDS_RESTORE_TARGET: ${jobId}`, { restore_job_id: jobId, status: 'VERIFYING' });
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    connection.release();
    return errorResponse(res, error, 'Failed to start RDS restore verification.');
  }
  connection.release();

  try {
    const adapterMetadata = parseJson(revealText(record.adapter_metadata_encrypted), {});
    const result = await runtime.verifyPendingRestore({
      backupType: record.backup_type,
      storageProvider: record.storage_provider,
      storageLocation: revealText(record.storage_location_encrypted),
      expectedChecksum: record.checksum,
      restoreTarget: revealText(record.restore_target_encrypted),
      expectedIntegrity: adapterMetadata.integrityReport || null,
    });
    if (result.pendingVerification) {
      await pool.execute(
        `UPDATE restore_jobs SET integrity_status='CHECKING', result_message_encrypted=?, updated_by=?
          WHERE id=? AND status='VERIFYING'`,
        [protectedText('The isolated RDS recovery instance is not available yet. Verification remains pending.'), req.user.id, jobId]
      );
      return res.status(202).json({
        message: 'RDS recovery instance is still becoming available.',
        restore_job_id: jobId,
        status: 'VERIFYING',
        result,
      });
    }

    const passed = result.integrityPassed === true;
    const finalize = await pool.getConnection();
    try {
      await finalize.beginTransaction();
      await finalize.execute(
        `UPDATE restore_jobs
            SET status=?, integrity_status=?, integrity_checked_at=NOW(), integrity_report_encrypted=?,
                restored_checksum=?, result_message_encrypted=?, completed_at=CASE WHEN ? THEN NOW() ELSE completed_at END,
                failed_at=CASE WHEN ? THEN failed_at ELSE NOW() END, updated_by=?
          WHERE id=? AND status='VERIFYING'`,
        [
          passed ? 'COMPLETED' : 'FAILED',
          passed ? 'PASSED' : 'FAILED',
          protectedText(JSON.stringify(result.integrityReport || result)),
          passed ? record.checksum : null,
          protectedText(passed
            ? 'RDS restore completed and database integrity verification passed.'
            : 'RDS restore target failed post-restore integrity verification.'),
          passed ? 1 : 0,
          passed ? 1 : 0,
          req.user.id,
          jobId,
        ]
      );
      if (passed) {
        await finalize.execute(
          "UPDATE backup_sets SET status='RESTORED', restored_at=NOW(), updated_by=? WHERE id=?",
          [req.user.id, record.backup_set_id]
        );
      }
      await recordRecoveryHealth(finalize, {
        moduleKey: record.affected_module,
        status: passed ? 'WARNING' : 'OFFLINE',
        remarks: passed
          ? `RDS restore job ${jobId} passed database integrity checks. Run a fresh module health check before cutover.`
          : `RDS restore job ${jobId} failed database integrity checks.`,
        actorId: req.user.id,
        operationReference: `rds-restore-${jobId}-verified`,
      });
      await audit(finalize, req, `${passed ? 'COMPLETE_RDS_RESTORE' : 'FAIL_RDS_RESTORE_INTEGRITY'}: ${jobId}`, {
        restore_job_id: jobId,
        integrity_status: passed ? 'PASSED' : 'FAILED',
      });
      await finalize.commit();
    } catch (error) {
      await finalize.rollback().catch(() => {});
      throw error;
    } finally {
      finalize.release();
    }
    if (!passed) return res.status(409).json({ error: 'RDS post-restore integrity verification failed.', code: 'RESTORE_INTEGRITY_FAILED' });
    return res.json({ message: 'RDS restore completed and integrity verified.', restore_job_id: jobId, status: 'COMPLETED', result });
  } catch (error) {
    await pool.execute(
      `UPDATE restore_jobs SET integrity_status='ERROR', failure_message_encrypted=?, updated_by=?
        WHERE id=? AND status='VERIFYING'`,
      [protectedText(error.message || 'RDS restore verification failed.'), req.user.id, jobId]
    ).catch(() => {});
    return errorResponse(res, error, 'RDS restore verification failed.');
  }
});

router.post('/rollback-requests', async (req, res) => {
  let connection;
  try {
    connection = await acquireBackupConnection();
    const key = idempotencyKey(req);
    const affectedModule = cleanText(req.body?.affected_module, 80);
    const module = MODULE_MAP.get(affectedModule);
    if (!module || !module.rollback) throw new RecoveryError('Affected module does not support rollback.', 400, 'ROLLBACK_MODULE_INVALID');
    const recoveryPointId = positiveId(req.body?.recovery_point_id, 'recovery_point_id');
    const reason = cleanText(req.body?.reason, 2000);
    if (reason.length < 5) throw new RecoveryError('A rollback reason is required.', 400, 'ROLLBACK_REASON_REQUIRED');
    const fingerprint = requestFingerprint('ROLLBACK_REQUEST', {
      affectedModule,
      reason,
      recoveryPointId,
    });
    await connection.beginTransaction();
    const approvalPolicy = await loadAdminApprovalPolicy(connection);
    const [existing] = await connection.execute('SELECT id, request_fingerprint FROM module_rollback_requests WHERE idempotency_key = ? FOR UPDATE', [key]);
    if (existing.length) {
      assertIdempotentReplay(existing[0], fingerprint);
      await connection.commit();
      return res.json({
        message: 'Existing rollback request returned for this idempotency key.',
        rollback_request_id: existing[0].id,
        approval_policy: approvalPolicy,
        idempotent_replay: true,
      });
    }
    const [points] = await connection.execute(
      `SELECT mrp.*, bs.backup_reference, bs.backup_type
         FROM module_recovery_points mrp JOIN backup_sets bs ON bs.id=mrp.backup_set_id
        WHERE mrp.id=? AND mrp.module_key=? AND mrp.status='AVAILABLE' AND mrp.rollback_available=1
          AND mrp.verification_status='MATCH' AND mrp.integrity_status='PASSED'
          AND mrp.verified_at IS NOT NULL AND bs.status IN ('VERIFIED','RESTORED')
          AND bs.backup_type IN ('DEPLOYMENT_VERSION','FULL_BACKUP')
        LIMIT 1 FOR UPDATE`,
      [recoveryPointId, affectedModule]
    );
    const point = points[0];
    if (!point) throw new RecoveryError('No verified recovery point is available for this module.', 409, 'RECOVERY_POINT_NOT_VERIFIED');
    const [active] = await connection.execute(
      `SELECT id FROM module_rollback_requests WHERE affected_module=?
        AND status IN ('AWAITING_APPROVAL','APPROVED','IN_PROGRESS','VERIFYING') LIMIT 1 FOR UPDATE`,
      [affectedModule]
    );
    if (active.length) throw new RecoveryError('An active rollback request already exists for this module.', 409, 'ROLLBACK_ALREADY_ACTIVE');
    const [result] = await connection.execute(
      `INSERT INTO module_rollback_requests
         (idempotency_key, request_fingerprint, recovery_point_id, affected_module, current_version, target_version,
          artifact_location_encrypted, artifact_checksum, checksum_algorithm, reason_encrypted,
          status, approval_status, requested_by, verification_status, integrity_status, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SHA-256', ?, 'AWAITING_APPROVAL', 'PENDING', ?, 'MATCH', 'PASSED', ?)`,
      [
        key,
        fingerprint,
        point.id,
        affectedModule,
        process.env.APP_VERSION || point.current_version,
        point.stable_version || point.current_version,
        point.artifact_location_encrypted,
        point.artifact_checksum,
        protectedText(reason),
        req.user.id,
        req.user.id,
      ]
    );
    await audit(connection, req, `REQUEST_MODULE_ROLLBACK: ${affectedModule}`, {
      rollback_request_id: result.insertId,
      recovery_point_id: point.id,
      status: 'AWAITING_APPROVAL',
      approval_policy: approvalPolicy,
    });
    await connection.commit();
    return res.status(201).json({
      message: 'Rollback request is awaiting MFA-protected System Administrator approval.',
      rollback_request_id: result.insertId,
      status: 'AWAITING_APPROVAL',
      approval_policy: approvalPolicy,
      administrator_verification_required: true,
      independent_verification_required: approvalPolicy.independent_verification_required,
      maker_checker_required: approvalPolicy.maker_checker_required,
    });
  } catch (error) {
    await connection?.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to request rollback.');
  } finally { connection?.release(); }
});

router.post('/rollback-requests/:requestId/approve', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const requestId = positiveId(req.params.requestId, 'rollback_request_id');
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM module_rollback_requests WHERE id=? FOR UPDATE', [requestId]);
    const request = rows[0];
    if (!request) throw new RecoveryError('Rollback request not found.', 404, 'ROLLBACK_NOT_FOUND');
    const approvalPolicy = await loadAdminApprovalPolicy(connection);
    assertTransition(ROLLBACK_TRANSITIONS, request.status, 'APPROVED', 'Rollback request');
    const proof = await consumeBackupStepUpChallenge(connection, req, {
      challengeId: req.body?.step_up_challenge_id,
      challengeToken: req.body?.step_up_token,
      purpose: 'ROLLBACK_APPROVE',
      resourceType: 'ROLLBACK_REQUEST',
      resourceId: requestId,
    });
    await connection.execute(
      `UPDATE module_rollback_requests
          SET status='APPROVED', approval_status='APPROVED', approved_by=?, approved_at=NOW(),
              approval_notes_encrypted=?, step_up_challenge_id=?, step_up_verified_at=?, updated_by=?
        WHERE id=?`,
      [
        req.user.id,
        protectedText(req.body?.approval_notes || 'Rollback approved after MFA-protected recovery-point review.'),
        proof.challengeId,
        proof.verifiedAt,
        req.user.id,
        requestId,
      ]
    );
    await audit(connection, req, `APPROVE_MODULE_ROLLBACK: ${request.affected_module}`, {
      rollback_request_id: requestId,
      status: 'APPROVED',
      ...approvalAuditDetails(approvalPolicy, request.requested_by, req.user.id, proof),
    });
    await connection.commit();
    return res.json({
      message: 'Rollback approved with fresh step-up MFA.',
      rollback_request_id: requestId,
      status: 'APPROVED',
      approval_policy: approvalPolicy,
      administrator_verification_required: true,
      independent_verification_required: approvalPolicy.independent_verification_required,
      maker_checker_required: approvalPolicy.maker_checker_required,
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to approve rollback.');
  } finally { connection.release(); }
});

router.post('/rollback-requests/:requestId/execute', async (req, res) => {
  const requestId = positiveId(req.params.requestId, 'rollback_request_id');
  const lease = workerLease();
  if (String(req.body?.confirmation_phrase || '').trim() !== 'EXECUTE ROLLBACK') {
    return res.status(400).json({ error: 'Type EXECUTE ROLLBACK to apply the approved recovery point.', code: 'ROLLBACK_CONFIRMATION_REQUIRED' });
  }
  const connection = await pool.getConnection();
  let record;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT mrr.*, mrp.storage_provider, bs.backup_reference, bs.backup_type
         FROM module_rollback_requests mrr
         JOIN module_recovery_points mrp ON mrp.id=mrr.recovery_point_id
         JOIN backup_sets bs ON bs.id=mrp.backup_set_id
        WHERE mrr.id=? FOR UPDATE`,
      [requestId]
    );
    record = rows[0];
    if (!record) throw new RecoveryError('Rollback request not found.', 404, 'ROLLBACK_NOT_FOUND');
    if (record.approval_status !== 'APPROVED' || record.verification_status !== 'MATCH' || record.integrity_status !== 'PASSED') {
      throw new RecoveryError('Approved rollback with a verified recovery point is required.', 409, 'ROLLBACK_PREREQUISITES_MISSING');
    }
    assertTransition(ROLLBACK_TRANSITIONS, record.status, 'IN_PROGRESS', 'Rollback request');
    const proof = await consumeBackupStepUpChallenge(connection, req, {
      challengeId: req.body?.step_up_challenge_id,
      challengeToken: req.body?.step_up_token,
      purpose: 'ROLLBACK_EXECUTE',
      resourceType: 'ROLLBACK_REQUEST',
      resourceId: requestId,
    });
    await connection.execute(
      `UPDATE module_rollback_requests
          SET status='IN_PROGRESS', started_at=NOW(), attempt_count=attempt_count+1,
              step_up_challenge_id=?, step_up_verified_at=?, worker_lease_token_hash=?,
              worker_lease_expires_at=DATE_ADD(NOW(), INTERVAL ${lease.minutes} MINUTE), updated_by=? WHERE id=?`,
      [proof.challengeId, proof.verifiedAt, lease.hash, req.user.id, requestId]
    );
    await recordRecoveryHealth(connection, {
      moduleKey: record.affected_module,
      status: 'MAINTENANCE',
      remarks: `Controlled rollback request ${requestId} is executing.`,
      actorId: req.user.id,
      operationReference: `rollback-${requestId}-start`,
    });
    await audit(connection, req, `EXECUTE_MODULE_ROLLBACK: ${record.affected_module}`, { rollback_request_id: requestId, status: 'IN_PROGRESS' });
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    connection.release();
    return errorResponse(res, error, 'Failed to start rollback.');
  }
  connection.release();

  try {
    const result = await runtime.applyRestore({
      backupReference: record.backup_reference,
      backupType: record.backup_type,
      storageProvider: record.storage_provider,
      storageLocation: revealText(record.artifact_location_encrypted),
      expectedChecksum: record.artifact_checksum,
      affectedModule: record.affected_module,
      rollback: true,
    });
    const passed = result.restored === true && result.integrityPassed === true && result.verified === true;
    const finalize = await pool.getConnection();
    try {
      await finalize.beginTransaction();
      await finalize.execute(
        "UPDATE module_rollback_requests SET status='VERIFYING', integrity_status='CHECKING', updated_by=? WHERE id=? AND status='IN_PROGRESS' AND worker_lease_token_hash=?",
        [req.user.id, requestId, lease.hash]
      );
      await finalize.execute(
        `UPDATE module_rollback_requests SET status=?, integrity_status=?, integrity_checked_at=NOW(),
                integrity_report_encrypted=?, result_message_encrypted=?, completed_at=NOW(),
                worker_lease_token_hash=NULL, worker_lease_expires_at=NULL, updated_by=?
          WHERE id=? AND status='VERIFYING' AND worker_lease_token_hash=?`,
        [
          passed ? 'COMPLETED' : 'FAILED',
          passed ? 'PASSED' : 'FAILED',
          protectedText(JSON.stringify(result.integrityReport || result)),
          protectedText(passed
            ? `Module source-code rollback completed and integrity checks passed.${result.restartRequired ? ' Application restart required.' : ''}`
            : 'Rollback integrity verification failed.'),
          req.user.id,
          requestId,
          lease.hash,
        ]
      );
      await audit(finalize, req, `${passed ? 'COMPLETE_MODULE_ROLLBACK' : 'FAIL_MODULE_ROLLBACK'}: ${record.affected_module}`, {
        rollback_request_id: requestId,
        integrity_status: passed ? 'PASSED' : 'FAILED',
      });
      await recordRecoveryHealth(finalize, {
        moduleKey: record.affected_module,
        status: passed ? 'WARNING' : 'OFFLINE',
        remarks: passed
          ? `Rollback request ${requestId} replaced verified module source code and passed integrity checks.${result.restartRequired ? ' Restart the application before' : ' Run'} a fresh module health check before returning it to normal service.`
          : `Rollback request ${requestId} failed integrity checks.`,
        actorId: req.user.id,
        operationReference: `rollback-${requestId}-complete`,
      });
      await finalize.commit();
    } catch (error) {
      await finalize.rollback().catch(() => {});
      throw error;
    } finally { finalize.release(); }
    if (!passed) return res.status(409).json({ error: 'Rollback integrity verification failed.', code: 'ROLLBACK_INTEGRITY_FAILED' });
    return res.json({
      message: result.restartRequired
        ? 'Module code rollback completed and verified. Restart the application, then run a fresh health check.'
        : 'Module code rollback completed and integrity verified.',
      rollback_request_id: requestId,
      status: 'COMPLETED',
      restart_required: Boolean(result.restartRequired),
      result,
    });
  } catch (error) {
    await pool.execute(
      `UPDATE module_rollback_requests SET status='FAILED', integrity_status='ERROR', failed_at=NOW(),
              failure_message_encrypted=?, worker_lease_token_hash=NULL, worker_lease_expires_at=NULL,
              updated_by=? WHERE id=? AND (worker_lease_token_hash=? OR worker_lease_token_hash IS NULL)`,
      [protectedText(error.message || 'Rollback execution failed.'), req.user.id, requestId, lease.hash]
    ).catch(() => {});
    await recordRecoveryHealth(pool, {
      moduleKey: record?.affected_module,
      status: 'OFFLINE',
      remarks: `Rollback request ${requestId} failed and requires administrator review.`,
      actorId: req.user.id,
      operationReference: `rollback-${requestId}-failed`,
    }).catch(() => {});
    return errorResponse(res, error, 'Rollback execution failed.');
  }
});

router.patch('/restore-jobs/:jobId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const jobId = positiveId(req.params.jobId, 'restore_job_id');
    const status = String(req.body?.status || '').trim().toUpperCase();
    if (!['REJECTED', 'CANCELLED'].includes(status)) {
      throw new RecoveryError('Use the approve, dry-run, and execute endpoints for restore lifecycle changes.', 409, 'CONTROLLED_RESTORE_ACTION_REQUIRED');
    }
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM restore_jobs WHERE id=? FOR UPDATE', [jobId]);
    const job = rows[0];
    if (!job) throw new RecoveryError('Restore job not found.', 404, 'RESTORE_NOT_FOUND');
    assertTransition(RESTORE_TRANSITIONS, job.status, status, 'Restore job');
    let proof = null;
    let approvalPolicy = null;
    if (status === 'REJECTED') {
      approvalPolicy = await loadAdminApprovalPolicy(connection);
      proof = await consumeBackupStepUpChallenge(connection, req, {
        challengeId: req.body?.step_up_challenge_id,
        challengeToken: req.body?.step_up_token,
        purpose: 'RESTORE_APPROVE',
        resourceType: 'RESTORE_JOB',
        resourceId: jobId,
      });
    } else if (!sameActor(job.requested_by, req.user.id) && !sameActor(job.approved_by, req.user.id)) {
      throw new RecoveryError('Only the requester or approver can cancel this restore.', 403, 'RESTORE_CANCEL_FORBIDDEN');
    }
    await connection.execute(
      `UPDATE restore_jobs SET status=?, approval_status=?, rejected_by=?, rejected_at=?,
              cancelled_at=?, step_up_challenge_id=COALESCE(?,step_up_challenge_id),
              step_up_verified_at=COALESCE(?,step_up_verified_at), result_message_encrypted=?, updated_by=? WHERE id=?`,
      [
        status,
        status === 'REJECTED' ? 'REJECTED' : job.approval_status,
        status === 'REJECTED' ? req.user.id : null,
        status === 'REJECTED' ? new Date() : null,
        status === 'CANCELLED' ? new Date() : null,
        proof?.challengeId || null,
        proof?.verifiedAt || null,
        protectedText(req.body?.result_message || `${status} by authorized administrator.`),
        req.user.id,
        jobId,
      ]
    );
    await audit(connection, req, `${status}_RESTORE_JOB: ${jobId}`, {
      restore_job_id: jobId,
      status,
      ...(approvalPolicy ? approvalAuditDetails(approvalPolicy, job.requested_by, req.user.id, proof) : {}),
    });
    await connection.commit();
    return res.json({
      message: `Restore job ${status.toLowerCase()}${status === 'REJECTED' ? ' with fresh step-up MFA' : ''}.`,
      restore_job_id: jobId,
      status,
      ...(approvalPolicy ? {
        approval_policy: approvalPolicy,
        administrator_verification_required: true,
        independent_verification_required: approvalPolicy.independent_verification_required,
        maker_checker_required: approvalPolicy.maker_checker_required,
      } : {}),
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to update restore job.');
  } finally { connection.release(); }
});

router.patch('/rollback-requests/:requestId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const requestId = positiveId(req.params.requestId, 'rollback_request_id');
    const status = String(req.body?.status || '').trim().toUpperCase();
    if (!['REJECTED', 'CANCELLED'].includes(status)) {
      throw new RecoveryError('Use the approve and execute endpoints for rollback lifecycle changes.', 409, 'CONTROLLED_ROLLBACK_ACTION_REQUIRED');
    }
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM module_rollback_requests WHERE id=? FOR UPDATE', [requestId]);
    const request = rows[0];
    if (!request) throw new RecoveryError('Rollback request not found.', 404, 'ROLLBACK_NOT_FOUND');
    assertTransition(ROLLBACK_TRANSITIONS, request.status, status, 'Rollback request');
    let proof = null;
    let approvalPolicy = null;
    if (status === 'REJECTED') {
      approvalPolicy = await loadAdminApprovalPolicy(connection);
      proof = await consumeBackupStepUpChallenge(connection, req, {
        challengeId: req.body?.step_up_challenge_id,
        challengeToken: req.body?.step_up_token,
        purpose: 'ROLLBACK_APPROVE',
        resourceType: 'ROLLBACK_REQUEST',
        resourceId: requestId,
      });
    } else if (!sameActor(request.requested_by, req.user.id) && !sameActor(request.approved_by, req.user.id)) {
      throw new RecoveryError('Only the requester or approver can cancel this rollback.', 403, 'ROLLBACK_CANCEL_FORBIDDEN');
    }
    await connection.execute(
      `UPDATE module_rollback_requests SET status=?, approval_status=?, rejected_by=?, rejected_at=?,
              cancelled_at=?, step_up_challenge_id=COALESCE(?,step_up_challenge_id),
              step_up_verified_at=COALESCE(?,step_up_verified_at), result_message_encrypted=?, updated_by=? WHERE id=?`,
      [
        status,
        status === 'REJECTED' ? 'REJECTED' : request.approval_status,
        status === 'REJECTED' ? req.user.id : null,
        status === 'REJECTED' ? new Date() : null,
        status === 'CANCELLED' ? new Date() : null,
        proof?.challengeId || null,
        proof?.verifiedAt || null,
        protectedText(req.body?.result_message || `${status} by authorized administrator.`),
        req.user.id,
        requestId,
      ]
    );
    await audit(connection, req, `${status}_MODULE_ROLLBACK: ${request.affected_module}`, {
      rollback_request_id: requestId,
      status,
      ...(approvalPolicy ? approvalAuditDetails(approvalPolicy, request.requested_by, req.user.id, proof) : {}),
    });
    await connection.commit();
    return res.json({
      message: `Rollback request ${status.toLowerCase()}${status === 'REJECTED' ? ' with fresh step-up MFA' : ''}.`,
      rollback_request_id: requestId,
      status,
      ...(approvalPolicy ? {
        approval_policy: approvalPolicy,
        administrator_verification_required: true,
        independent_verification_required: approvalPolicy.independent_verification_required,
        maker_checker_required: approvalPolicy.maker_checker_required,
      } : {}),
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to update rollback request.');
  } finally { connection.release(); }
});

router.patch('/:backupId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const backupId = positiveId(req.params.backupId, 'backup_set_id');
    const requestedStatus = req.body?.status ? String(req.body.status).trim().toUpperCase() : null;
    const notesProvided = req.body?.notes !== undefined;
    if (requestedStatus && requestedStatus !== 'CANCELLED') {
      throw new RecoveryError('Use the run and administrator verification endpoints for lifecycle changes.', 409, 'CONTROLLED_BACKUP_ACTION_REQUIRED');
    }
    if (!requestedStatus && !notesProvided) throw new RecoveryError('No backup updates provided.', 400, 'NO_BACKUP_UPDATE');
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM backup_sets WHERE id=? FOR UPDATE', [backupId]);
    const backup = rows[0];
    if (!backup) throw new RecoveryError('Backup set not found.', 404, 'BACKUP_NOT_FOUND');
    if (requestedStatus) assertTransition(BACKUP_TRANSITIONS, backup.status, requestedStatus, 'Backup');
    await connection.execute(
      `UPDATE backup_sets SET status=COALESCE(?,status), cancelled_at=CASE WHEN ?='CANCELLED' THEN NOW() ELSE cancelled_at END,
              remarks_encrypted=CASE WHEN ? THEN ? ELSE remarks_encrypted END, updated_by=? WHERE id=?`,
      [requestedStatus, requestedStatus, notesProvided ? 1 : 0, notesProvided ? protectedText(req.body.notes) : null, req.user.id, backupId]
    );
    await audit(connection, req, `${requestedStatus || 'UPDATE'}_BACKUP: ${backup.backup_reference}`, { backup_set_id: backupId, status: requestedStatus, notes_updated: notesProvided });
    await connection.commit();
    return res.json({ message: 'Backup record updated.', backup_set_id: backupId, status: requestedStatus || backup.status });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to update backup.');
  } finally { connection.release(); }
});

if (process.env.NODE_ENV !== 'test' && String(process.env.BACKUP_RECOVERY_REAPER_ENABLED || 'true').toLowerCase() !== 'false') {
  const configuredInterval = Number.parseInt(process.env.BACKUP_RECOVERY_REAPER_INTERVAL_MS || '300000', 10);
  const intervalMs = Number.isFinite(configuredInterval) ? Math.min(Math.max(configuredInterval, 60000), 3600000) : 300000;
  const runReaper = () => recoverExpiredOperations().catch(error => {
    console.error('[backup-recovery-reaper]', error.message);
  });
  const initialTimer = setTimeout(runReaper, 10000);
  initialTimer.unref?.();
  const reaperTimer = setInterval(runReaper, intervalMs);
  reaperTimer.unref?.();
}

if (process.env.NODE_ENV !== 'test' && String(process.env.BACKUP_AUTOMATION_SERVICE_ENABLED || 'true').toLowerCase() !== 'false') {
  backupAutomation.start();
}

module.exports = router;
module.exports._test = {
  BACKUP_TRANSITIONS,
  RESTORE_TRANSITIONS,
  ROLLBACK_TRANSITIONS,
  adminApprovalPolicyFromCount,
  backupArtifactAvailable,
  backupArtifactVerified,
  acquireConnectionWithTimeout,
  backupDatabaseAcquireTimeoutMs,
  backupResponse,
  booleanInput,
  clampPaginationToTotal,
  drillMutation,
  normalizeAutomationTiming,
  paginationOptions,
  retentionMutation,
  scheduleMutation,
  recoverExpiredOperations,
  assertIdempotentReplay,
  assertTransition,
  loadAdminApprovalPolicy,
  requestFingerprint,
  restoreResponse,
  rollbackResponse,
  workerLease,
};
