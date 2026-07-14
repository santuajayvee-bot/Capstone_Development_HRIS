'use strict';

const { describeArtifact, sha256File, verifyArtifact } = require('./artifactIntegrity');
const { BackupBundleBuilder } = require('./backupBundleBuilder');
const { BackupRuntime, createBackupRuntimeFromEnv, rdsDrillInstanceIdentifier } = require('./backupRuntime');
const { BackupWorker, BACKUP_STATUS_TRANSITIONS, assertBackupStatusTransition } = require('./backupWorker');
const { BackupRuntimeError } = require('./backupErrors');
const { compareIntegrityReports, createDatabaseIntegrityReport } = require('./databaseIntegrity');
const { LocalStorageAdapter } = require('./localStorageAdapter');
const { MySqlBackupService, validateDumpSafety } = require('./mysqlBackupService');
const { DEFAULT_MODULE_SOURCE_MAP, ModuleCodeService } = require('./moduleCodeService');
const { RdsSnapshotAdapter } = require('./rdsSnapshotAdapter');
const { S3StorageAdapter } = require('./s3StorageAdapter');
const {
  BackupAutomationRepository,
  BackupAutomationService,
  computeNextRunAt,
  createBackupAutomationService,
  providerReadinessFromEnv,
} = require('./backupAutomationService');

module.exports = {
  BACKUP_STATUS_TRANSITIONS,
  BackupBundleBuilder,
  BackupAutomationRepository,
  BackupAutomationService,
  BackupRuntime,
  BackupRuntimeError,
  BackupWorker,
  DEFAULT_MODULE_SOURCE_MAP,
  LocalStorageAdapter,
  MySqlBackupService,
  ModuleCodeService,
  RdsSnapshotAdapter,
  S3StorageAdapter,
  assertBackupStatusTransition,
  compareIntegrityReports,
  createBackupRuntimeFromEnv,
  createBackupAutomationService,
  createDatabaseIntegrityReport,
  describeArtifact,
  sha256File,
  validateDumpSafety,
  verifyArtifact,
  computeNextRunAt,
  providerReadinessFromEnv,
  rdsDrillInstanceIdentifier,
};
