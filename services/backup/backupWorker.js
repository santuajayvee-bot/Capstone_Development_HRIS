'use strict';

const { backupError } = require('./backupErrors');

const BACKUP_STATUS_TRANSITIONS = Object.freeze({
  PENDING: new Set(['RUNNING', 'FAILED']),
  RUNNING: new Set(['COMPLETED', 'FAILED']),
  COMPLETED: new Set(['VERIFIED', 'FAILED']),
  VERIFIED: new Set(),
  FAILED: new Set(),
  RESTORED: new Set(),
});

function assertBackupStatusTransition(fromStatus, toStatus) {
  const from = String(fromStatus || '').toUpperCase();
  const to = String(toStatus || '').toUpperCase();
  if (!BACKUP_STATUS_TRANSITIONS[from]?.has(to)) {
    throw backupError(`Backup cannot move from ${from || 'UNKNOWN'} to ${to || 'UNKNOWN'}.`, 'INVALID_BACKUP_STATUS_TRANSITION');
  }
  return { from, to };
}

class BackupWorker {
  constructor(options = {}) {
    if (!options.runtime) throw backupError('Backup runtime is required.', 'BACKUP_RUNTIME_REQUIRED');
    if (!options.repository || typeof options.repository.transitionBackup !== 'function') {
      throw backupError('Backup worker repository is required.', 'BACKUP_REPOSITORY_REQUIRED');
    }
    this.runtime = options.runtime;
    this.repository = options.repository;
  }

  async transition(backupSetId, fromStatus, toStatus, patch = {}) {
    const transition = assertBackupStatusTransition(fromStatus, toStatus);
    const updated = await this.repository.transitionBackup({
      backupSetId,
      expectedStatus: transition.from,
      status: transition.to,
      patch,
    });
    if (!updated) {
      throw backupError('Backup was claimed or changed by another worker.', 'BACKUP_JOB_CONFLICT', { retryable: true });
    }
  }

  async execute({ backupSet }) {
    const backupSetId = Number(backupSet?.id || backupSet?.backup_set_id);
    if (!Number.isSafeInteger(backupSetId) || backupSetId < 1) {
      throw backupError('Backup set id is invalid.', 'INVALID_BACKUP_REQUEST');
    }
    const initialStatus = String(backupSet.status || '').toUpperCase();
    if (initialStatus === 'VERIFIED') {
      const verification = await this.runtime.verifyBackup({
        storageProvider: backupSet.storage_provider,
        storageLocation: backupSet.storage_location,
        expectedChecksum: backupSet.checksum,
      });
      if (!verification.valid) throw backupError('Verified backup no longer matches its checksum.', 'BACKUP_INTEGRITY_MISMATCH');
      return { status: 'VERIFIED', verified: true, idempotent: true, verification };
    }
    if (initialStatus === 'COMPLETED' && backupSet.storage_location && backupSet.checksum) {
      const verification = await this.runtime.verifyBackup({
        storageProvider: backupSet.storage_provider,
        storageLocation: backupSet.storage_location,
        expectedChecksum: backupSet.checksum,
      });
      if (!verification.valid) {
        await this.transition(backupSetId, 'COMPLETED', 'FAILED', { failureCode: 'BACKUP_INTEGRITY_MISMATCH' });
        throw backupError('Completed backup failed checksum verification.', 'BACKUP_INTEGRITY_MISMATCH');
      }
      await this.transition(backupSetId, 'COMPLETED', 'VERIFIED', { verifiedAt: new Date() });
      return { status: 'VERIFIED', verified: true, idempotent: true, verification };
    }
    if (initialStatus !== 'PENDING') {
      throw backupError('Only pending backup sets can be executed.', 'BACKUP_JOB_NOT_EXECUTABLE');
    }

    await this.transition(backupSetId, 'PENDING', 'RUNNING', { startedAt: new Date() });
    let currentStatus = 'RUNNING';
    try {
      const result = await this.runtime.createBackup({
        backupReference: backupSet.backup_reference,
        backupType: backupSet.backup_type,
        storageProvider: backupSet.storage_provider,
        includedModules: backupSet.included_modules,
      });
      await this.transition(backupSetId, 'RUNNING', 'COMPLETED', {
        storageLocation: result.storageLocation,
        checksum: result.checksum,
        fileSize: result.fileSize,
        completedAt: new Date(),
      });
      currentStatus = 'COMPLETED';
      await this.transition(backupSetId, 'COMPLETED', 'VERIFIED', { verifiedAt: new Date() });
      currentStatus = 'VERIFIED';
      return result;
    } catch (error) {
      if (['RUNNING', 'COMPLETED'].includes(currentStatus)) {
        await this.transition(backupSetId, currentStatus, 'FAILED', {
          failureCode: String(error?.code || 'BACKUP_EXECUTION_FAILED').slice(0, 80),
          failedAt: new Date(),
        }).catch(() => {});
      }
      throw error;
    }
  }
}

module.exports = {
  BACKUP_STATUS_TRANSITIONS,
  BackupWorker,
  assertBackupStatusTransition,
};
