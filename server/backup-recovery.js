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
const { createBackupRuntimeFromEnv } = require('../services/backup');

const router = express.Router();
const runtime = createBackupRuntimeFromEnv();

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

function sameActor(left, right) {
  return Number(left || 0) > 0 && Number(left) === Number(right || 0);
}

function assertMakerChecker(requestedBy, actorId) {
  if (sameActor(requestedBy, actorId)) {
    throw new RecoveryError('The requester cannot approve or verify their own recovery action.', 409, 'MAKER_CHECKER_REQUIRED');
  }
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

function backupArtifactAvailable(row) {
  return Boolean(row.storage_location_encrypted && row.checksum && ['COMPLETED', 'VERIFIED', 'RESTORED'].includes(row.status));
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

function backupResponse(row, actorId = null) {
  const artifactAvailable = backupArtifactAvailable(row);
  const artifactVerified = backupArtifactVerified(row);
  const isRestorable = artifactVerified && ['VERIFIED', 'RESTORED'].includes(row.status) && row.backup_type !== 'DEPLOYMENT_VERSION';
  const includedModules = normalizeModules(parseJson(row.included_modules, []));
  const allowedActions = [];
  if (['PENDING', 'FAILED'].includes(row.status)) allowedActions.push('run');
  if (row.status === 'COMPLETED' && !sameActor(row.created_by, actorId)) allowedActions.push('verify');
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
    failed_at: row.failed_at,
    failure_message: revealText(row.failure_message_encrypted),
    remarks: revealText(row.remarks_encrypted),
    adapter_metadata: parseJson(revealText(row.adapter_metadata_encrypted), null),
    allowed_actions: allowedActions,
    can_verify: allowedActions.includes('verify'),
    can_restore: allowedActions.includes('restore'),
  };
}

function restoreResponse(row, actorId = null) {
  const allowedActions = [];
  if (row.status === 'AWAITING_APPROVAL' && !sameActor(row.requested_by, actorId)) allowedActions.push('approve', 'reject');
  if (row.status === 'APPROVED') allowedActions.push('dry_run');
  if (row.status === 'DRY_RUN_PASSED' && row.approval_status === 'APPROVED' && row.integrity_status === 'PASSED') allowedActions.push('execute');
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
    allowed_actions: allowedActions,
    can_approve: allowedActions.includes('approve'),
    can_dry_run: allowedActions.includes('dry_run'),
    can_execute: allowedActions.includes('execute'),
  };
}

