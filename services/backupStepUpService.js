const crypto = require('crypto');
const pool = require('../config/db');
const { verifyEmployeeTotpStepUp, MfaServiceError } = require('./mfaService');

const STEP_UP_PURPOSES = new Set([
  'BACKUP_VERIFY',
  'RESTORE_APPROVE',
  'RESTORE_DRY_RUN',
  'RESTORE_EXECUTE',
  'ROLLBACK_APPROVE',
  'ROLLBACK_EXECUTE',
]);
const STEP_UP_RESOURCE_TYPES = new Set(['BACKUP_SET', 'RESTORE_JOB', 'ROLLBACK_REQUEST']);
const PURPOSE_RESOURCE_TYPE = Object.freeze({
  BACKUP_VERIFY: 'BACKUP_SET',
  RESTORE_APPROVE: 'RESTORE_JOB',
  RESTORE_DRY_RUN: 'RESTORE_JOB',
  RESTORE_EXECUTE: 'RESTORE_JOB',
  ROLLBACK_APPROVE: 'ROLLBACK_REQUEST',
  ROLLBACK_EXECUTE: 'ROLLBACK_REQUEST',
});
const MAX_STEP_UP_ATTEMPTS = 5;

class BackupStepUpError extends Error {
  constructor(message, statusCode = 400, code = 'BACKUP_STEP_UP_FAILED') {
    super(message);
    this.name = 'BackupStepUpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function positiveId(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new BackupStepUpError(`${fieldName} is invalid.`, 400, 'BACKUP_STEP_UP_INVALID_RESOURCE');
  }
  return parsed;
}

function normalizePurpose(value) {
  const purpose = String(value || '').trim().toUpperCase();
  if (!STEP_UP_PURPOSES.has(purpose)) {
    throw new BackupStepUpError('Step-up purpose is invalid.', 400, 'BACKUP_STEP_UP_INVALID_PURPOSE');
  }
  return purpose;
}

function normalizeResourceType(value) {
  const resourceType = String(value || '').trim().toUpperCase();
  if (!STEP_UP_RESOURCE_TYPES.has(resourceType)) {
    throw new BackupStepUpError('Step-up resource type is invalid.', 400, 'BACKUP_STEP_UP_INVALID_RESOURCE');
  }
  return resourceType;
}

function challengeTtlSeconds() {
  const parsed = Number.parseInt(process.env.BACKUP_STEP_UP_TTL_SECONDS || '300', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 120), 600) : 300;
}

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function requestFingerprint(req, type) {
  const value = type === 'ip'
    ? req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || ''
    : req.headers?.['user-agent'] || '';
  return value ? hashToken(value) : null;
}

