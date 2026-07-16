'use strict';

const crypto = require('crypto');
const { backupError } = require('./backupErrors');
const { BackupWorker } = require('./backupWorker');
const { createBackupRuntimeFromEnv } = require('./backupRuntime');

const FREQUENCIES = new Set(['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY']);
const ADMIN_ACTION_CATEGORIES = Object.freeze([
  'BACKUP_VERIFICATION_REQUIRED',
  'RESTORE_APPROVAL_REQUIRED',
  'ROLLBACK_APPROVAL_REQUIRED',
]);

function asDate(value, fieldName = 'date') {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw backupError(`${fieldName} is invalid.`, 'INVALID_AUTOMATION_SCHEDULE');
  return date;
}

function positiveId(value, fieldName = 'id') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw backupError(`${fieldName} is invalid.`, 'INVALID_AUTOMATION_REQUEST');
  return id;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function parseRunTime(value) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || ''));
  if (!match) throw backupError('run_time must use HH:MM or HH:MM:SS.', 'INVALID_AUTOMATION_SCHEDULE');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) {
    throw backupError('run_time is outside the valid clock range.', 'INVALID_AUTOMATION_SCHEDULE');
  }
  return { hour, minute, second };
}

function assertTimeZone(value) {
  const timeZone = String(value || 'Asia/Manila').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
  } catch (_) {
    throw backupError('timezone is not a valid IANA timezone.', 'INVALID_AUTOMATION_SCHEDULE');
  }
  return timeZone;
}

function zonedParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const result = {};
  for (const part of parts) {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
  }
  return result;
}

function localSerial(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
}

function instantForLocal(parts, timeZone) {
  const wanted = localSerial(parts);
  let guess = wanted;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const observed = localSerial(zonedParts(new Date(guess), timeZone));
    const next = guess + (wanted - observed);
    if (next === guess) break;
    guess = next;
  }
  const candidate = new Date(guess);
  const observed = zonedParts(candidate, timeZone);
  if (localSerial(observed) === wanted) return candidate;

  // A configured wall-clock time can be skipped by daylight-saving changes.
  // Select the first representable local minute after it, never an earlier run.
  const searchStart = guess - (4 * 60 * 60 * 1000);
  let best = null;
  for (let offset = 0; offset <= 8 * 60; offset += 1) {
    const probe = new Date(searchStart + (offset * 60 * 1000));
    const probeParts = zonedParts(probe, timeZone);
    const serial = localSerial(probeParts);
    if (serial >= wanted && (!best || serial < best.serial)) best = { date: probe, serial };
  }
  return best?.date || candidate;
}

function shiftLocalDate(parts, days = 0, months = 0) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1 + months, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Compute the first scheduled instant strictly after `from`.
 * ISO weekdays are used (1=Monday ... 7=Sunday).
 */
function computeNextRunAt(schedule, from = new Date()) {
  const reference = asDate(from, 'from');
  const frequency = String(schedule?.frequency || '').trim().toUpperCase();
  if (!FREQUENCIES.has(frequency)) {
    throw backupError('frequency must be HOURLY, DAILY, WEEKLY, or MONTHLY.', 'INVALID_AUTOMATION_SCHEDULE');
  }
  if (frequency === 'HOURLY') return new Date(reference.getTime() + (60 * 60 * 1000));
  const timeZone = assertTimeZone(schedule?.timezone || 'Asia/Manila');
  const time = parseRunTime(schedule?.run_time || '00:00:00');
  const current = zonedParts(reference, timeZone);
  let localDate = { year: current.year, month: current.month, day: current.day };

  if (frequency === 'WEEKLY') {
    const desiredWeekday = boundedInteger(schedule?.day_of_week, 1, 7, 1);
    const pseudo = new Date(Date.UTC(current.year, current.month - 1, current.day));
    const currentWeekday = pseudo.getUTCDay() || 7;
    localDate = shiftLocalDate(localDate, (desiredWeekday - currentWeekday + 7) % 7);
  } else if (frequency === 'MONTHLY') {
    const desiredDay = boundedInteger(schedule?.day_of_month, 1, 31, 1);
    localDate.day = Math.min(desiredDay, daysInMonth(localDate.year, localDate.month));
  }

  let candidate = instantForLocal({ ...localDate, ...time }, timeZone);
  if (candidate.getTime() <= reference.getTime()) {
    if (frequency === 'DAILY') {
      localDate = shiftLocalDate(localDate, 1);
    } else if (frequency === 'WEEKLY') {
      localDate = shiftLocalDate(localDate, 7);
    } else {
      const nextMonth = shiftLocalDate({ ...localDate, day: 1 }, 0, 1);
      localDate = {
        ...nextMonth,
        day: Math.min(boundedInteger(schedule?.day_of_month, 1, 31, 1), daysInMonth(nextMonth.year, nextMonth.month)),
      };
    }
    candidate = instantForLocal({ ...localDate, ...time }, timeZone);
  }
  return candidate;
}

function presence(environment, names) {
  return names.every(name => String(environment?.[name] || '').trim());
}