function rollbackResponse(row, actorId = null) {
  const artifactAvailable = Boolean(revealText(row.artifact_location_encrypted) && row.artifact_checksum);
  const artifactVerified = Boolean(artifactAvailable && row.verification_status === 'MATCH' && row.integrity_status === 'PASSED');
  const allowedActions = [];
  if (artifactVerified && row.status === 'AWAITING_APPROVAL' && !sameActor(row.requested_by, actorId)) allowedActions.push('approve', 'reject');
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

async function listBackups(actorId, limit = 100, executor = pool) {
  const [rows] = await executor.execute(
    `SELECT bs.*, creator.username AS created_by_username, verifier.username AS verified_by_username
       FROM backup_sets bs
       LEFT JOIN users creator ON creator.id = bs.created_by
       LEFT JOIN users verifier ON verifier.id = bs.verified_by
      ORDER BY bs.created_at DESC, bs.id DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 200)}`
  );
  return rows.map(row => backupResponse(row, actorId));
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

async function listRestoreJobs(actorId, limit = 100, executor = pool) {
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
  return rows.map(row => restoreResponse(row, actorId));
}

async function listRollbackRequests(actorId, limit = 100, executor = pool) {
  const [rows] = await executor.execute(
    `SELECT mrr.*, requester.username AS requested_by_username,
            approver.username AS approved_by_username
       FROM module_rollback_requests mrr
       LEFT JOIN users requester ON requester.id = mrr.requested_by
       LEFT JOIN users approver ON approver.id = mrr.approved_by
      ORDER BY mrr.created_at DESC, mrr.id DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 200)}`
  );
  return rows.map(row => rollbackResponse(row, actorId));
}

async function buildCoverage(actorId) {
  const [backups, recoveryPoints, healthRows] = await Promise.all([
    listBackups(actorId, 200),
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
        : 'Create and independently verify a backup artifact.',
    };
  });
}

async function buildOverview(actorId) {
  const [backups, restoreJobs, rollbackRequests, recoveryPoints, coverage] = await Promise.all([
    listBackups(actorId, 200),
    listRestoreJobs(actorId, 50),
    listRollbackRequests(actorId, 50),
    listRecoveryPoints(50),
    buildCoverage(actorId),
  ]);
  const verified = backups.filter(item => item.artifact_verified);
  const latest = type => verified.find(item => item.backup_type === type) || null;
  const failed = backups.filter(item => item.status === 'FAILED' || ['MISMATCH', 'ERROR'].includes(item.verification_status)).length;
  const active = backups.filter(item => ['PENDING', 'RUNNING', 'COMPLETED'].includes(item.status)).length;
  return {
    generated_at: new Date().toISOString(),
    status: failed ? 'Failed' : verified.length ? (active ? 'Warning' : 'Healthy') : 'Warning',
    cards: {
      latest_database_backup: latest('DATABASE'),
      latest_file_backup: latest('FILES'),
      latest_configuration_backup: latest('CONFIGURATION'),
      latest_module_recovery_point: recoveryPoints.find(item => item.artifact_verified) || null,
      latest_deployment_version: latest('DEPLOYMENT_VERSION'),
      backup_status: failed ? 'Failed' : verified.length ? 'Healthy' : 'Warning',
      total_backup_sets: backups.length,
      verified_backup_sets: verified.length,
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
      deployment_provider: process.env.DEPLOYMENT_ARTIFACT_URI ? 'Deployment artifact adapter' : 'Local module artifact adapter',
      aws_region_configured: Boolean(process.env.AWS_REGION),
      s3_bucket_configured: Boolean(process.env.AWS_S3_BUCKET),
      rds_snapshot_configured: Boolean(process.env.AWS_RDS_DB_INSTANCE_IDENTIFIER),
      live_restore_enabled: String(process.env.BACKUP_LIVE_RESTORE_ENABLED || '').toLowerCase() === 'true',
      backup_worker_enabled: true,
      local_adapter_configured: true,
      isolated_restore_configured: Boolean(process.env.BACKUP_RESTORE_DB_NAME || process.env.DB_NAME),
      maker_checker_required: true,
      step_up_mfa_required: true,
    },
  };
}

router.use(requireAuth);
router.use(requireRole(ROLES.admin_any));
router.use(requirePermission('admin_panel:access'));

router.get('/', async (req, res) => {
  try { return res.json(await listBackups(req.user.id)); }
  catch (error) { return errorResponse(res, error, 'Failed to load backup history.'); }
});

router.get('/overview', async (req, res) => {
  try { return res.json(await buildOverview(req.user.id)); }
  catch (error) { return errorResponse(res, error, 'Failed to load backup dashboard.'); }
});

router.get('/recovery-points', async (req, res) => {
  try { return res.json(await listRecoveryPoints(100)); }
  catch (error) { return errorResponse(res, error, 'Failed to load module recovery points.'); }
});

router.get('/restore-jobs', async (req, res) => {
  try { return res.json(await listRestoreJobs(req.user.id, 100)); }
  catch (error) { return errorResponse(res, error, 'Failed to load restore jobs.'); }
});

router.get('/rollback-requests', async (req, res) => {
  try { return res.json(await listRollbackRequests(req.user.id, 100)); }
  catch (error) { return errorResponse(res, error, 'Failed to load rollback requests.'); }
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
    const backupName = cleanText(req.body?.backup_name, 160) || `${backupType.replace(/_/g, ' ')} ${reference}`;
    const notes = cleanText(req.body?.notes, 2000);
    await connection.beginTransaction();
    const [existing] = await connection.execute('SELECT * FROM backup_sets WHERE idempotency_key = ? FOR UPDATE', [key]);
    if (existing.length) {
      await connection.commit();
      return res.status(200).json({
        message: 'Existing backup request returned for this idempotency key.',
        backup: backupResponse(existing[0], req.user.id),
        backup_set_id: existing[0].id,
        backup_reference: existing[0].backup_reference,
        idempotent_replay: true,
      });
    }
    const [result] = await connection.execute(
      `INSERT INTO backup_sets
         (idempotency_key, backup_reference, backup_name, backup_type, storage_provider,
          status, approval_status, included_modules, checksum_algorithm, verification_status,
          integrity_status, created_by, updated_by, remarks_encrypted)
       VALUES (?, ?, ?, ?, ?, 'PENDING', 'NOT_REQUIRED', ?, 'SHA-256',
               'NOT_VERIFIED', 'NOT_CHECKED', ?, ?, ?)`,
      [key, reference, backupName, backupType, storageProvider, JSON.stringify(includedModules), req.user.id, req.user.id, protectedText(notes)]
    );
    await audit(connection, req, `CREATE_BACKUP: ${reference}`, {
      backup_set_id: result.insertId,
      backup_type: backupType,
      storage_provider: storageProvider,
      included_modules: includedModules,
      status: 'PENDING',
    });
    await connection.commit();
    return res.status(201).json({
      message: 'Backup request queued.',
      backup_set_id: result.insertId,
      backup_id: result.insertId,
      backup_reference: reference,
      status: 'PENDING',
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to create backup request.');
  } finally {
    connection.release();
  }
});

async function executeBackupSet(req, backupId) {
  const leaseToken = crypto.randomBytes(32).toString('base64url');
  const leaseHash = crypto.createHash('sha256').update(leaseToken).digest('hex');
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
              worker_lease_token_hash = ?, worker_lease_expires_at = DATE_ADD(NOW(), INTERVAL 30 MINUTE),
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
      await audit(completed, req, `COMPLETE_BACKUP: ${backup.backup_reference}`, {
        backup_set_id: backupId,
        status: 'COMPLETED',
        checksum_recorded: true,
        independent_verification_required: true,
      });
      await completed.commit();
      return { ...result, status: 'COMPLETED', independent_verification_required: true };
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
    return res.json({ message: 'Backup artifact created. Independent verification is required.', backup_set_id: backupId, result });
  } catch (error) {
    return errorResponse(res, error, 'Failed to execute backup.');
  }
});