function tokenMatches(rawToken, expectedHash) {
  if (!rawToken || !/^[a-f0-9]{64}$/i.test(String(expectedHash || ''))) return false;
  const actual = Buffer.from(hashToken(rawToken), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function actorEmployeeId(req) {
  return req.user?.Employee_ID || req.user?.employeeId || null;
}

async function createBackupStepUpChallenge(req, { purpose, resourceType, resourceId }) {
  const normalizedPurpose = normalizePurpose(purpose);
  const normalizedResourceType = normalizeResourceType(resourceType);
  if (PURPOSE_RESOURCE_TYPE[normalizedPurpose] !== normalizedResourceType) {
    throw new BackupStepUpError('Step-up purpose does not match the resource type.', 400, 'BACKUP_STEP_UP_INVALID_RESOURCE');
  }
  const normalizedResourceId = positiveId(resourceId, 'resource_id');
  const userId = positiveId(req.user?.id, 'user_id');
  const employeeId = positiveId(actorEmployeeId(req), 'employee_id');
  const ttlSeconds = challengeTtlSeconds();
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const nonce = crypto.randomBytes(8).toString('hex');
  const challengeReference = `BSTEP-${Date.now()}-${nonce.slice(0, 8)}`;
  const idempotencyKey = `challenge:${userId}:${normalizedPurpose}:${normalizedResourceType}:${normalizedResourceId}:${nonce}`;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE backup_step_up_challenges
          SET status = 'EXPIRED'
        WHERE user_id = ? AND purpose = ? AND resource_type = ? AND resource_id = ?
          AND status IN ('PENDING', 'VERIFIED')`,
      [userId, normalizedPurpose, normalizedResourceType, normalizedResourceId]
    );
    const [result] = await connection.execute(
      `INSERT INTO backup_step_up_challenges
         (challenge_reference, idempotency_key, user_id, employee_id, purpose,
          resource_type, resource_id, challenge_token_hash, mfa_method, status,
          attempt_count, max_attempts, expires_at, request_ip_hash, user_agent_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'TOTP', 'PENDING', 0, ?,
               DATE_ADD(NOW(), INTERVAL ? SECOND), ?, ?)`,
      [
        challengeReference,
        idempotencyKey,
        userId,
        employeeId,
        normalizedPurpose,
        normalizedResourceType,
        normalizedResourceId,
        hashToken(rawToken),
        MAX_STEP_UP_ATTEMPTS,
        ttlSeconds,
        requestFingerprint(req, 'ip'),
        requestFingerprint(req, 'user-agent'),
      ]
    );
    await connection.commit();
    return {
      challenge_id: result.insertId,
      challenge_token: rawToken,
      purpose: normalizedPurpose,
      resource_type: normalizedResourceType,
      resource_id: normalizedResourceId,
      expires_in: ttlSeconds,
    };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function verifyBackupStepUpChallenge(req, { challengeId, challengeToken, code }) {
  const normalizedChallengeId = positiveId(challengeId, 'challenge_id');
  const userId = positiveId(req.user?.id, 'user_id');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT id, user_id, employee_id, purpose, resource_type, resource_id,
              challenge_token_hash, status, attempt_count, expires_at
         FROM backup_step_up_challenges
        WHERE id = ? FOR UPDATE`,
      [normalizedChallengeId]
    );
    const challenge = rows[0];
    if (!challenge || Number(challenge.user_id) !== userId || !tokenMatches(challengeToken, challenge.challenge_token_hash)) {
      throw new BackupStepUpError('Invalid step-up challenge.', 401, 'BACKUP_STEP_UP_INVALID');
    }
    if (challenge.status !== 'PENDING') {
      throw new BackupStepUpError('Step-up challenge is no longer available.', 409, 'BACKUP_STEP_UP_UNAVAILABLE');
    }
    if (new Date(challenge.expires_at) <= new Date()) {
      await connection.execute("UPDATE backup_step_up_challenges SET status = 'EXPIRED' WHERE id = ?", [challenge.id]);
      await connection.commit();
      throw new BackupStepUpError('Step-up challenge expired.', 410, 'BACKUP_STEP_UP_EXPIRED');
    }

    try {
      const proof = await verifyEmployeeTotpStepUp({
        employeeId: challenge.employee_id,
        code,
        req,
        purpose: challenge.purpose,
        executor: connection,
      });
      await connection.execute(
        "UPDATE backup_step_up_challenges SET status = 'VERIFIED', verified_at = NOW(), last_attempt_at = NOW(), verified_ip_hash = ? WHERE id = ?",
        [requestFingerprint(req, 'ip'), challenge.id]
      );
      await connection.commit();
      return {
        step_up_challenge_id: challenge.id,
        step_up_token: challengeToken,
        purpose: challenge.purpose,
        resource_type: challenge.resource_type,
        resource_id: challenge.resource_id,
        verified_at: proof.verifiedAt,
        expires_at: challenge.expires_at,
      };
    } catch (error) {
      if (!(error instanceof MfaServiceError)) throw error;
      const attempts = Number(challenge.attempt_count || 0) + 1;
      await connection.execute(
        `UPDATE backup_step_up_challenges
            SET attempt_count = ?, status = ?, last_attempt_at = NOW(),
                failed_at = CASE WHEN ? = 'FAILED' THEN NOW() ELSE failed_at END
          WHERE id = ?`,
        [attempts, attempts >= MAX_STEP_UP_ATTEMPTS ? 'FAILED' : 'PENDING', attempts >= MAX_STEP_UP_ATTEMPTS ? 'FAILED' : 'PENDING', challenge.id]
      );
      await connection.commit();
      throw error;
    }
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function consumeBackupStepUpChallenge(executor, req, {
  challengeId,
  challengeToken,
  purpose,
  resourceType,
  resourceId,
}) {
  const normalizedChallengeId = positiveId(challengeId, 'step_up_challenge_id');
  const expectedPurpose = normalizePurpose(purpose);
  const expectedResourceType = normalizeResourceType(resourceType);
  const expectedResourceId = positiveId(resourceId, 'resource_id');
  const userId = positiveId(req.user?.id, 'user_id');
  const [rows] = await executor.execute(
    `SELECT id, user_id, purpose, resource_type, resource_id, challenge_token_hash,
            status, verified_at, expires_at
       FROM backup_step_up_challenges
      WHERE id = ? FOR UPDATE`,
    [normalizedChallengeId]
  );
  const challenge = rows[0];
  const valid = challenge
    && Number(challenge.user_id) === userId
    && challenge.purpose === expectedPurpose
    && challenge.resource_type === expectedResourceType
    && Number(challenge.resource_id) === expectedResourceId
    && challenge.status === 'VERIFIED'
    && challenge.verified_at
    && new Date(challenge.expires_at) > new Date()
    && tokenMatches(challengeToken, challenge.challenge_token_hash);
  if (!valid) {
    throw new BackupStepUpError('Fresh step-up MFA verification is required.', 403, 'BACKUP_STEP_UP_REQUIRED');
  }
  const [result] = await executor.execute(
    "UPDATE backup_step_up_challenges SET status = 'CONSUMED', consumed_at = NOW() WHERE id = ? AND status = 'VERIFIED'",
    [challenge.id]
  );
  if (result.affectedRows !== 1) {
    throw new BackupStepUpError('Step-up MFA proof was already consumed.', 409, 'BACKUP_STEP_UP_CONSUMED');
  }
  return { challengeId: challenge.id, verifiedAt: challenge.verified_at };
}

module.exports = {
  BackupStepUpError,
  STEP_UP_PURPOSES,
  STEP_UP_RESOURCE_TYPES,
  createBackupStepUpChallenge,
  verifyBackupStepUpChallenge,
  consumeBackupStepUpChallenge,
  _hashTokenForTest: hashToken,
  _tokenMatchesForTest: tokenMatches,
};