function enabledSetting(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function providerReadinessFromEnv(environment = process.env) {
  const hasRegion = Boolean(String(environment.AWS_REGION || environment.AWS_DEFAULT_REGION || '').trim());
  const region = String(environment.AWS_REGION || environment.AWS_DEFAULT_REGION || '').trim();
  const bucket = String(environment.AWS_S3_BUCKET || '').trim();
  const instanceIdentifier = String(environment.AWS_RDS_DB_INSTANCE_IDENTIFIER || '').trim();
  const s3Missing = [];
  if (!hasRegion) s3Missing.push('AWS_REGION or AWS_DEFAULT_REGION');
  else if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) s3Missing.push('AWS_REGION (invalid format)');
  if (!bucket) s3Missing.push('AWS_S3_BUCKET');
  else if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) s3Missing.push('AWS_S3_BUCKET (invalid format)');
  const rdsMissing = [];
  if (!hasRegion) rdsMissing.push('AWS_REGION or AWS_DEFAULT_REGION');
  else if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) rdsMissing.push('AWS_REGION (invalid format)');
  if (!instanceIdentifier) rdsMissing.push('AWS_RDS_DB_INSTANCE_IDENTIFIER');
  else if (!/^[a-z][a-z0-9-]{0,62}$/.test(instanceIdentifier) || instanceIdentifier.endsWith('-') || instanceIdentifier.includes('--')) {
    rdsMissing.push('AWS_RDS_DB_INSTANCE_IDENTIFIER (invalid format)');
  }
  const rdsRestoreMissing = [];
  if (!String(environment.AWS_RDS_RESTORE_INSTANCE_CLASS || '').trim()) rdsRestoreMissing.push('AWS_RDS_RESTORE_INSTANCE_CLASS');
  if (!String(environment.AWS_RDS_RESTORE_SUBNET_GROUP || '').trim()) rdsRestoreMissing.push('AWS_RDS_RESTORE_SUBNET_GROUP');
  if (!String(environment.AWS_RDS_RESTORE_SECURITY_GROUP_IDS || '').trim()) rdsRestoreMissing.push('AWS_RDS_RESTORE_SECURITY_GROUP_IDS');
  if (String(environment.AWS_RDS_RESTORE_WAIT_FOR_AVAILABLE || '').trim().toLowerCase() !== 'true') {
    rdsRestoreMissing.push('AWS_RDS_RESTORE_WAIT_FOR_AVAILABLE=true');
  }
  const rdsVerifyNames = ['BACKUP_RDS_VERIFY_DB_USER', 'BACKUP_RDS_VERIFY_DB_PASSWORD', 'BACKUP_RDS_VERIFY_DB_NAME'];
  const rdsVerifyMissing = rdsVerifyNames.filter(name => !String(environment[name] || '').trim());
  if (String(environment.BACKUP_RDS_VERIFY_DB_SSL || '').trim().toLowerCase() !== 'true') {
    rdsVerifyMissing.push('BACKUP_RDS_VERIFY_DB_SSL=true');
  }
  const dryRunNames = ['BACKUP_DRY_RUN_DB_HOST', 'BACKUP_DRY_RUN_DB_USER', 'BACKUP_DRY_RUN_DB_PASSWORD', 'BACKUP_DRY_RUN_DB_NAME'];
  return {
    s3: {
      configured: s3Missing.length === 0,
      ready: s3Missing.length === 0,
      missing: s3Missing,
      encryption: String(environment.AWS_S3_KMS_KEY_ID || '').trim() ? 'AWS_KMS' : 'SSE_S3',
      credentials: 'AWS_SDK_DEFAULT_PROVIDER_CHAIN',
    },
    rdsSnapshot: {
      configured: rdsMissing.length === 0,
      ready: rdsMissing.length === 0,
      missing: rdsMissing,
      encryptedSnapshotsRequired: true,
      retentionDeleteEnabled: String(environment.AWS_RDS_ALLOW_RETENTION_DELETE || '').toLowerCase() === 'true',
    },
    rdsIsolatedRestore: {
      ready: rdsMissing.length === 0 && rdsRestoreMissing.length === 0 && rdsVerifyMissing.length === 0,
      missing: [...rdsMissing, ...rdsRestoreMissing, ...rdsVerifyMissing],
      inPlaceRestoreAllowed: false,
      postRestoreIntegrityRequired: true,
    },
    databaseDryRun: {
      ready: presence(environment, dryRunNames),
      missing: dryRunNames.filter(name => !String(environment[name] || '').trim()),
      isolatedDatabaseRequired: true,
    },
  };
}