router.post('/:backupId/verify', async (req, res) => {
  const backupId = positiveId(req.params.backupId, 'backup_set_id');
  const connection = await pool.getConnection();
  let backup;
  let stepUp;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM backup_sets WHERE id = ? FOR UPDATE', [backupId]);
    backup = rows[0];
    if (!backup) throw new RecoveryError('Backup set not found.', 404, 'BACKUP_NOT_FOUND');
    assertMakerChecker(backup.created_by, req.user.id);
    if (backup.status !== 'COMPLETED') throw new RecoveryError('Only completed backups can be independently verified.', 409, 'BACKUP_NOT_READY');
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
            && ['MODULE_STATE', 'DEPLOYMENT_VERSION', 'FULL_BACKUP'].includes(backup.backup_type)
            && stableVersion !== currentVersion
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
      });
      await finalize.commit();
    } catch (error) {
      await finalize.rollback().catch(() => {});
      throw error;
    } finally {
      finalize.release();
    }
    if (!valid) return res.status(409).json({ error: 'Backup checksum verification failed.', code: 'BACKUP_CHECKSUM_MISMATCH' });
    return res.json({ message: 'Backup artifact independently verified.', backup_set_id: backupId, verification });
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
  const connection = await pool.getConnection();
  try {
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

    await connection.beginTransaction();
    const [existing] = await connection.execute('SELECT id FROM restore_jobs WHERE idempotency_key = ? FOR UPDATE', [key]);
    if (existing.length) {
      const jobs = await listRestoreJobs(req.user.id, 200, connection);
      const job = jobs.find(item => Number(item.id) === Number(existing[0].id));
      await connection.commit();
      return res.json({ message: 'Existing restore request returned for this idempotency key.', restore_job_id: existing[0].id, restore_job: job, idempotent_replay: true });
    }
    const [backupRows] = await connection.execute('SELECT * FROM backup_sets WHERE id = ? FOR UPDATE', [backupId]);
    const backup = backupRows[0];
    if (!backup) throw new RecoveryError('Backup set not found.', 404, 'BACKUP_NOT_FOUND');
    if (!backupArtifactVerified(backup) || !['VERIFIED', 'RESTORED'].includes(backup.status)) {
      throw new RecoveryError('Only independently verified backup artifacts can be restored.', 409, 'BACKUP_NOT_VERIFIED');
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
         (idempotency_key, backup_set_id, restore_type, affected_module, status,
          approval_status, requested_by, reason_encrypted, result_message_encrypted,
          dry_run_status, integrity_status, expected_checksum, updated_by)
       VALUES (?, ?, ?, ?, 'AWAITING_APPROVAL', 'PENDING', ?, ?, ?,
               'NOT_STARTED', 'NOT_CHECKED', ?, ?)`,
      [
        key,
        backupId,
        restoreType,
        affectedModule,
        req.user.id,
        protectedText(reason),
        protectedText('Awaiting independent Level 4 approval and step-up MFA.'),
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
    });
    await connection.commit();
    return res.status(201).json({ message: 'Restore request is awaiting independent approval.', restore_job_id: result.insertId, status: 'AWAITING_APPROVAL' });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to request restore.');
  } finally {
    connection.release();
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
    assertMakerChecker(job.requested_by, req.user.id);
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
        protectedText(req.body?.approval_notes || 'Restore approved after independent review.'),
        proof.challengeId,
        proof.verifiedAt,
        protectedText('Approved. A successful isolated dry-run is required before execution.'),
        req.user.id,
        jobId,
      ]
    );
    await audit(connection, req, `APPROVE_RESTORE_JOB: ${jobId}`, { restore_job_id: jobId, status: 'APPROVED' });
    await connection.commit();
    return res.json({ message: 'Restore approved. Run the isolated dry-run next.', restore_job_id: jobId, status: 'APPROVED' });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to approve restore.');
  } finally { connection.release(); }
});

router.post('/restore-jobs/:jobId/dry-run', async (req, res) => {
  const jobId = positiveId(req.params.jobId, 'restore_job_id');
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
    if (job.approval_status !== 'APPROVED') throw new RecoveryError('Restore requires independent approval.', 409, 'RESTORE_NOT_APPROVED');
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
              step_up_challenge_id = ?, step_up_verified_at = ?, updated_by = ?
        WHERE id = ?`,
      [proof.challengeId, proof.verifiedAt, req.user.id, jobId]
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
              result_message_encrypted = ?, updated_by = ?
        WHERE id = ? AND status = 'DRY_RUN_IN_PROGRESS'`,
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
      ]
    );
    if (!passed) return res.status(409).json({ error: 'Restore dry-run failed integrity checks.', code: 'RESTORE_DRY_RUN_FAILED', report });
    return res.json({ message: 'Isolated restore dry-run passed.', restore_job_id: jobId, status: 'DRY_RUN_PASSED', report });
  } catch (error) {
    await pool.execute(
      `UPDATE restore_jobs SET status = 'FAILED', dry_run_status = 'FAILED', integrity_status = 'ERROR',
              failed_at = NOW(), failure_message_encrypted = ?, updated_by = ? WHERE id = ?`,
      [protectedText(error.message || 'Restore dry-run failed.'), req.user.id, jobId]
    ).catch(() => {});
    return errorResponse(res, error, 'Restore dry-run failed.');
  }
});

router.post('/restore-jobs/:jobId/execute', async (req, res) => {
  const jobId = positiveId(req.params.jobId, 'restore_job_id');
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
              restore_target_encrypted = ?, step_up_challenge_id = ?, step_up_verified_at = ?, updated_by = ?
        WHERE id = ?`,
      [protectedText(process.env.BACKUP_RESTORE_DB_NAME || 'configured-recovery-target'), proof.challengeId, proof.verifiedAt, req.user.id, jobId]
    );
    if (record.affected_module) {
      const module = MODULE_MAP.get(record.affected_module);
      await connection.execute(
        `INSERT INTO system_health_checks
           (module_key, module_name, status, remarks, endpoint_checked, checked_by, last_checked_at)
         VALUES (?, ?, 'MAINTENANCE', ?, '/api/admin/backups', ?, NOW())
         ON DUPLICATE KEY UPDATE status='MAINTENANCE', remarks=VALUES(remarks), checked_by=VALUES(checked_by), last_checked_at=NOW()`,
        [record.affected_module, module?.name || record.affected_module, `Controlled restore job ${jobId} is executing.`, req.user.id]
      );
    }
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
                result_message_encrypted=?, updated_by=? WHERE id=? AND status='IN_PROGRESS'`,
        [protectedText('Restore target was created and is awaiting post-restore integrity verification.'), req.user.id, jobId]
      );
      return res.status(202).json({
        message: 'Restore target created. Post-restore integrity verification is pending.',
        restore_job_id: jobId,
        status: 'VERIFYING',
        result,
      });
    }
    const restoredChecksum = result.restoredChecksum || result.checksum || record.checksum;
    const integrityPassed = result.integrityPassed === true || Boolean(
      result.restored
      && result.artifactVerification?.valid
      && (result.databaseRestore?.restored !== false)
    );
    const finalize = await pool.getConnection();
    try {
      await finalize.beginTransaction();
      await finalize.execute(
        `UPDATE restore_jobs SET status='VERIFYING', integrity_status='CHECKING', updated_by=? WHERE id=? AND status='IN_PROGRESS'`,
        [req.user.id, jobId]
      );
      await finalize.execute(
        `UPDATE restore_jobs
            SET status = ?, integrity_status = ?, integrity_checked_at = NOW(), integrity_report_encrypted = ?,
                restored_checksum = ?, result_message_encrypted = ?, completed_at = NOW(), updated_by = ?
          WHERE id = ? AND status = 'VERIFYING'`,
        [
          integrityPassed ? 'COMPLETED' : 'FAILED',
          integrityPassed ? 'PASSED' : 'FAILED',
          protectedText(JSON.stringify(result.integrityReport || result.databaseIntegrity || result)),
          restoredChecksum,
          protectedText(integrityPassed ? 'Restore completed and post-restore integrity checks passed.' : 'Restore completed but integrity validation failed.'),
          req.user.id,
          jobId,
        ]
      );
      if (integrityPassed) {
        await finalize.execute('UPDATE backup_sets SET status = \'RESTORED\', restored_at = NOW(), updated_by = ? WHERE id = ?', [req.user.id, record.backup_set_id]);
      }
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
              failure_message_encrypted=?, updated_by=? WHERE id=?`,
      [protectedText(error.message || 'Restore execution failed.'), req.user.id, jobId]
    ).catch(() => {});
    return errorResponse(res, error, 'Restore execution failed.');
  }
});

