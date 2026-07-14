'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeArtifact } = require('./artifactIntegrity');
const { BackupBundleBuilder } = require('./backupBundleBuilder');
const { backupError } = require('./backupErrors');
const { copyRegularTree, isInside, removeTemporaryTree, resolveInside, secureRemoveTemporaryTree, assertSafeBackupReference } = require('./fileTree');
const { LocalStorageAdapter } = require('./localStorageAdapter');
const { MySqlBackupService } = require('./mysqlBackupService');
const { ModuleCodeService } = require('./moduleCodeService');
const { RdsSnapshotAdapter } = require('./rdsSnapshotAdapter');
const { S3StorageAdapter } = require('./s3StorageAdapter');
const { compareIntegrityReports } = require('./databaseIntegrity');

const BACKUP_TYPES = new Set(['DATABASE', 'FILES', 'CONFIGURATION', 'MODULE_STATE', 'DEPLOYMENT_VERSION', 'FULL_BACKUP']);
const STORAGE_PROVIDERS = new Set(['LOCAL', 'S3', 'RDS_SNAPSHOT']);
const DATABASE_BACKUP_TYPES = new Set(['DATABASE', 'FULL_BACKUP']);

function normalizeEnum(value, allowed, fieldName) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!allowed.has(normalized)) throw backupError(`${fieldName} is invalid.`, 'INVALID_BACKUP_REQUEST');
  return normalized;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function parseModuleList(value) {
  const modules = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(modules.map(module => String(module || '').trim().toLowerCase()).filter(module => /^[a-z0-9_-]{1,80}$/.test(module)))];
}

function parseSourcePaths(value) {
  if (!String(value || '').trim()) return [];
  return String(value).split(/[;,]/).map(item => item.trim()).filter(Boolean).map(sourcePath => ({
    label: path.basename(sourcePath),
    path: sourcePath,
  }));
}