function parseModules(value) {
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (_) {
    return [];
  }
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function compactTimestamp(value) {
  return asDate(value).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function atSecondPrecision(value) {
  const date = asDate(value);
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

function safeErrorCode(error) {
  return String(error?.code || 'BACKUP_AUTOMATION_FAILED').replace(/[^A-Z0-9_]/gi, '_').slice(0, 80);
}

class BackupAutomationRepository {
  constructor(options = {}) {
    if (!options.pool || typeof options.pool.execute !== 'function') {
      throw backupError('Automation database pool is required.', 'BACKUP_AUTOMATION_REPOSITORY_REQUIRED');
    }
    this.pool = options.pool;
    this.protectText = options.protectText;
    this.revealText = options.revealText;
    if (typeof this.protectText !== 'function' || typeof this.revealText !== 'function') {
      throw backupError('Backup field protection functions are required.', 'BACKUP_FIELD_PROTECTION_REQUIRED');
    }
  }

  protected(value) {
    return value === null || value === undefined || value === '' ? null : this.protectText(String(value));
  }

  revealed(value) {
    if (!value) return null;
    return this.revealText(value);
  }

  async listDueBackupSchedules(now, limit = 10) {
    const safeLimit = boundedInteger(limit, 1, 100, 10);
    const [rows] = await this.pool.execute(
      `SELECT s.*, p.max_age_days AS retention_max_age_days
         FROM backup_schedules s
         LEFT JOIN backup_retention_policies p ON p.id=s.retention_policy_id AND p.enabled=1
        WHERE s.enabled=1 AND s.next_run_at IS NOT NULL AND s.next_run_at <= ?
        ORDER BY s.next_run_at ASC, s.id ASC
        LIMIT ${safeLimit}`,
      [now]
    );
    return rows;
  }

  async getBackupSchedule(id) {
    const [rows] = await this.pool.execute(
      `SELECT s.*, p.max_age_days AS retention_max_age_days
         FROM backup_schedules s
         LEFT JOIN backup_retention_policies p ON p.id=s.retention_policy_id AND p.enabled=1
        WHERE s.id=? LIMIT 1`,
      [positiveId(id, 'schedule id')]
    );
    return rows[0] || null;
  }

  async claimBackupSchedule({ scheduleId, expectedNextRunAt, nextRunAt, now, schedule, scheduledFor, expiresAt }) {
    const id = positiveId(scheduleId, 'schedule id');
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        `UPDATE backup_schedules
            SET last_run_at=?, last_status='RUNNING', next_run_at=?, updated_at=NOW()
          WHERE id=? AND enabled=1 AND next_run_at=?`,
        [now, nextRunAt, id, expectedNextRunAt]
      );
      if (result.affectedRows !== 1) {
        await connection.rollback();
        return false;
      }

      // Persist the PENDING transaction in the same commit as advancing the
      // schedule. If the process exits immediately afterwards, resumePending
      // can finish this occurrence instead of silently losing it.
      if (schedule && scheduledFor) {
        const occurrence = asDate(scheduledFor);
        const key = `schedule:${schedule.schedule_reference}:${occurrence.toISOString()}`.slice(0, 128);
        const requestFingerprint = fingerprint({
          kind: 'SCHEDULED_BACKUP', scheduleId: id, scheduledFor: occurrence.toISOString(),
          backupType: schedule.backup_type, provider: schedule.storage_provider,
          modules: parseModules(schedule.included_modules).sort(),
        });
        const [existing] = await connection.execute(
          'SELECT id,request_fingerprint FROM backup_sets WHERE idempotency_key=? FOR UPDATE',
          [key]
        );
        if (existing.length && existing[0].request_fingerprint !== requestFingerprint) {
          throw backupError('Scheduled backup idempotency conflict.', 'BACKUP_IDEMPOTENCY_CONFLICT');
        }
        if (!existing.length) {
          const reference = `BKP-SCH-${id}-${compactTimestamp(occurrence)}`;
          await connection.execute(
            `INSERT INTO backup_sets
               (idempotency_key,request_fingerprint,backup_reference,backup_name,backup_type,storage_provider,
                status,approval_status,included_modules,checksum_algorithm,verification_status,integrity_status,
                schedule_id,expires_at,retention_status,created_by,updated_by,remarks_encrypted)
             VALUES (?,?,?,?,?,?,'PENDING','NOT_REQUIRED',?,'SHA-256','NOT_VERIFIED','NOT_CHECKED',
                     ?,?,'ACTIVE',?,?,?)`,
            [key, requestFingerprint, reference, `${schedule.name} - ${compactTimestamp(occurrence)}`.slice(0, 160),
              schedule.backup_type, schedule.storage_provider, JSON.stringify(parseModules(schedule.included_modules)),
              id, expiresAt || null, schedule.created_by, schedule.created_by,
              this.protected('Created automatically by the approved backup schedule.')]
          );
        }
      }
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async markBackupScheduleStarted(scheduleId, now) {
    await this.pool.execute(
      `UPDATE backup_schedules SET last_run_at=?, last_status='RUNNING', updated_at=NOW() WHERE id=?`,
      [now, positiveId(scheduleId, 'schedule id')]
    );
  }

  async finishBackupSchedule(scheduleId, status) {
    await this.pool.execute(
      `UPDATE backup_schedules SET last_status=?, updated_at=NOW() WHERE id=?`,
      [String(status).toUpperCase(), positiveId(scheduleId, 'schedule id')]
    );
  }

  async createScheduledBackup({ schedule, scheduledFor, expiresAt }) {
    const key = `schedule:${schedule.schedule_reference}:${asDate(scheduledFor).toISOString()}`.slice(0, 128);
    const requestFingerprint = fingerprint({
      kind: 'SCHEDULED_BACKUP', scheduleId: Number(schedule.id), scheduledFor: asDate(scheduledFor).toISOString(),
      backupType: schedule.backup_type, provider: schedule.storage_provider, modules: parseModules(schedule.included_modules).sort(),
    });
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [existing] = await connection.execute('SELECT * FROM backup_sets WHERE idempotency_key=? FOR UPDATE', [key]);
      if (existing.length) {
        if (existing[0].request_fingerprint !== requestFingerprint) {
          throw backupError('Scheduled backup idempotency conflict.', 'BACKUP_IDEMPOTENCY_CONFLICT');
        }
        await connection.commit();
        return {
          ...existing[0],
          storage_location: this.revealed(existing[0].storage_location_encrypted),
        };
      }
      const reference = `BKP-SCH-${Number(schedule.id)}-${compactTimestamp(scheduledFor)}`;
      const [insert] = await connection.execute(
        `INSERT INTO backup_sets
           (idempotency_key, request_fingerprint, backup_reference, backup_name, backup_type, storage_provider,
            status, approval_status, included_modules, checksum_algorithm, verification_status, integrity_status,
            schedule_id, expires_at, retention_status, created_by, updated_by, remarks_encrypted)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 'NOT_REQUIRED', ?, 'SHA-256', 'NOT_VERIFIED', 'NOT_CHECKED',
                 ?, ?, 'ACTIVE', ?, ?, ?)`,
        [key, requestFingerprint, reference, `${schedule.name} - ${compactTimestamp(scheduledFor)}`.slice(0, 160),
          schedule.backup_type, schedule.storage_provider, JSON.stringify(parseModules(schedule.included_modules)),
          schedule.id, expiresAt, schedule.created_by, schedule.created_by,
          this.protected('Created automatically by the approved backup schedule.')]
      );
      const [created] = await connection.execute('SELECT * FROM backup_sets WHERE id=?', [insert.insertId]);
      await connection.commit();
      return created[0];
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async transitionBackup({ backupSetId, expectedStatus, status, patch = {} }) {
    const id = positiveId(backupSetId, 'backup set id');
    let sql;
    let params;
    if (status === 'RUNNING') {
      const leaseHash = crypto.randomBytes(32).toString('hex');
      sql = `UPDATE backup_sets
                SET status='RUNNING', started_at=?, attempt_count=attempt_count+1,
                    worker_lease_token_hash=?, worker_lease_expires_at=DATE_ADD(NOW(), INTERVAL 120 MINUTE),
                    updated_by=created_by
              WHERE id=? AND status=?`;
      params = [patch.startedAt || new Date(), leaseHash, id, expectedStatus];
    } else if (status === 'COMPLETED') {
      sql = `UPDATE backup_sets
                SET status='COMPLETED', storage_location_encrypted=?, checksum=?, file_size=?, completed_at=?,
                    verification_status='NOT_VERIFIED', worker_lease_token_hash=NULL, worker_lease_expires_at=NULL,
                    updated_by=created_by
              WHERE id=? AND status=?`;
      params = [this.protected(patch.storageLocation), patch.checksum, patch.fileSize, patch.completedAt || new Date(), id, expectedStatus];
    } else if (status === 'FAILED') {
      sql = `UPDATE backup_sets
                SET status='FAILED', failed_at=?, failure_message_encrypted=?,
                    worker_lease_token_hash=NULL, worker_lease_expires_at=NULL, updated_by=created_by
              WHERE id=? AND status=?`;
      params = [patch.failedAt || new Date(), this.protected(`Automated backup failed (${String(patch.failureCode || 'BACKUP_EXECUTION_FAILED').slice(0, 80)}).`), id, expectedStatus];
    } else {
      throw backupError('Automation attempted an unsupported backup transition.', 'INVALID_BACKUP_STATUS_TRANSITION');
    }
    const [result] = await this.pool.execute(sql, params);
    return result.affectedRows === 1;
  }

  async persistBackupIntegrityMetadata(backupSetId, result) {
    if (!result?.integrityReport) return false;
    const metadata = {
      storageProvider: result.storageProvider || null,
      fileCount: result.fileCount ?? null,
      descriptor: result.descriptor || null,
      integrityReport: result.integrityReport,
    };
    const [update] = await this.pool.execute(
      `UPDATE backup_sets
          SET adapter_metadata_encrypted=COALESCE(adapter_metadata_encrypted,?),updated_at=NOW()
        WHERE id=? AND status='COMPLETED'`,
      [this.protected(JSON.stringify(metadata)), positiveId(backupSetId, 'backup set id')]
    );
    return update.affectedRows === 1;
  }

  async listPendingScheduledBackups(limit = 20) {
    const safeLimit = boundedInteger(limit, 1, 100, 20);
    const [rows] = await this.pool.execute(
      `SELECT * FROM backup_sets
        WHERE schedule_id IS NOT NULL AND status='PENDING'
        ORDER BY created_at ASC,id ASC LIMIT ${safeLimit}`
    );
    return rows;
  }

  async audit(action, details = {}, actorId = null) {
    await this.pool.execute(
      `INSERT INTO system_audit_log
         (user_id, employee_id, action_performed, module, new_value, ip_address, user_agent, timestamp)
       VALUES (?, NULL, ?, 'BACKUP_RESTORE', ?, 'system', 'backup-automation-service', NOW())`,
      [actorId || null, String(action).slice(0, 255), JSON.stringify(details)]
    );
  }

  async listRetentionPolicies(policyId = null) {
    const [rows] = await this.pool.execute(
      `SELECT * FROM backup_retention_policies WHERE enabled=1 AND (? IS NULL OR id=?) ORDER BY id`,
      [policyId || null, policyId || null]
    );
    return rows;
  }

  async listRetentionScope(policy) {
    const [rows] = await this.pool.execute(
      `SELECT * FROM backup_sets
        WHERE status IN ('VERIFIED','RESTORED')
          AND retention_status IN ('ACTIVE','EXPIRED')
          AND artifact_deleted_at IS NULL
          AND (retention_status='ACTIVE' OR updated_at < DATE_SUB(NOW(), INTERVAL 1 HOUR))
          AND storage_location_encrypted IS NOT NULL AND checksum IS NOT NULL
          AND (? IS NULL OR backup_type=?)
          AND (? IS NULL OR storage_provider=?)
          AND NOT EXISTS (
            SELECT 1 FROM restore_jobs rj
             WHERE rj.backup_set_id=backup_sets.id
               AND rj.status IN ('AWAITING_APPROVAL','APPROVED','DRY_RUN_IN_PROGRESS','DRY_RUN_PASSED','IN_PROGRESS','VERIFYING')
          )
          AND NOT EXISTS (
            SELECT 1
              FROM module_recovery_points mrp
              JOIN module_rollback_requests mrr ON mrr.recovery_point_id=mrp.id
             WHERE mrp.backup_set_id=backup_sets.id
               AND mrr.status IN ('AWAITING_APPROVAL','APPROVED','IN_PROGRESS','VERIFYING')
          )
          AND NOT EXISTS (
            SELECT 1 FROM backup_restore_drill_runs bdr
             WHERE bdr.backup_set_id=backup_sets.id AND bdr.status IN ('QUEUED','RUNNING')
          )
        ORDER BY COALESCE(verified_at,completed_at,created_at) DESC, id DESC`,
      [policy.backup_type || null, policy.backup_type || null, policy.storage_provider || null, policy.storage_provider || null]
    );
    return rows.map(row => ({ ...row, storage_location: this.revealed(row.storage_location_encrypted) }));
  }

  async markBackupExpired(backupSetId, expiresAt) {
    const id = positiveId(backupSetId, 'backup set id');
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        `UPDATE backup_sets SET retention_status='EXPIRED', expires_at=COALESCE(expires_at,?), updated_at=NOW()
          WHERE id=? AND artifact_deleted_at IS NULL
            AND (retention_status='ACTIVE' OR (retention_status='EXPIRED' AND updated_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)))
            AND NOT EXISTS (
              SELECT 1 FROM restore_jobs rj
               WHERE rj.backup_set_id=backup_sets.id
                 AND rj.status IN ('AWAITING_APPROVAL','APPROVED','DRY_RUN_IN_PROGRESS','DRY_RUN_PASSED','IN_PROGRESS','VERIFYING')
            )
            AND NOT EXISTS (
              SELECT 1
                FROM module_recovery_points mrp
                JOIN module_rollback_requests mrr ON mrr.recovery_point_id=mrp.id
               WHERE mrp.backup_set_id=backup_sets.id
                 AND mrr.status IN ('AWAITING_APPROVAL','APPROVED','IN_PROGRESS','VERIFYING')
            )
            AND NOT EXISTS (
              SELECT 1 FROM backup_restore_drill_runs bdr
               WHERE bdr.backup_set_id=backup_sets.id AND bdr.status IN ('QUEUED','RUNNING')
            )`,
        [expiresAt, id]
      );
      if (result.affectedRows === 1) {
        await connection.execute(
          `UPDATE module_recovery_points
              SET status='EXPIRED',rollback_available=0,updated_at=NOW()
            WHERE backup_set_id=? AND status='AVAILABLE'`,
          [id]
        );
      }
      await connection.commit();
      return result.affectedRows === 1;
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async markArtifactDeleted(backupSetId) {
    const [result] = await this.pool.execute(
      `UPDATE backup_sets
          SET retention_status='DELETED', artifact_deleted_at=NOW(), updated_at=NOW()
        WHERE id=? AND retention_status='EXPIRED' AND artifact_deleted_at IS NULL`,
      [positiveId(backupSetId, 'backup set id')]
    );
    return result.affectedRows === 1;
  }

  async listPendingAdminActions() {
    const [backups] = await this.pool.execute(
      `SELECT id, created_by AS requested_by, backup_reference AS reference
         FROM backup_sets WHERE status='COMPLETED' AND verification_status='NOT_VERIFIED'`
    );
    const [restores] = await this.pool.execute(
      `SELECT id, requested_by, CONCAT('Restore #',id) AS reference
         FROM restore_jobs WHERE status='AWAITING_APPROVAL'`
    );
    const [rollbacks] = await this.pool.execute(
      `SELECT id, requested_by, CONCAT('Rollback #',id) AS reference
         FROM module_rollback_requests WHERE status='AWAITING_APPROVAL'`
    );
    return [
      ...backups.map(row => ({ ...row, category: 'BACKUP_VERIFICATION_REQUIRED', resourceType: 'BACKUP_SET', title: 'Backup verification required', message: `${row.reference} is ready for MFA-protected checksum verification.` })),
      ...restores.map(row => ({ ...row, category: 'RESTORE_APPROVAL_REQUIRED', resourceType: 'RESTORE_JOB', title: 'Restore approval required', message: `${row.reference} is waiting for MFA-protected administrator approval.` })),
      ...rollbacks.map(row => ({ ...row, category: 'ROLLBACK_APPROVAL_REQUIRED', resourceType: 'ROLLBACK_REQUEST', title: 'Rollback approval required', message: `${row.reference} is waiting for MFA-protected administrator approval.` })),
    ];
  }

  async listActiveSystemAdmins() {
    const [rows] = await this.pool.execute(
      `SELECT u.id
         FROM users u JOIN roles r ON r.id=u.role_id
        WHERE u.is_active=1
          AND LOWER(REPLACE(REPLACE(TRIM(r.name),' ','_'),'-','_')) IN ('system_admin','system_administrator','admin')
        ORDER BY u.id`
    );
    return rows.map(row => Number(row.id));
  }

  async upsertNotification(notification) {
    await this.pool.execute(
      `INSERT INTO backup_action_notifications
         (dedupe_key,recipient_user_id,category,resource_type,resource_id,action_required,title,message,status)
       VALUES (?,?,?,?,?,?,?,?,'UNREAD')
       ON DUPLICATE KEY UPDATE
         action_required=VALUES(action_required), title=VALUES(title), message=VALUES(message),
         read_at=IF(status='RESOLVED',NULL,read_at),
         status=IF(status='RESOLVED','UNREAD',status), resolved_at=NULL, updated_at=NOW()`,
      [notification.dedupeKey, notification.recipientUserId, notification.category, notification.resourceType,
        notification.resourceId, notification.actionRequired !== false, notification.title, notification.message]
    );
  }

  async resolveStaleActionNotifications() {
    const statements = [
      [`BACKUP_VERIFICATION_REQUIRED`, `BACKUP_SET`, `backup_sets`, `created_by`, `b.status<>'COMPLETED' OR b.verification_status<>'NOT_VERIFIED'`],
      [`RESTORE_APPROVAL_REQUIRED`, `RESTORE_JOB`, `restore_jobs`, `requested_by`, `b.status<>'AWAITING_APPROVAL'`],
      [`ROLLBACK_APPROVAL_REQUIRED`, `ROLLBACK_REQUEST`, `module_rollback_requests`, `requested_by`, `b.status<>'AWAITING_APPROVAL'`],
    ];
    let resolved = 0;
    for (const [category, resourceType, table, makerColumn, stale] of statements) {
      const [result] = await this.pool.execute(
        `UPDATE backup_action_notifications n
           LEFT JOIN ${table} b ON b.id=n.resource_id
            SET n.status='RESOLVED', n.action_required=0, n.read_at=COALESCE(n.read_at,NOW()),
                n.resolved_at=NOW(), n.updated_at=NOW()
          WHERE n.category=? AND n.resource_type=? AND n.status IN ('UNREAD','READ')
            AND (b.id IS NULL OR ${stale}
                 OR n.recipient_user_id<>b.${makerColumn})`,
        [category, resourceType]
      );
      resolved += Number(result.affectedRows || 0);
    }
    return resolved;
  }

  async listDueDrillSchedules(now, limit = 10) {
    const safeLimit = boundedInteger(limit, 1, 100, 10);
    const [rows] = await this.pool.execute(
      `SELECT * FROM backup_restore_drill_schedules
        WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?
        ORDER BY next_run_at ASC,id ASC LIMIT ${safeLimit}`,
      [now]
    );
    return rows;
  }

  async getDrillSchedule(id) {
    const [rows] = await this.pool.execute('SELECT * FROM backup_restore_drill_schedules WHERE id=? LIMIT 1', [positiveId(id, 'drill schedule id')]);
    return rows[0] || null;
  }

  async claimDrillSchedule({ scheduleId, expectedNextRunAt, nextRunAt, now }) {
    const [result] = await this.pool.execute(
      `UPDATE backup_restore_drill_schedules
          SET last_run_at=?,last_status='RUNNING',next_run_at=?,updated_at=NOW()
        WHERE id=? AND enabled=1 AND next_run_at=?`,
      [now, nextRunAt, positiveId(scheduleId, 'drill schedule id'), expectedNextRunAt]
    );
    return result.affectedRows === 1;
  }

  async markDrillScheduleStarted(id, now) {
    await this.pool.execute(
      `UPDATE backup_restore_drill_schedules SET last_run_at=?,last_status='RUNNING',updated_at=NOW() WHERE id=?`,
      [now, positiveId(id, 'drill schedule id')]
    );
  }

  async finishDrillSchedule(id, status) {
    await this.pool.execute(
      `UPDATE backup_restore_drill_schedules SET last_status=?,updated_at=NOW() WHERE id=?`,
      [String(status).toUpperCase(), positiveId(id, 'drill schedule id')]
    );
  }

  async findLatestVerifiedBackup(schedule) {
    const moduleKey = schedule.module_key_filter || null;
    const [rows] = await this.pool.execute(
      `SELECT * FROM backup_sets
        WHERE status='VERIFIED' AND verification_status='MATCH' AND integrity_status='PASSED'
          AND verified_at IS NOT NULL AND retention_status='ACTIVE' AND artifact_deleted_at IS NULL
          AND storage_location_encrypted IS NOT NULL AND checksum IS NOT NULL
          AND backup_type<>'DEPLOYMENT_VERSION'
          AND (? IS NULL OR backup_type=?)
          AND (? IS NULL OR storage_provider=?)
          AND (? IS NULL OR JSON_CONTAINS(IF(JSON_VALID(included_modules),included_modules,JSON_ARRAY()),JSON_QUOTE(?)))
        ORDER BY verified_at DESC,id DESC LIMIT 1`,
      [schedule.backup_type_filter || null, schedule.backup_type_filter || null,
        schedule.storage_provider_filter || null, schedule.storage_provider_filter || null,
        moduleKey, moduleKey]
    );
    if (!rows[0]) return null;
    let adapterMetadata = null;
    try {
      adapterMetadata = rows[0].adapter_metadata_encrypted
        ? JSON.parse(this.revealed(rows[0].adapter_metadata_encrypted))
        : null;
    } catch (_) {
      adapterMetadata = null;
    }
    return {
      ...rows[0],
      storage_location: this.revealed(rows[0].storage_location_encrypted),
      adapter_metadata: adapterMetadata,
      expected_integrity: adapterMetadata?.integrityReport || null,
    };
  }

  async createDrillRun({ schedule, backup, scheduledFor }) {
    const key = `drill:${schedule.schedule_reference}:${asDate(scheduledFor).toISOString()}`.slice(0, 128);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [existing] = await connection.execute('SELECT * FROM backup_restore_drill_runs WHERE idempotency_key=? FOR UPDATE', [key]);
      if (existing.length) {
        await connection.commit();
        return { ...existing[0], _idempotent: true };
      }
      const reference = `DRILL-${Number(schedule.id)}-${compactTimestamp(scheduledFor)}`;
      const [insert] = await connection.execute(
        `INSERT INTO backup_restore_drill_runs
           (run_reference,idempotency_key,schedule_id,backup_set_id,status,integrity_status,started_at,created_by,updated_by)
         VALUES (?,?,?,?, 'RUNNING','CHECKING',NOW(),?,?)`,
        [reference, key, schedule.id, backup?.id || null, schedule.created_by || null, schedule.created_by || null]
      );
      const [created] = await connection.execute('SELECT * FROM backup_restore_drill_runs WHERE id=?', [insert.insertId]);
      await connection.commit();
      return created[0];
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async finishDrillRun(runId, { status, integrityStatus, result, failure, actorId }) {
    const [update] = await this.pool.execute(
      `UPDATE backup_restore_drill_runs
          SET status=?,integrity_status=?,integrity_checked_at=NOW(),result_message_encrypted=?,
              failure_message_encrypted=?,completed_at=NOW(),updated_by=COALESCE(?,updated_by),updated_at=NOW()
        WHERE id=? AND status='RUNNING'`,
      [status, integrityStatus, this.protected(result ? JSON.stringify(result) : null), this.protected(failure || null),
        actorId || null, positiveId(runId, 'drill run id')]
    );
    return update.affectedRows === 1;
  }
}

class BackupAutomationService {
  constructor(options = {}) {
    if (!options.runtime) throw backupError('Backup runtime is required.', 'BACKUP_RUNTIME_REQUIRED');
    if (!options.repository) throw backupError('Backup automation repository is required.', 'BACKUP_AUTOMATION_REPOSITORY_REQUIRED');
    this.runtime = options.runtime;
    this.repository = options.repository;
    this.worker = options.worker || new BackupWorker({ runtime: this.runtime, repository: this.repository });
    this.environment = options.environment || process.env;
    this.clock = options.clock || (() => new Date());
    this.logger = options.logger || console;
    this.intervalMs = Math.max(1000, Number(options.intervalMs || this.environment.BACKUP_AUTOMATION_INTERVAL_MS || 60000));
    this.timer = null;
    this.inFlight = null;
  }

  providerReadiness() {
    return providerReadinessFromEnv(this.environment);
  }

  async executeSchedule(schedule, { actorId, scheduledFor }) {
    const occurrence = atSecondPrecision(scheduledFor || this.clock());
    const ageDays = boundedInteger(schedule.retention_max_age_days, 1, 36500, null);
    const expiresAt = ageDays ? new Date(asDate(this.clock()).getTime() + (ageDays * 86400000)) : null;
    const backup = await this.repository.createScheduledBackup({ schedule, scheduledFor: occurrence, expiresAt });
    let result = null;
    try {
      result = await this.worker.execute({ backupSet: { ...backup, included_modules: parseModules(backup.included_modules) } });
      if (result.integrityReport && typeof this.repository.persistBackupIntegrityMetadata === 'function') {
        const persisted = await this.repository.persistBackupIntegrityMetadata(backup.id, result);
        if (!persisted) throw backupError('Backup integrity evidence could not be persisted.', 'BACKUP_INTEGRITY_METADATA_PERSIST_FAILED');
      }
      await this.repository.finishBackupSchedule(schedule.id, 'SUCCESS');
      await this.repository.audit('COMPLETE_SCHEDULED_BACKUP', {
        schedule_id: Number(schedule.id), backup_set_id: Number(backup.id), status: result.status,
        administrator_verification_required: true,
      }, actorId || schedule.created_by);
      return { scheduleId: Number(schedule.id), backupSetId: Number(backup.id), status: result.status, administratorVerificationRequired: true };
    } catch (error) {
      if (result?.status === 'COMPLETED' && result?.integrityReport) {
        await this.repository.transitionBackup({
          backupSetId: backup.id,
          expectedStatus: 'COMPLETED',
          status: 'FAILED',
          patch: { failureCode: 'BACKUP_INTEGRITY_METADATA_PERSIST_FAILED', failedAt: this.clock() },
        }).catch(() => {});
      }
      await this.repository.finishBackupSchedule(schedule.id, 'FAILED').catch(() => {});
      await this.repository.audit('FAIL_SCHEDULED_BACKUP', {
        schedule_id: Number(schedule.id), backup_set_id: Number(backup.id), error_code: safeErrorCode(error),
      }, actorId || schedule.created_by).catch(() => {});
      throw error;
    }
  }

  async runScheduleById(id, options = {}) {
    const schedule = await this.repository.getBackupSchedule(positiveId(id, 'schedule id'));
    if (!schedule) throw backupError('Backup schedule was not found.', 'BACKUP_SCHEDULE_NOT_FOUND');
    const scheduledFor = atSecondPrecision(options.scheduledFor || this.clock());
    await this.repository.markBackupScheduleStarted(schedule.id, scheduledFor);
    return this.executeSchedule(schedule, { actorId: options.actorId, scheduledFor });
  }

  async resumePendingScheduledBackups(options = {}) {
    if (typeof this.repository.listPendingScheduledBackups !== 'function') return [];
    const pending = await this.repository.listPendingScheduledBackups(options.limit || 20);
    const results = [];
    for (const backup of pending) {
      let result = null;
      try {
        result = await this.worker.execute({ backupSet: { ...backup, included_modules: parseModules(backup.included_modules) } });
        if (result.integrityReport && typeof this.repository.persistBackupIntegrityMetadata === 'function') {
          const persisted = await this.repository.persistBackupIntegrityMetadata(backup.id, result);
          if (!persisted) throw backupError('Backup integrity evidence could not be persisted.', 'BACKUP_INTEGRITY_METADATA_PERSIST_FAILED');
        }
        await this.repository.finishBackupSchedule(backup.schedule_id, 'SUCCESS');
        await this.repository.audit('RESUME_SCHEDULED_BACKUP', {
          schedule_id: Number(backup.schedule_id), backup_set_id: Number(backup.id), status: result.status,
          administrator_verification_required: true,
        }, backup.created_by);
        results.push({
          scheduleId: Number(backup.schedule_id),
          backupSetId: Number(backup.id),
          status: result.status,
          administratorVerificationRequired: true,
        });
      } catch (error) {
        if (result?.status === 'COMPLETED' && result?.integrityReport) {
          await this.repository.transitionBackup({
            backupSetId: backup.id,
            expectedStatus: 'COMPLETED',
            status: 'FAILED',
            patch: { failureCode: 'BACKUP_INTEGRITY_METADATA_PERSIST_FAILED', failedAt: this.clock() },
          }).catch(() => {});
        }
        await this.repository.finishBackupSchedule(backup.schedule_id, 'FAILED').catch(() => {});
        results.push({ scheduleId: Number(backup.schedule_id), backupSetId: Number(backup.id), status: 'FAILED', errorCode: safeErrorCode(error) });
      }
    }
    return results;
  }

  async runDueBackupSchedules(options = {}) {
    const now = asDate(options.now || this.clock());
    const due = await this.repository.listDueBackupSchedules(now, options.limit || 10);
    const results = [];
    for (const schedule of due) {
      const scheduledFor = asDate(schedule.next_run_at);
      const nextRunAt = computeNextRunAt(schedule, scheduledFor);
      const ageDays = boundedInteger(schedule.retention_max_age_days, 1, 36500, null);
      const expiresAt = ageDays ? new Date(now.getTime() + (ageDays * 86400000)) : null;
      const claimed = await this.repository.claimBackupSchedule({
        scheduleId: schedule.id,
        expectedNextRunAt: schedule.next_run_at,
        nextRunAt,
        now,
        schedule,
        scheduledFor,
        expiresAt,
      });
      if (!claimed) continue;
      try {
        results.push(await this.executeSchedule(schedule, { actorId: schedule.created_by, scheduledFor }));
      } catch (error) {
        results.push({ scheduleId: Number(schedule.id), status: 'FAILED', errorCode: safeErrorCode(error) });
      }
    }
    return results;
  }

  async runRetention(options = {}) {
    return this.enforceRetention(options);
  }

  async enforceRetention(options = {}) {
    const now = asDate(options.now || this.clock());
    const policyId = options.policyId ? positiveId(options.policyId, 'retention policy id') : null;
    const policies = await this.repository.listRetentionPolicies(policyId);
    if (policyId && !policies.length) {
      throw backupError('Backup retention policy was not found.', 'BACKUP_RETENTION_POLICY_NOT_FOUND');
    }
    const results = [];
    for (const policy of policies) {
      const rows = await this.repository.listRetentionScope(policy);
      const keepLast = boundedInteger(policy.keep_last, 0, 100000, 0);
      const maxAgeDays = boundedInteger(policy.max_age_days, 1, 36500, 30);
      const cutoff = new Date(now.getTime() - (maxAgeDays * 86400000));
      for (const backup of rows.slice(keepLast)) {
        const basis = asDate(backup.verified_at || backup.completed_at || backup.created_at);
        if (basis.getTime() > cutoff.getTime()) continue;
        if (backup.retention_status === 'EXPIRED' && !policy.delete_expired_artifacts) continue;
        const claimed = await this.repository.markBackupExpired(backup.id, new Date(basis.getTime() + (maxAgeDays * 86400000)));
        if (!claimed) continue;
        const summary = { policyId: Number(policy.id), backupSetId: Number(backup.id), status: 'EXPIRED' };
        await this.repository.audit('EXPIRE_BACKUP_ARTIFACT', {
          policy_id: Number(policy.id),
          backup_set_id: Number(backup.id),
          storage_provider: backup.storage_provider,
          physical_deletion_requested: Boolean(policy.delete_expired_artifacts),
          recovery_points_expired: true,
          database_evidence_preserved: true,
        }, options.actorId || policy.updated_by || policy.created_by);
        if (!policy.delete_expired_artifacts) {
          results.push(summary);
          continue;
        }
        try {
          const deletion = await this.runtime.deleteArtifact({
            storageProvider: backup.storage_provider,
            storageLocation: backup.storage_location,
            expectedChecksum: backup.checksum,
          });
          if (deletion?.deletionPending) {
            await this.repository.audit('START_EXPIRED_BACKUP_ARTIFACT_DELETE', {
              policy_id: Number(policy.id), backup_set_id: Number(backup.id), storage_provider: backup.storage_provider,
              deletion_pending: true, database_evidence_preserved: true,
            }, options.actorId || policy.updated_by || policy.created_by);
            results.push({ ...summary, status: 'DELETE_PENDING' });
            continue;
          }
          await this.repository.markArtifactDeleted(backup.id);
          await this.repository.audit('DELETE_EXPIRED_BACKUP_ARTIFACT', {
            policy_id: Number(policy.id), backup_set_id: Number(backup.id), storage_provider: backup.storage_provider,
            database_evidence_preserved: true,
          }, options.actorId || policy.updated_by || policy.created_by);
          results.push({ ...summary, status: 'DELETED' });
        } catch (error) {
          const errorCode = safeErrorCode(error);
          await this.notifyAdmins({
            category: 'RETENTION_ERROR', resourceType: 'BACKUP_SET', resourceId: backup.id,
            title: 'Backup retention needs attention',
            message: `Artifact cleanup for backup ${backup.backup_reference} was stopped safely (${errorCode}).`,
            dedupePrefix: `retention-error:${policy.id}:${backup.id}`,
          });
          await this.repository.audit('FAIL_BACKUP_RETENTION_DELETE', {
            policy_id: Number(policy.id), backup_set_id: Number(backup.id), error_code: errorCode,
            database_evidence_preserved: true,
          }, options.actorId || policy.updated_by || policy.created_by).catch(() => {});
          results.push({ ...summary, status: 'ERROR', errorCode });
        }
      }
    }
    return results;
  }

  async notifyAdmins(notification, preferredUserId = null) {
    const eligibleAdmins = await this.repository.listActiveSystemAdmins();
    const preferred = Number(preferredUserId);
    // Pending workflow actions belong in the requester's own Action Inbox.
    // General operational alerts (no preferred user) still go to all admins.
    const recipients = Number.isSafeInteger(preferred) && eligibleAdmins.includes(preferred)
      ? [preferred]
      : eligibleAdmins;
    for (const recipientUserId of recipients) {
      await this.repository.upsertNotification({
        ...notification,
        recipientUserId,
        actionRequired: notification.actionRequired !== false,
        dedupeKey: `${notification.dedupePrefix}:${recipientUserId}`.slice(0, 160),
      });
    }
    return recipients.length;
  }

  async reconcileNotifications() {
    const pending = await this.repository.listPendingAdminActions();
    let createdOrRefreshed = 0;
    for (const action of pending) {
      createdOrRefreshed += await this.notifyAdmins({
        category: action.category,
        resourceType: action.resourceType,
        resourceId: action.id,
        title: action.title,
        message: action.message,
        dedupePrefix: `${action.category}:${action.id}`,
      }, action.requested_by);
    }
    const resolved = await this.repository.resolveStaleActionNotifications();
    return { pendingActions: pending.length, createdOrRefreshed, resolved };
  }

  async executeDrill(schedule, { actorId, scheduledFor }) {
    const occurrence = atSecondPrecision(scheduledFor || this.clock());
    const backup = await this.repository.findLatestVerifiedBackup(schedule);
    const run = await this.repository.createDrillRun({ schedule, backup, scheduledFor: occurrence });
    if (run._idempotent && run.status !== 'RUNNING') {
      return {
        scheduleId: Number(schedule.id), runId: Number(run.id), backupSetId: Number(run.backup_set_id) || null,
        status: run.status, safeToRestore: run.status === 'PASSED', liveRestoreApplied: false, idempotent: true,
      };
    }
    if (!backup) {
      const result = { safeToRestore: false, reason: 'NO_ELIGIBLE_VERIFIED_BACKUP' };
      await this.repository.finishDrillRun(run.id, {
        status: 'SKIPPED', integrityStatus: 'NOT_CHECKED', result, actorId,
      });
      await this.repository.finishDrillSchedule(schedule.id, 'SKIPPED');
      return { scheduleId: Number(schedule.id), runId: Number(run.id), status: 'SKIPPED', ...result };
    }
    try {
      // Scheduled drills deliberately call only the isolated dry-run operation.
      // They never call applyRestore or create a live cutover.
      let report;
      if (backup.storage_provider === 'RDS_SNAPSHOT') {
        if (backup.backup_type !== 'DATABASE' || typeof this.runtime.runRdsRestoreDrill !== 'function') {
          throw backupError('RDS restore drills require a verified DATABASE snapshot.', 'RDS_DRILL_BACKUP_INVALID');
        }
        report = await this.runtime.runRdsRestoreDrill({
          backupReference: backup.backup_reference,
          storageLocation: backup.storage_location,
          expectedChecksum: backup.checksum,
          expectedIntegrity: backup.expected_integrity,
          drillReference: run.run_reference,
        });
      } else {
        report = await this.runtime.runRestoreDryRun({
          backupReference: backup.backup_reference,
          backupType: backup.backup_type,
          storageProvider: backup.storage_provider,
          storageLocation: backup.storage_location,
          expectedChecksum: backup.checksum,
        });
      }
      const passed = report.safeToRestore === true && (
        backup.storage_provider !== 'RDS_SNAPSHOT' || report.disposableInstanceDeleted === true
      );
      await this.repository.finishDrillRun(run.id, {
        status: passed ? 'PASSED' : 'FAILED',
        integrityStatus: passed ? 'PASSED' : 'FAILED',
        result: report,
        failure: passed ? null : 'Isolated restore drill did not pass every integrity check.',
        actorId,
      });
      await this.repository.finishDrillSchedule(schedule.id, passed ? 'PASSED' : 'FAILED');
      await this.repository.audit(passed ? 'PASS_SCHEDULED_RESTORE_DRILL' : 'FAIL_SCHEDULED_RESTORE_DRILL', {
        drill_schedule_id: Number(schedule.id), drill_run_id: Number(run.id), backup_set_id: Number(backup.id),
        isolated_dry_run: true, live_restore_applied: false,
      }, actorId || schedule.created_by);
      if (!passed) {
        await this.notifyAdmins({
          category: 'DRILL_RESULT', resourceType: 'DRILL_RUN', resourceId: run.id,
          title: 'Restore drill failed', message: `Restore drill ${run.run_reference} needs review. No live restore was applied.`,
          dedupePrefix: `drill-result:${run.id}`,
        });
      }
      return { scheduleId: Number(schedule.id), runId: Number(run.id), backupSetId: Number(backup.id), status: passed ? 'PASSED' : 'FAILED', safeToRestore: passed, liveRestoreApplied: false };
    } catch (error) {
      const errorCode = safeErrorCode(error);
      await this.repository.finishDrillRun(run.id, {
        status: 'FAILED', integrityStatus: 'ERROR', failure: `Restore drill failed (${errorCode}).`, actorId,
      }).catch(() => {});
      await this.repository.finishDrillSchedule(schedule.id, 'FAILED').catch(() => {});
      await this.repository.audit('ERROR_SCHEDULED_RESTORE_DRILL', {
        drill_schedule_id: Number(schedule.id), drill_run_id: Number(run.id), backup_set_id: Number(backup.id),
        error_code: errorCode, live_restore_applied: false,
      }, actorId || schedule.created_by).catch(() => {});
      await this.notifyAdmins({
        category: 'DRILL_RESULT', resourceType: 'DRILL_RUN', resourceId: run.id,
        title: 'Restore drill failed',
        message: `Restore drill ${run.run_reference} failed (${errorCode}). Review the protected drill evidence and disposable resource cleanup.`,
        dedupePrefix: `drill-result:${run.id}`,
      }).catch(() => {});
      throw error;
    }
  }

  async runDrillById(id, options = {}) {
    const schedule = await this.repository.getDrillSchedule(positiveId(id, 'drill schedule id'));
    if (!schedule) throw backupError('Restore drill schedule was not found.', 'RESTORE_DRILL_SCHEDULE_NOT_FOUND');
    const scheduledFor = atSecondPrecision(options.scheduledFor || this.clock());
    await this.repository.markDrillScheduleStarted(schedule.id, scheduledFor);
    return this.executeDrill(schedule, { actorId: options.actorId, scheduledFor });
  }

  async runDueRestoreDrills(options = {}) {
    const now = asDate(options.now || this.clock());
    const due = await this.repository.listDueDrillSchedules(now, options.limit || 10);
    const results = [];
    for (const schedule of due) {
      const scheduledFor = asDate(schedule.next_run_at);
      const nextRunAt = computeNextRunAt(schedule, scheduledFor);
      if (!await this.repository.claimDrillSchedule({ scheduleId: schedule.id, expectedNextRunAt: schedule.next_run_at, nextRunAt, now })) continue;
      try {
        results.push(await this.executeDrill(schedule, { actorId: schedule.created_by, scheduledFor }));
      } catch (error) {
        results.push({ scheduleId: Number(schedule.id), status: 'FAILED', errorCode: safeErrorCode(error), liveRestoreApplied: false });
      }
    }
    return results;
  }

  async runCycle() {
    const safely = async (name, callback, fallback) => {
      try { return await callback(); }
      catch (error) {
        this.logger.error?.(`[backup-automation:${name}]`, safeErrorCode(error));
        return { ...fallback, errorCode: safeErrorCode(error) };
      }
    };
    const resumed = enabledSetting(this.environment.BACKUP_AUTOMATION_ENABLED)
      ? await safely('resume', () => this.resumePendingScheduledBackups(), [])
      : [];
    const backups = enabledSetting(this.environment.BACKUP_AUTOMATION_ENABLED)
      ? await safely('schedules', () => this.runDueBackupSchedules(), [])
      : [];
    const notifications = await safely('notifications', () => this.reconcileNotifications(), { pendingActions: 0, createdOrRefreshed: 0, resolved: 0 });
    const drills = enabledSetting(this.environment.BACKUP_RESTORE_DRILL_AUTOMATION_ENABLED)
      ? await safely('drills', () => this.runDueRestoreDrills(), [])
      : [];
    // Cleanup runs after drills so an in-process drill never races deletion of
    // the artifact it just selected.
    const retention = enabledSetting(this.environment.BACKUP_RETENTION_AUTOMATION_ENABLED)
      ? await safely('retention', () => this.enforceRetention(), [])
      : [];
    return { resumed, backups, retention, notifications, drills };
  }

  start() {
    if (this.timer) return this;
    const tick = () => {
      if (this.inFlight) return;
      this.inFlight = this.runCycle()
        .catch(error => this.logger.error?.('[backup-automation]', safeErrorCode(error)))
        .finally(() => { this.inFlight = null; });
    };
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
    tick();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }
}

function createBackupAutomationService(options = {}) {
  const environment = options.environment || process.env;
  const pool = options.pool || require('../../config/db');
  let protectText = options.protectText;
  let revealText = options.revealText;
  if (!protectText || !revealText) {
    const dataProtection = require('../../server/data-protection');
    protectText = protectText || dataProtection.encryptColumnValue;
    revealText = revealText || dataProtection.decryptColumnValue;
  }
  const runtime = options.runtime || createBackupRuntimeFromEnv({ environment });
  const repository = options.repository || new BackupAutomationRepository({ pool, protectText, revealText });
  return new BackupAutomationService({ ...options, environment, runtime, repository });
}

module.exports = {
  BackupAutomationRepository,
  BackupAutomationService,
  ADMIN_ACTION_CATEGORIES,
  // Compatibility alias for older imports; new code uses ADMIN_ACTION_CATEGORIES.
  CHECKER_CATEGORIES: ADMIN_ACTION_CATEGORIES,
  computeNextRunAt,
  createBackupAutomationService,
  providerReadinessFromEnv,
};