router.post('/rollback-requests', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const key = idempotencyKey(req);
    const affectedModule = cleanText(req.body?.affected_module, 80);
    const module = MODULE_MAP.get(affectedModule);
    if (!module || !module.rollback) throw new RecoveryError('Affected module does not support rollback.', 400, 'ROLLBACK_MODULE_INVALID');
    const reason = cleanText(req.body?.reason, 2000);
    if (reason.length < 5) throw new RecoveryError('A rollback reason is required.', 400, 'ROLLBACK_REASON_REQUIRED');
    await connection.beginTransaction();
    const [existing] = await connection.execute('SELECT id FROM module_rollback_requests WHERE idempotency_key = ? FOR UPDATE', [key]);
    if (existing.length) {
      await connection.commit();
      return res.json({ message: 'Existing rollback request returned for this idempotency key.', rollback_request_id: existing[0].id, idempotent_replay: true });
    }
    const [points] = await connection.execute(
      `SELECT mrp.*, bs.backup_reference, bs.backup_type
         FROM module_recovery_points mrp JOIN backup_sets bs ON bs.id=mrp.backup_set_id
        WHERE mrp.module_key=? AND mrp.status='AVAILABLE' AND mrp.rollback_available=1
          AND mrp.verification_status='MATCH' AND mrp.integrity_status='PASSED'
          AND mrp.verified_at IS NOT NULL AND bs.status IN ('VERIFIED','RESTORED')
        ORDER BY mrp.verified_at DESC, mrp.id DESC LIMIT 1 FOR UPDATE`,
      [affectedModule]
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
         (idempotency_key, recovery_point_id, affected_module, current_version, target_version,
          artifact_location_encrypted, artifact_checksum, checksum_algorithm, reason_encrypted,
          status, approval_status, requested_by, verification_status, integrity_status, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'SHA-256', ?, 'AWAITING_APPROVAL', 'PENDING', ?, 'MATCH', 'PASSED', ?)`,
      [
        key,
        point.id,
        affectedModule,
        point.current_version,
        point.stable_version,
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
    });
    await connection.commit();
    return res.status(201).json({ message: 'Rollback request is awaiting independent approval.', rollback_request_id: result.insertId, status: 'AWAITING_APPROVAL' });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to request rollback.');
  } finally { connection.release(); }
});

router.post('/rollback-requests/:requestId/approve', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const requestId = positiveId(req.params.requestId, 'rollback_request_id');
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM module_rollback_requests WHERE id=? FOR UPDATE', [requestId]);
    const request = rows[0];
    if (!request) throw new RecoveryError('Rollback request not found.', 404, 'ROLLBACK_NOT_FOUND');
    assertMakerChecker(request.requested_by, req.user.id);
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
        protectedText(req.body?.approval_notes || 'Rollback approved after recovery-point review.'),
        proof.challengeId,
        proof.verifiedAt,
        req.user.id,
        requestId,
      ]
    );
    await audit(connection, req, `APPROVE_MODULE_ROLLBACK: ${request.affected_module}`, { rollback_request_id: requestId, status: 'APPROVED' });
    await connection.commit();
    return res.json({ message: 'Rollback approved.', rollback_request_id: requestId, status: 'APPROVED' });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return errorResponse(res, error, 'Failed to approve rollback.');
  } finally { connection.release(); }
});

router.post('/rollback-requests/:requestId/execute', async (req, res) => {
  const requestId = positiveId(req.params.requestId, 'rollback_request_id');
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
              step_up_challenge_id=?, step_up_verified_at=?, updated_by=? WHERE id=?`,
      [proof.challengeId, proof.verifiedAt, req.user.id, requestId]
    );
    await connection.execute(
      `INSERT INTO system_health_checks
         (module_key,module_name,status,remarks,endpoint_checked,checked_by,last_checked_at)
       VALUES (?,?,'MAINTENANCE',?,'/api/admin/backups',?,NOW())
       ON DUPLICATE KEY UPDATE status='MAINTENANCE',remarks=VALUES(remarks),checked_by=VALUES(checked_by),last_checked_at=NOW()`,
      [record.affected_module, MODULE_MAP.get(record.affected_module)?.name || record.affected_module, `Controlled rollback request ${requestId} is executing.`, req.user.id]
    );
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
    const passed = result.integrityPassed !== false && Boolean(result.integrityReport || result.verified);
    const finalize = await pool.getConnection();
    try {
      await finalize.beginTransaction();
      await finalize.execute("UPDATE module_rollback_requests SET status='VERIFYING', integrity_status='CHECKING', updated_by=? WHERE id=? AND status='IN_PROGRESS'", [req.user.id, requestId]);
      await finalize.execute(
        `UPDATE module_rollback_requests SET status=?, integrity_status=?, integrity_checked_at=NOW(),
                integrity_report_encrypted=?, result_message_encrypted=?, completed_at=NOW(), updated_by=?
          WHERE id=? AND status='VERIFYING'`,
        [
          passed ? 'COMPLETED' : 'FAILED',
          passed ? 'PASSED' : 'FAILED',
          protectedText(JSON.stringify(result.integrityReport || result)),
          protectedText(passed ? 'Rollback completed and integrity checks passed.' : 'Rollback integrity verification failed.'),
          req.user.id,
          requestId,
        ]
      );
      await audit(finalize, req, `${passed ? 'COMPLETE_MODULE_ROLLBACK' : 'FAIL_MODULE_ROLLBACK'}: ${record.affected_module}`, {
        rollback_request_id: requestId,
        integrity_status: passed ? 'PASSED' : 'FAILED',
      });
      await finalize.commit();
    } catch (error) {
      await finalize.rollback().catch(() => {});
      throw error;
    } finally { finalize.release(); }
    if (!passed) return res.status(409).json({ error: 'Rollback integrity verification failed.', code: 'ROLLBACK_INTEGRITY_FAILED' });
    return res.json({ message: 'Rollback completed and integrity verified.', rollback_request_id: requestId, status: 'COMPLETED', result });
  } catch (error) {
    await pool.execute(
      `UPDATE module_rollback_requests SET status='FAILED', integrity_status='ERROR', failed_at=NOW(),
              failure_message_encrypted=?, updated_by=? WHERE id=?`,
      [protectedText(error.message || 'Rollback execution failed.'), req.user.id, requestId]
    ).catch(() => {});
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
    if (status === 'REJECTED') {
      assertMakerChecker(job.requested_by, req.user.id);
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
    await audit(connection, req, `${status}_RESTORE_JOB: ${jobId}`, { restore_job_id: jobId, status });
    await connection.commit();
    return res.json({ message: `Restore job ${status.toLowerCase()}.`, restore_job_id: jobId, status });
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
    if (status === 'REJECTED') {
      assertMakerChecker(request.requested_by, req.user.id);
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
    await audit(connection, req, `${status}_MODULE_ROLLBACK: ${request.affected_module}`, { rollback_request_id: requestId, status });
    await connection.commit();
    return res.json({ message: `Rollback request ${status.toLowerCase()}.`, rollback_request_id: requestId, status });
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
      throw new RecoveryError('Use the run and independently verified backup endpoints for lifecycle changes.', 409, 'CONTROLLED_BACKUP_ACTION_REQUIRED');
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

module.exports = router;
module.exports._test = {
  BACKUP_TRANSITIONS,
  RESTORE_TRANSITIONS,
  ROLLBACK_TRANSITIONS,
  backupArtifactAvailable,
  backupArtifactVerified,
  backupResponse,
  assertMakerChecker,
  assertTransition,
};
