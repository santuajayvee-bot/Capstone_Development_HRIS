'use strict';

const { createProbeResult, ProbeFailure } = require('../probeResult');
const { ageHours, tableExists } = require('./helpers');
const { boundedInteger } = require('../probeRunner');

function verifiedBackup(row) {
  return row
    && ['VERIFIED', 'RESTORED'].includes(String(row.status || '').toUpperCase())
    && row.verification_status === 'MATCH'
    && row.integrity_status === 'PASSED'
    && row.checksum
    && row.storage_location_encrypted
    && row.verified_at;
}

async function probeBackup({ pool, runtimeFactory, decryptText } = {}) {
  const backupTable = await tableExists(pool, 'backup_sets');
  if (!backupTable) throw new ProbeFailure('BACKUP_LOG_UNAVAILABLE', 'Backup recovery records are unavailable.');
  const [latestRows] = await pool.execute(
    `SELECT id, backup_reference, backup_type, storage_provider, storage_location_encrypted, checksum,
            status, verification_status, integrity_status, verified_at, adapter_metadata_encrypted
       FROM backup_sets
      WHERE retention_status='ACTIVE' AND artifact_deleted_at IS NULL
      ORDER BY created_at DESC, id DESC LIMIT 1`
  );
  const latest = latestRows[0] || null;
  if (!latest) throw new ProbeFailure('BACKUP_RECORD_MISSING', 'No active backup record is available.');
  const verified = verifiedBackup(latest);
  const maxAgeHours = boundedInteger(process.env.SYSTEM_HEALTH_BACKUP_MAX_AGE_HOURS, 24, 1, 8760);
  const age = ageHours(latest.verified_at);
  const stale = verified && age !== null && age > maxAgeHours;
  const drillTable = await tableExists(pool, 'backup_restore_drill_runs');
  let latestDrill = null;
  if (drillTable) {
    const [rows] = await pool.execute(
      `SELECT MAX(completed_at) AS latest_passed_drill FROM backup_restore_drill_runs WHERE status='PASSED'`
    );
    latestDrill = rows[0]?.latest_passed_drill || null;
  }
  const maxDrillDays = boundedInteger(process.env.SYSTEM_HEALTH_RESTORE_DRILL_MAX_AGE_DAYS, 90, 1, 3650);
  const drillAgeHours = ageHours(latestDrill);
  const staleDrill = drillTable && (drillAgeHours === null || drillAgeHours > maxDrillDays * 24);
  if (!verified) {
    return createProbeResult({
      status: 'WARNING',
      remarks: 'Latest active backup exists but is not fully verified and restorable.',
      probeType: 'INTEGRITY',
      probeTarget: 'backup_sets verified artifact evidence',
      checks: {
        latest_backup_present: { passed: true, message: 'An active backup record exists.' },
        backup_verified: { passed: false, message: 'Latest active backup lacks complete verification or integrity evidence.' },
        artifact_integrity: { passed: false, message: 'Artifact content verification was skipped because record evidence is incomplete.' },
      },
      dependencies: { latest_backup: { label: 'Latest active backup', available: true, status: String(latest.status || 'UNKNOWN') } },
      validationPassed: false,
      failureCode: 'BACKUP_NOT_RESTORABLE',
    });
  }

  let artifactVerified = false;
  try {
    const reveal = decryptText || require('../../../server/data-protection').decryptColumnValue;
    const location = reveal(latest.storage_location_encrypted);
    if (!location) throw new Error('Artifact location is unavailable.');
    const createRuntime = runtimeFactory || require('../../backup').createBackupRuntimeFromEnv;
    const runtime = createRuntime();
    const verification = await runtime.verifyBackup({
      storageProvider: latest.storage_provider,
      storageLocation: location,
      expectedChecksum: latest.checksum,
    });
    artifactVerified = Boolean(verification?.valid);
    if (!artifactVerified) throw new Error('Artifact checksum verification did not pass.');
  } catch (error) {
    throw new ProbeFailure('BACKUP_ARTIFACT_UNAVAILABLE', 'Verified backup artifact could not be read and integrity-checked safely.', { cause: error });
  }

  const status = stale || staleDrill ? 'WARNING' : 'ONLINE';
  return createProbeResult({
    status,
    remarks: stale
      ? 'Latest verified backup artifact passed integrity validation but is older than the configured recovery-point objective.'
      : staleDrill
        ? 'Latest verified backup artifact passed integrity validation, but the restore drill is overdue.'
        : 'Latest verified backup artifact passed read-only integrity validation and recovery freshness checks.',
    probeType: 'INTEGRITY',
    probeTarget: 'backup runtime.verifyBackup + restore-drill freshness',
    checks: {
      latest_backup_present: { passed: true, message: 'An active backup record exists.' },
      backup_verified: { passed: true, message: 'Backup has verified checksum and integrity evidence.' },
      artifact_integrity: { passed: artifactVerified, message: 'Artifact was read and checksum-verified without restoring it.' },
      rpo_freshness: { passed: !stale, message: stale ? 'Backup age exceeds the configured RPO.' : 'Backup age is within the configured RPO.' },
      restore_drill_freshness: { passed: !staleDrill, message: !drillTable ? 'Restore drill table is not installed; drill freshness is unavailable.' : staleDrill ? 'Latest successful restore drill exceeds the configured period.' : 'Latest successful restore drill is within the configured period.' },
    },
    dependencies: {
      latest_backup: { label: 'Latest verified backup', available: true, status: 'Verified', age_hours: age },
      restore_drill: { label: 'Latest successful restore drill', available: Boolean(latestDrill), value: latestDrill, age_hours: drillAgeHours, max_age_days: maxDrillDays },
    },
    validationPassed: true,
  });
}

module.exports = { probeBackup };