async function readJsonFile(filePath, maxBytes = 5 * 1024 * 1024) {
  const stat = await fs.promises.lstat(filePath).catch(error => {
    if (error.code === 'ENOENT') throw backupError('Backup component is missing.', 'INVALID_BACKUP_BUNDLE');
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw backupError('Backup component is invalid.', 'INVALID_BACKUP_BUNDLE');
  }
  try {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  } catch (error) {
    throw backupError('Backup component is unreadable.', 'INVALID_BACKUP_BUNDLE', { cause: error });
  }
}

function connectionFromEnvironment(environment, prefix, fallbackPrefix = null) {
  const get = key => {
    const primaryValue = environment[`${prefix}_${key}`];
    if (primaryValue !== undefined && primaryValue !== null && String(primaryValue).trim() !== '') return primaryValue;
    return fallbackPrefix ? environment[`${fallbackPrefix}_${key}`] : undefined;
  };
  return {
    host: get('HOST'),
    port: get('PORT') || 3306,
    user: get('USER'),
    password: get('PASSWORD'),
    database: get('NAME'),
    sslEnabled: parseBoolean(get('SSL'), parseBoolean(environment.DB_SSL)),
    sslCaPath: get('SSL_CA_PATH') || environment.DB_SSL_CA_PATH,
    sslCertPath: get('SSL_CERT_PATH') || environment.DB_SSL_CERT_PATH,
    sslKeyPath: get('SSL_KEY_PATH') || environment.DB_SSL_KEY_PATH,
    sslRejectUnauthorized: parseBoolean(get('SSL_REJECT_UNAUTHORIZED'), environment.DB_SSL_REJECT_UNAUTHORIZED !== 'false'),
    timezone: environment.DB_TIME_ZONE || '+08:00',
  };
}

function optionalConnectionFromEnvironment(environment, prefix) {
  const connection = connectionFromEnvironment(environment, prefix);
  return connection.host && connection.user && connection.password ? connection : null;
}

function rdsDrillInstanceIdentifier(drillReference) {
  const reference = assertSafeBackupReference(drillReference);
  const suffix = crypto.createHash('sha256').update(reference, 'utf8').digest('hex').slice(0, 20);
  return `lgsv-restore-drill-${suffix}`;
}

class BackupRuntime {
  constructor(options = {}) {
    this.adapters = new Map();
    for (const adapter of options.adapters || []) this.adapters.set(adapter.provider, adapter);
    this.mysqlBackupService = options.mysqlBackupService;
    this.bundleBuilder = options.bundleBuilder;
    this.workRoot = path.resolve(options.workRoot || path.join(os.tmpdir(), 'lgsv-hr-backup-runtime'));
    this.restoreOutputRoot = path.resolve(options.restoreOutputRoot || path.join(os.homedir(), '.lgsv-hr', 'restored-artifacts'));
    this.primaryConnection = options.primaryConnection || null;
    this.dryRunConnection = options.dryRunConnection || null;
    this.liveRestoreConnection = options.liveRestoreConnection || null;
    this.liveRestoreDatabaseName = String(options.liveRestoreDatabaseName || '').trim() || null;
    this.liveRestoreEnabled = Boolean(options.liveRestoreEnabled);
    this.allowInPlaceRestore = Boolean(options.allowInPlaceRestore);
    this.appVersion = String(options.appVersion || '1.0.0').slice(0, 80);
    this.deploymentCommit = String(options.deploymentCommit || 'local-dev').slice(0, 80);
    this.rdsRestoreOptions = options.rdsRestoreOptions || {};
    this.rdsVerificationConnection = options.rdsVerificationConnection || null;
    this.captureRowCounts = Boolean(options.captureRowCounts);
    this.moduleCodeService = options.moduleCodeService || null;
  }

  async initialize() {
    await fs.promises.mkdir(this.workRoot, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(this.workRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw backupError('Backup runtime workspace is unsafe.', 'UNSAFE_BACKUP_WORKSPACE');
    }
  }

  adapterFor(providerValue) {
    const provider = normalizeEnum(providerValue, STORAGE_PROVIDERS, 'Storage provider');
    const adapter = this.adapters.get(provider);
    if (!adapter) throw backupError(`${provider} backup storage is not configured.`, 'BACKUP_PROVIDER_NOT_CONFIGURED');
    return adapter;
  }

  async createBackup({ backupReference, backupType, storageProvider, includedModules = [] }) {
    await this.initialize();
    const reference = assertSafeBackupReference(backupReference);
    const type = normalizeEnum(backupType, BACKUP_TYPES, 'Backup type');
    const provider = normalizeEnum(storageProvider, STORAGE_PROVIDERS, 'Storage provider');
    const modules = parseModuleList(includedModules);
    const adapter = this.adapterFor(provider);

    if (provider === 'RDS_SNAPSHOT') {
      if (type !== 'DATABASE') {
        throw backupError('RDS snapshots can only satisfy DATABASE backup requests.', 'BACKUP_PROVIDER_TYPE_MISMATCH');
      }
      const stored = await adapter.createDatabaseSnapshot({ backupReference: reference });
      const verification = await adapter.verifyStoredArtifact(stored.location, stored.descriptor.checksum);
      if (!verification.valid) throw backupError('RDS snapshot failed integrity verification.', 'BACKUP_INTEGRITY_MISMATCH');
      const databaseIntegrity = await this.mysqlBackupService.captureDatabaseIntegrity({
        connection: this.primaryConnection,
        includeRowCounts: this.captureRowCounts,
      });
      return {
        backupReference: reference,
        backupType: type,
        storageProvider: provider,
        status: 'COMPLETED',
        storageLocation: stored.location,
        checksum: stored.descriptor.checksum,
        fileSize: null,
        fileCount: null,
        verified: true,
        idempotent: stored.idempotent,
        verification,
        integrityReport: { snapshot: stored.descriptor.snapshot, database: databaseIntegrity },
      };
    }

    if (typeof adapter.findStoredArtifact === 'function') {
      const existing = await adapter.findStoredArtifact(reference);
      if (existing) {
        const existingType = String(existing.metadata?.backupType || '').toUpperCase();
        const existingModules = parseModuleList(existing.metadata?.includedModules).sort();
        if (existingType !== type || JSON.stringify(existingModules) !== JSON.stringify([...modules].sort())) {
          throw backupError('Backup reference already belongs to a different backup request.', 'BACKUP_IDEMPOTENCY_CONFLICT');
        }
        return {
          backupReference: reference,
          backupType: type,
          storageProvider: provider,
          status: 'COMPLETED',
          storageLocation: existing.location,
          checksum: existing.descriptor.checksum,
          fileSize: existing.descriptor.sizeBytes,
          fileCount: existing.descriptor.fileCount,
          verified: true,
          idempotent: true,
          verification: existing.verification,
          integrityReport: null,
        };
      }
    }

    const jobDirectory = await fs.promises.mkdtemp(path.join(this.workRoot, '.backup-'));
    try {
      const bundlePath = path.join(jobDirectory, 'bundle');
      const build = await this.bundleBuilder.build({
        bundlePath,
        backupReference: reference,
        backupType: type,
        includedModules: modules,
        appVersion: this.appVersion,
        deploymentCommit: this.deploymentCommit,
      });
      const stored = await adapter.storeArtifact({
        artifactPath: bundlePath,
        backupReference: reference,
        metadata: { backupType: type, includedModules: modules, formatVersion: 1 },
      });
      const verification = await adapter.verifyStoredArtifact(stored.location, stored.descriptor.checksum);
      if (!verification.valid) throw backupError('Stored backup failed integrity verification.', 'BACKUP_INTEGRITY_MISMATCH');
      return {
        backupReference: reference,
        backupType: type,
        storageProvider: provider,
        status: 'COMPLETED',
        storageLocation: stored.location,
        checksum: stored.descriptor.checksum,
        fileSize: stored.descriptor.sizeBytes,
        fileCount: stored.descriptor.fileCount,
        verified: true,
        idempotent: stored.idempotent,
        verification,
        integrityReport: build.database?.expectedIntegrity || null,
      };
    } finally {
      if (isInside(this.workRoot, jobDirectory)) {
        await secureRemoveTemporaryTree(this.workRoot, jobDirectory).catch(() => {});
      }
    }
  }

  async verifyBackup({ storageProvider, storageLocation, expectedChecksum }) {
    return this.adapterFor(storageProvider).verifyStoredArtifact(storageLocation, expectedChecksum);
  }

  async deleteArtifact({ storageProvider, storageLocation, expectedChecksum }) {
    const adapter = this.adapterFor(storageProvider);
    if (typeof adapter.deleteArtifact !== 'function') {
      throw backupError(`${adapter.provider} backup deletion is not configured.`, 'BACKUP_RETENTION_DELETE_UNSUPPORTED');
    }
    return adapter.deleteArtifact({ location: storageLocation, expectedChecksum });
  }

  async validateBundle(artifactPath, expected = {}) {
    const stat = await fs.promises.lstat(artifactPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw backupError('LGSV backup bundle must be a directory artifact.', 'INVALID_BACKUP_BUNDLE');
    }
    const metadata = await readJsonFile(path.join(artifactPath, 'lgsv-backup.json'));
    if (
      metadata?.formatVersion !== 1 ||
      metadata?.backupReference !== expected.backupReference ||
      metadata?.backupType !== expected.backupType
    ) {
      throw backupError('LGSV backup bundle metadata does not match the restore request.', 'INVALID_BACKUP_BUNDLE');
    }
    return metadata;
  }

  async materialize({ storageProvider, storageLocation, expectedChecksum, workspace }) {
    const adapter = this.adapterFor(storageProvider);
    if (adapter.provider === 'RDS_SNAPSHOT') {
      throw backupError('RDS snapshots cannot be materialized as local files.', 'RDS_SNAPSHOT_MATERIALIZATION_UNSUPPORTED');
    }
    return adapter.materializeArtifact({
      location: storageLocation,
      expectedChecksum,
      destinationRoot: workspace,
    });
  }

  async runRestoreDryRun({
    backupReference,
    backupType,
    storageProvider,
    storageLocation,
    expectedChecksum,
    restoreConnection = this.dryRunConnection,
  }) {
    await this.initialize();
    const reference = assertSafeBackupReference(backupReference);
    const type = normalizeEnum(backupType, BACKUP_TYPES, 'Backup type');
    const provider = normalizeEnum(storageProvider, STORAGE_PROVIDERS, 'Storage provider');
    const adapter = this.adapterFor(provider);
    if (provider === 'RDS_SNAPSHOT') {
      if (type !== 'DATABASE') throw backupError('RDS snapshot backup type is invalid.', 'BACKUP_PROVIDER_TYPE_MISMATCH');
      const candidate = await adapter.validateRestoreCandidate({ location: storageLocation, expectedChecksum });
      return {
        safeToRestore: candidate.valid,
        artifactVerification: candidate.verification,
        databaseIntegrity: null,
        inventory: { kind: 'RDS_SNAPSHOT', snapshot: candidate.snapshot },
        checks: [
          { name: 'Snapshot checksum', status: candidate.valid ? 'PASS' : 'FAIL', message: 'RDS snapshot metadata integrity checked.' },
          { name: 'Restore isolation', status: 'PASS', message: 'Restore is restricted to a new RDS instance.' },
        ],
      };
    }

    const jobDirectory = await fs.promises.mkdtemp(path.join(this.workRoot, '.dry-restore-'));
    try {
      const materialized = await this.materialize({
        storageProvider: provider,
        storageLocation,
        expectedChecksum,
        workspace: path.join(jobDirectory, 'materialized'),
      });
      const metadata = await this.validateBundle(materialized.artifactPath, { backupReference: reference, backupType: type });
      const checks = [
        { name: 'Artifact checksum', status: 'PASS', message: 'Stored artifact bytes match the server-generated SHA-256 checksum.' },
        { name: 'Bundle metadata', status: 'PASS', message: 'Backup reference and type match the restore request.' },
      ];
      let databaseIntegrity = null;
      let safeToRestore = true;
      let sourceCodeValidation = null;
      if (DATABASE_BACKUP_TYPES.has(type)) {
        if (!restoreConnection) {
          safeToRestore = false;
          checks.push({ name: 'Isolated database restore', status: 'BLOCKED', message: 'A dedicated restore-test database connection is not configured.' });
        } else {
          const dumpPath = path.join(materialized.artifactPath, 'database', 'database.sql');
          const integrityPath = path.join(materialized.artifactPath, 'database', 'integrity.json');
          const expectedIntegrity = await fs.promises.access(integrityPath).then(() => readJsonFile(integrityPath)).catch(() => null);
          databaseIntegrity = await this.mysqlBackupService.runDryRestore({ dumpPath, restoreConnection, expectedIntegrity });
          safeToRestore = databaseIntegrity.safeToRestore;
          checks.push({
            name: 'Isolated database restore',
            status: safeToRestore ? 'PASS' : 'FAIL',
            message: safeToRestore ? 'Dump restored and passed post-restore integrity checks in a disposable database.' : 'Disposable restore did not match the expected integrity report.',
          });
        }
      }
      if (metadata?.components?.sourceCode) {
        if (!this.moduleCodeService) {
          safeToRestore = false;
          checks.push({ name: 'Module source validation', status: 'BLOCKED', message: 'Module source-code validation is not configured.' });
        } else {
          sourceCodeValidation = await this.moduleCodeService.validateComponent(path.join(materialized.artifactPath, 'source-code'));
          checks.push({
            name: 'Module source validation',
            status: sourceCodeValidation.valid ? 'PASS' : 'FAIL',
            message: sourceCodeValidation.valid
              ? `${sourceCodeValidation.fileCount} allowlisted source file(s) passed checksum and syntax validation.`
              : 'Recovered module source did not pass validation.',
          });
          safeToRestore = safeToRestore && sourceCodeValidation.valid;
        }
      }
      return {
        safeToRestore,
        artifactVerification: materialized.verification,
        databaseIntegrity,
        sourceCodeValidation: sourceCodeValidation ? {
          valid: sourceCodeValidation.valid,
          fileCount: sourceCodeValidation.fileCount,
          sizeBytes: sourceCodeValidation.sizeBytes,
        } : null,
        inventory: {
          kind: materialized.descriptor.kind,
          fileCount: materialized.descriptor.fileCount,
          sizeBytes: materialized.descriptor.sizeBytes,
          components: metadata.components,
        },
        checks,
      };
    } finally {
      if (isInside(this.workRoot, jobDirectory)) await secureRemoveTemporaryTree(this.workRoot, jobDirectory).catch(() => {});
    }
  }

  async stageRecoveredComponents({ artifactPath, backupReference, backupType }) {
    await fs.promises.mkdir(this.restoreOutputRoot, { recursive: true, mode: 0o700 });
    const rootStat = await fs.promises.lstat(this.restoreOutputRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw backupError('Restore output root is unsafe.', 'UNSAFE_RESTORE_WORKSPACE');
    const finalDirectory = resolveInside(this.restoreOutputRoot, backupReference);
    const staging = await fs.promises.mkdtemp(path.join(this.restoreOutputRoot, '.restore-'));
    try {
      const components = [];
      const componentNames = backupType === 'FULL_BACKUP'
        ? ['files', 'configuration', 'module-state', 'source-code']
        : backupType === 'FILES'
          ? ['files']
          : backupType === 'CONFIGURATION'
            ? ['configuration']
            : backupType === 'DEPLOYMENT_VERSION'
              ? ['module-state', 'source-code']
              : ['module-state'];
      for (const component of componentNames) {
        const source = path.join(artifactPath, component);
        const exists = await fs.promises.lstat(source).then(stat => stat.isDirectory() && !stat.isSymbolicLink()).catch(() => false);
        if (!exists) continue;
        await copyRegularTree(source, path.join(staging, component));
        components.push(component);
      }
      await copyRegularTree(path.join(artifactPath, 'lgsv-backup.json'), path.join(staging, 'lgsv-backup.json'));
      const sourceDescriptor = await describeArtifact(staging);
      const existing = await fs.promises.lstat(finalDirectory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
        throw backupError('Existing restore output is unsafe.', 'UNSAFE_RESTORE_WORKSPACE');
      }
      if (!existing) {
        try {
          await fs.promises.rename(staging, finalDirectory);
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
        }
      }
      const destinationDescriptor = await describeArtifact(finalDirectory);
      const integrityPassed = sourceDescriptor.checksum === destinationDescriptor.checksum;
      if (!integrityPassed) {
        throw backupError('Existing restore output differs from the verified recovery artifact.', 'RESTORE_IDEMPOTENCY_CONFLICT');
      }
      return {
        recoveryOutputLocation: finalDirectory,
        components,
        requiresCutover: true,
        integrityPassed,
        descriptor: destinationDescriptor,
        idempotent: Boolean(existing),
      };
    } finally {
      if (isInside(this.restoreOutputRoot, staging)) await removeTemporaryTree(this.restoreOutputRoot, staging).catch(() => {});
    }
  }

  async applyRestore({
    backupReference,
    backupType,
    storageProvider,
    storageLocation,
    expectedChecksum,
    newRdsInstanceIdentifier,
    affectedModule,
    rollback = false,
  }) {
    await this.initialize();
    const reference = assertSafeBackupReference(backupReference);
    const type = normalizeEnum(backupType, BACKUP_TYPES, 'Backup type');
    const provider = normalizeEnum(storageProvider, STORAGE_PROVIDERS, 'Storage provider');
    const codeRollback = Boolean(rollback && ['DEPLOYMENT_VERSION', 'FULL_BACKUP'].includes(type));
    if (rollback && !codeRollback) {
      throw backupError('Module rollback requires a deployment-version or full backup artifact.', 'MODULE_CODE_ARTIFACT_REQUIRED');
    }
    if (!codeRollback && !this.liveRestoreEnabled) {
      throw backupError('Live restore execution is disabled by server configuration.', 'LIVE_RESTORE_DISABLED');
    }
    const adapter = this.adapterFor(provider);
    if (provider === 'RDS_SNAPSHOT') {
      if (!newRdsInstanceIdentifier) throw backupError('A new RDS instance identifier is required.', 'RDS_RESTORE_CONFIG_MISSING');
      const initiated = await adapter.restoreToNewInstance({
        location: storageLocation,
        expectedChecksum,
        newDbInstanceIdentifier: newRdsInstanceIdentifier,
        ...this.rdsRestoreOptions,
      });
      return {
        ...initiated,
        restored: false,
        integrityPassed: false,
        integrityReport: null,
        restoredChecksum: null,
        verified: true,
        pendingVerification: true,
      };
    }

    const jobDirectory = await fs.promises.mkdtemp(path.join(this.workRoot, '.live-restore-'));
    try {
      const materialized = await this.materialize({
        storageProvider: provider,
        storageLocation,
        expectedChecksum,
        workspace: path.join(jobDirectory, 'materialized'),
      });
      const metadata = await this.validateBundle(materialized.artifactPath, { backupReference: reference, backupType: type });
      if (codeRollback) {
        if (provider === 'RDS_SNAPSHOT') throw backupError('RDS snapshots cannot contain module source code.', 'MODULE_CODE_ARTIFACT_REQUIRED');
        if (!metadata?.components?.sourceCode || !this.moduleCodeService) {
          throw backupError('Verified module source code is missing from this recovery artifact.', 'MODULE_CODE_ARTIFACT_REQUIRED');
        }
        const codeCutover = await this.moduleCodeService.applyModuleRollback({
          componentPath: path.join(materialized.artifactPath, 'source-code'),
          affectedModule,
          backupReference: reference,
        });
        return {
          restored: Boolean(codeCutover.cutoverApplied && codeCutover.integrityPassed),
          backupReference: reference,
          backupType: type,
          artifactVerification: materialized.verification,
          databaseRestore: null,
          recoveredComponents: { sourceCode: codeCutover, requiresCutover: false },
          integrityPassed: Boolean(codeCutover.integrityPassed),
          integrityReport: {
            artifactChecksum: expectedChecksum,
            artifactVerified: Boolean(materialized.verification?.valid),
            sourceCode: codeCutover,
          },
          restoredChecksum: codeCutover.integrityPassed ? expectedChecksum : null,
          verified: Boolean(materialized.verification?.valid && codeCutover.verified),
          pendingVerification: false,
          restartRequired: Boolean(codeCutover.restartRequired),
        };
      }
      let databaseRestore = null;
      if (DATABASE_BACKUP_TYPES.has(type)) {
        if (!this.dryRunConnection || !this.liveRestoreConnection || !this.liveRestoreDatabaseName) {
          throw backupError('Controlled database restore connections and target name must be configured.', 'LIVE_RESTORE_CONFIG_MISSING');
        }
        const dumpPath = path.join(materialized.artifactPath, 'database', 'database.sql');
        const integrityPath = path.join(materialized.artifactPath, 'database', 'integrity.json');
        const expectedIntegrity = await fs.promises.access(integrityPath).then(() => readJsonFile(integrityPath)).catch(() => null);
        const dryRun = await this.mysqlBackupService.runDryRestore({
          dumpPath,
          restoreConnection: this.dryRunConnection,
          expectedIntegrity,
        });
        if (!dryRun.safeToRestore) {
          throw backupError('Live restore was blocked because the isolated dry-run failed.', 'RESTORE_DRY_RUN_FAILED');
        }
        databaseRestore = await this.mysqlBackupService.applyDatabaseRestore({
          dumpPath,
          targetConnection: this.liveRestoreConnection,
          targetDatabaseName: this.liveRestoreDatabaseName,
          sourceDatabaseName: this.primaryConnection?.database,
          expectedIntegrity,
          allowInPlace: this.allowInPlaceRestore,
        });
        if (!databaseRestore.restored) {
          throw backupError('Database restore completed with an integrity mismatch.', 'RESTORE_INTEGRITY_MISMATCH');
        }
      }
      const recoveredComponents = type === 'DATABASE'
        ? null
        : await this.stageRecoveredComponents({ artifactPath: materialized.artifactPath, backupReference: reference, backupType: type });
      const integrityPassed = Boolean(
        (databaseRestore ? databaseRestore.comparison?.valid : true) &&
        (recoveredComponents ? recoveredComponents.integrityPassed : true)
      );
      const targetIntegrity = databaseRestore && recoveredComponents
        ? {
            database: databaseRestore.actualIntegrity || null,
            recoveredComponents: recoveredComponents.descriptor || null,
          }
        : databaseRestore?.actualIntegrity || recoveredComponents?.descriptor || null;
      const integrityReport = {
        artifactChecksum: expectedChecksum,
        artifactVerified: Boolean(materialized.verification?.valid),
        targetIntegrity,
      };
      return {
        restored: Boolean(databaseRestore?.restored || recoveredComponents) && integrityPassed,
        backupReference: reference,
        backupType: type,
        artifactVerification: materialized.verification,
        databaseRestore,
        recoveredComponents,
        integrityPassed,
        integrityReport,
        // Completion evidence records the exact verified source artifact that
        // was applied. Target-specific hashes remain in integrityReport.
        restoredChecksum: integrityPassed ? expectedChecksum : null,
        verified: Boolean(materialized.verification?.valid),
        pendingVerification: false,
      };
    } finally {
      if (isInside(this.workRoot, jobDirectory)) await secureRemoveTemporaryTree(this.workRoot, jobDirectory).catch(() => {});
    }
  }

  async verifyPendingRestore({
    backupType,
    storageProvider,
    storageLocation,
    expectedChecksum,
    restoreTarget,
    expectedIntegrity,
  }) {
    const type = normalizeEnum(backupType, BACKUP_TYPES, 'Backup type');
    const provider = normalizeEnum(storageProvider, STORAGE_PROVIDERS, 'Storage provider');
    if (provider !== 'RDS_SNAPSHOT' || type !== 'DATABASE') {
      throw backupError('Only pending RDS database restores use target verification.', 'RESTORE_TARGET_VERIFICATION_UNSUPPORTED');
    }
    const adapter = this.adapterFor(provider);
    const infrastructure = await adapter.verifyRestoredInstance({
      location: storageLocation,
      expectedChecksum,
      newDbInstanceIdentifier: restoreTarget,
    });
    if (infrastructure.pending) {
      return { pendingVerification: true, integrityPassed: false, infrastructure };
    }
    if (!infrastructure.valid) {
      return { pendingVerification: false, integrityPassed: false, infrastructure };
    }
    const expectedDatabaseIntegrity = expectedIntegrity?.database || null;
    if (!expectedDatabaseIntegrity || !this.rdsVerificationConnection) {
      throw backupError('RDS post-restore database verification credentials are not configured.', 'RDS_RESTORE_VERIFY_CONFIG_MISSING');
    }
    const connection = {
      ...this.rdsVerificationConnection,
      host: infrastructure.endpoint,
      port: infrastructure.port,
      database: this.rdsVerificationConnection.database || expectedDatabaseIntegrity.databaseName,
    };
    const actualDatabaseIntegrity = await this.mysqlBackupService.captureDatabaseIntegrity({
      connection,
      includeRowCounts: Boolean(expectedDatabaseIntegrity.rowCounts),
    });
    const comparison = compareIntegrityReports(expectedDatabaseIntegrity, actualDatabaseIntegrity);
    return {
      pendingVerification: false,
      integrityPassed: Boolean(comparison.valid),
      restoredChecksum: comparison.valid ? expectedChecksum : null,
      infrastructure,
      integrityReport: {
        artifactChecksum: expectedChecksum,
        infrastructure,
        expectedDatabaseIntegrity,
        actualDatabaseIntegrity,
        comparison,
      },
    };
  }

  async runRdsRestoreDrill({
    backupReference,
    storageLocation,
    expectedChecksum,
    expectedIntegrity,
    drillReference,
  }) {
    const reference = assertSafeBackupReference(backupReference);
    const safeDrillReference = assertSafeBackupReference(drillReference);
    const adapter = this.adapterFor('RDS_SNAPSHOT');
    const expectedDatabaseIntegrity = expectedIntegrity?.database || expectedIntegrity?.integrityReport?.database || null;
    if (!expectedDatabaseIntegrity) {
      throw backupError('RDS backup has no source database integrity evidence.', 'RDS_DRILL_INTEGRITY_METADATA_MISSING');
    }
    if (
      !this.rdsVerificationConnection?.user ||
      !this.rdsVerificationConnection?.password ||
      !this.rdsVerificationConnection?.database ||
      this.rdsVerificationConnection?.sslEnabled !== true
    ) {
      throw backupError('RDS restore-drill verification credentials are incomplete.', 'RDS_RESTORE_VERIFY_CONFIG_MISSING');
    }
    if (
      expectedDatabaseIntegrity.databaseName &&
      this.rdsVerificationConnection.database !== expectedDatabaseIntegrity.databaseName
    ) {
      throw backupError('RDS restore-drill verification database does not match the backup evidence.', 'RDS_VERIFY_DATABASE_MISMATCH');
    }
    if (
      !this.rdsRestoreOptions.dbInstanceClass ||
      !this.rdsRestoreOptions.dbSubnetGroupName ||
      !Array.isArray(this.rdsRestoreOptions.vpcSecurityGroupIds) ||
      !this.rdsRestoreOptions.vpcSecurityGroupIds.length ||
      this.rdsRestoreOptions.waitForAvailable !== true
    ) {
      throw backupError('Isolated RDS restore-drill infrastructure is not fully configured.', 'RDS_DRILL_CONFIG_MISSING');
    }

    const target = rdsDrillInstanceIdentifier(safeDrillReference);
    let primaryError = null;
    let report = null;
    let cleanup = null;
    let restoreAttempted = false;
    try {
      // A deterministic target makes a crashed drill recoverable. Any orphan
      // must pass snapshot and ownership-tag checks before it can be removed.
      await adapter.deleteRestoreDrillInstance({
        location: storageLocation,
        newDbInstanceIdentifier: target,
        drillReference: safeDrillReference,
        waitForDeleted: true,
      });
      restoreAttempted = true;
      const initiated = await adapter.restoreToNewInstance({
        location: storageLocation,
        expectedChecksum,
        newDbInstanceIdentifier: target,
        ...this.rdsRestoreOptions,
        publiclyAccessible: false,
        waitForAvailable: true,
        recoveryPurpose: 'ScheduledRestoreDrill',
        drillReference: safeDrillReference,
      });
      const verification = await this.verifyPendingRestore({
        backupType: 'DATABASE',
        storageProvider: 'RDS_SNAPSHOT',
        storageLocation,
        expectedChecksum,
        restoreTarget: target,
        expectedIntegrity: { database: expectedDatabaseIntegrity },
      });
      if (verification.pendingVerification || !verification.integrityPassed) {
        throw backupError('Disposable RDS restore did not pass post-restore integrity checks.', 'RDS_DRILL_INTEGRITY_FAILED');
      }
      report = {
        safeToRestore: true,
        backupReference: reference,
        targetInstanceIdentifier: target,
        initiated,
        infrastructure: verification.infrastructure,
        integrityReport: verification.integrityReport,
        liveRestoreApplied: false,
        disposableRestore: true,
      };
    } catch (error) {
      primaryError = error;
    }

    if (restoreAttempted) {
      try {
        cleanup = await adapter.deleteRestoreDrillInstance({
          location: storageLocation,
          newDbInstanceIdentifier: target,
          drillReference: safeDrillReference,
          waitForDeleted: true,
        });
      } catch (error) {
        throw backupError(
          'Disposable RDS restore-drill cleanup failed. Immediate administrator review is required.',
          'RDS_DRILL_CLEANUP_FAILED',
          { cause: error, retryable: true, details: { priorErrorCode: primaryError?.code || null } }
        );
      }
    }
    if (restoreAttempted && cleanup?.deleted !== true) {
      throw backupError(
        'Disposable RDS restore-drill cleanup did not confirm deletion.',
        'RDS_DRILL_CLEANUP_FAILED',
        { retryable: true, details: { priorErrorCode: primaryError?.code || null } }
      );
    }
    if (primaryError) throw primaryError;
    return {
      ...report,
      cleanup,
      disposableInstanceDeleted: cleanup?.deleted === true,
    };
  }
}

function createBackupRuntimeFromEnv(options = {}) {
  const environment = options.environment || process.env;
  const nodeEnv = String(environment.NODE_ENV || 'development').toLowerCase();
  const primaryConnection = options.primaryConnection || connectionFromEnvironment(environment, 'BACKUP_SOURCE_DB', 'DB');
  const dryRunConnection = options.dryRunConnection || optionalConnectionFromEnvironment(environment, 'BACKUP_DRY_RUN_DB');
  const liveRestoreConnection = options.liveRestoreConnection || optionalConnectionFromEnvironment(environment, 'BACKUP_RESTORE_DB');
  const rdsVerificationCandidate = connectionFromEnvironment(environment, 'BACKUP_RDS_VERIFY_DB');
  const rdsVerificationConnection = options.rdsVerificationConnection || (
    rdsVerificationCandidate.user && rdsVerificationCandidate.password && rdsVerificationCandidate.database
      ? rdsVerificationCandidate
      : null
  );
  const workRoot = environment.BACKUP_WORK_ROOT || path.join(os.tmpdir(), 'lgsv-hr-backup-runtime');
  const moduleCodeService = options.moduleCodeService || new ModuleCodeService({
    sourceRoot: environment.BACKUP_CODE_SOURCE_ROOT || process.cwd(),
    activeRoot: environment.BACKUP_CODE_ACTIVE_ROOT || environment.BACKUP_CODE_SOURCE_ROOT || process.cwd(),
    transactionRoot: environment.BACKUP_CODE_TRANSACTION_ROOT,
    moduleSourceMap: options.moduleSourceMap,
    maxFiles: environment.BACKUP_CODE_MAX_FILES || environment.BACKUP_MAX_FILES,
    maxBytes: environment.BACKUP_CODE_MAX_BYTES || environment.BACKUP_MAX_BYTES,
    // Local development is immediately usable; production must opt in after
    // pointing BACKUP_CODE_ACTIVE_ROOT at its managed release source tree.
    cutoverEnabled: parseBoolean(environment.BACKUP_CODE_CUTOVER_ENABLED, nodeEnv !== 'production'),
  });
  const mysqlBackupService = options.mysqlBackupService || new MySqlBackupService({
    mysqldumpPath: environment.MYSQLDUMP_PATH || 'mysqldump',
    mysqlPath: environment.MYSQL_PATH || 'mysql',
    workRoot: environment.BACKUP_TOOL_WORK_ROOT || path.join(os.tmpdir(), 'lgsv-hr-backup-tools'),
    toolTimeoutMs: environment.BACKUP_TOOL_TIMEOUT_MS,
    maxDumpBytes: environment.BACKUP_MAX_DUMP_BYTES,
    nodeEnv,
    primaryConnection,
    allowSameServerDryRun: parseBoolean(environment.BACKUP_ALLOW_SAME_SERVER_DRY_RUN),
    includeRoutines: parseBoolean(environment.BACKUP_INCLUDE_ROUTINES),
    includeEvents: parseBoolean(environment.BACKUP_INCLUDE_EVENTS),
    captureSourceIntegrity: parseBoolean(environment.BACKUP_CAPTURE_INTEGRITY, true),
  });
  const fileSources = options.fileSources || parseSourcePaths(environment.BACKUP_FILE_SOURCE_PATHS);
  if (!fileSources.length) {
    fileSources.push({ label: 'secure-uploads', path: environment.SECURE_UPLOAD_ROOT || path.join(process.cwd(), 'secure_uploads') });
  }
  const configurationSources = options.configurationSources || parseSourcePaths(environment.BACKUP_CONFIG_SOURCE_PATHS);
  if (!configurationSources.length) {
    for (const name of ['package.json', 'database.json']) {
      const sourcePath = path.join(process.cwd(), name);
      if (fs.existsSync(sourcePath)) configurationSources.push({ label: name, path: sourcePath });
    }
  }
  const bundleBuilder = options.bundleBuilder || new BackupBundleBuilder({
    mysqlBackupService,
    primaryConnection,
    integrityExecutor: options.integrityExecutor || null,
    fileSources,
    configurationSources,
    moduleStateProvider: options.moduleStateProvider,
    includeRowCounts: parseBoolean(environment.BACKUP_CAPTURE_ROW_COUNTS),
    maxFiles: environment.BACKUP_MAX_FILES,
    maxBytes: environment.BACKUP_MAX_BYTES,
    environment,
    moduleCodeService,
  });

  const adapters = [...(options.adapters || [])];
  if (!adapters.some(adapter => adapter.provider === 'LOCAL') && (nodeEnv !== 'production' || environment.BACKUP_LOCAL_ROOT)) {
    adapters.push(new LocalStorageAdapter({
      rootPath: environment.BACKUP_LOCAL_ROOT,
      encryptionKey: environment.BACKUP_ENCRYPTION_KEY || environment.AES_ENCRYPTION_KEY || environment.AES_256_SECRET_KEY,
      maxFiles: environment.BACKUP_MAX_FILES,
      maxBytes: environment.BACKUP_MAX_BYTES,
    }));
  }
  const region = environment.AWS_REGION || environment.AWS_DEFAULT_REGION;
  if (!adapters.some(adapter => adapter.provider === 'S3') && environment.AWS_S3_BUCKET) {
    adapters.push(new S3StorageAdapter({
      bucket: environment.AWS_S3_BUCKET,
      prefix: environment.AWS_S3_BACKUP_PREFIX || 'lgsv-hr/backups',
      region,
      kmsKeyId: environment.AWS_S3_KMS_KEY_ID,
    }));
  }
  if (!adapters.some(adapter => adapter.provider === 'RDS_SNAPSHOT') && environment.AWS_RDS_DB_INSTANCE_IDENTIFIER && region) {
    adapters.push(new RdsSnapshotAdapter({
      region,
      dbInstanceIdentifier: environment.AWS_RDS_DB_INSTANCE_IDENTIFIER,
      maxWaitSeconds: environment.AWS_RDS_SNAPSHOT_WAIT_SECONDS,
      requireEncrypted: true,
      allowDeleteSnapshots: parseBoolean(environment.AWS_RDS_ALLOW_RETENTION_DELETE),
    }));
  }

  return new BackupRuntime({
    adapters,
    mysqlBackupService,
    bundleBuilder,
    workRoot,
    restoreOutputRoot: environment.BACKUP_RESTORE_OUTPUT_ROOT,
    primaryConnection,
    dryRunConnection,
    liveRestoreConnection,
    liveRestoreDatabaseName: environment.BACKUP_RESTORE_DB_NAME,
    liveRestoreEnabled: parseBoolean(environment.BACKUP_LIVE_RESTORE_ENABLED),
    allowInPlaceRestore: parseBoolean(environment.BACKUP_ALLOW_IN_PLACE_RESTORE),
    appVersion: environment.APP_VERSION || options.appVersion,
    deploymentCommit: environment.APP_COMMIT_SHA || environment.GIT_COMMIT || options.deploymentCommit,
    rdsRestoreOptions: {
      dbInstanceClass: environment.AWS_RDS_RESTORE_INSTANCE_CLASS,
      dbSubnetGroupName: environment.AWS_RDS_RESTORE_SUBNET_GROUP,
      vpcSecurityGroupIds: String(environment.AWS_RDS_RESTORE_SECURITY_GROUP_IDS || '').split(',').map(value => value.trim()).filter(Boolean),
      publiclyAccessible: false,
      waitForAvailable: parseBoolean(environment.AWS_RDS_RESTORE_WAIT_FOR_AVAILABLE),
    },
    rdsVerificationConnection,
    captureRowCounts: parseBoolean(environment.BACKUP_CAPTURE_ROW_COUNTS),
    moduleCodeService,
  });
}

module.exports = {
  BACKUP_TYPES,
  BackupRuntime,
  STORAGE_PROVIDERS,
  connectionFromEnvironment,
  createBackupRuntimeFromEnv,
  optionalConnectionFromEnvironment,
  parseBoolean,
  parseModuleList,
  rdsDrillInstanceIdentifier,
};
