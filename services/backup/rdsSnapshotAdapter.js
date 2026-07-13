'use strict';

const {
  CreateDBSnapshotCommand,
  DescribeDBInstancesCommand,
  DescribeDBSnapshotsCommand,
  RDSClient,
  RestoreDBInstanceFromDBSnapshotCommand,
  waitUntilDBInstanceAvailable,
  waitUntilDBSnapshotAvailable,
} = require('@aws-sdk/client-rds');
const crypto = require('crypto');
const { sha256Text, validateExpectedChecksum } = require('./artifactIntegrity');
const { backupError } = require('./backupErrors');
const { assertSafeBackupReference } = require('./fileTree');

function validateRdsIdentifier(value, fieldName = 'RDS identifier') {
  const identifier = String(value || '').trim().toLowerCase();
  if (
    !/^[a-z][a-z0-9-]{0,62}$/.test(identifier) ||
    identifier.endsWith('-') ||
    identifier.includes('--')
  ) {
    throw backupError(`${fieldName} is invalid.`, 'INVALID_RDS_IDENTIFIER');
  }
  return identifier;
}

function snapshotIdentifierFromReference(reference) {
  const safeReference = assertSafeBackupReference(reference);
  const normalized = safeReference.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = /^[a-z]/.test(normalized) ? normalized : `b-${normalized}`;
  const suffix = crypto.createHash('sha256').update(safeReference, 'utf8').digest('hex').slice(0, 8);
  return validateRdsIdentifier(`lgsv-${base.slice(0, 48).replace(/-+$/g, '')}-${suffix}`, 'RDS snapshot identifier');
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function snapshotIntegrityFields(snapshot) {
  return {
    snapshotIdentifier: snapshot?.DBSnapshotIdentifier || null,
    snapshotArn: snapshot?.DBSnapshotArn || null,
    sourceInstanceIdentifier: snapshot?.DBInstanceIdentifier || null,
    snapshotCreateTime: isoDate(snapshot?.SnapshotCreateTime),
    engine: snapshot?.Engine || null,
    engineVersion: snapshot?.EngineVersion || null,
    port: Number(snapshot?.Port || 0),
    encrypted: Boolean(snapshot?.Encrypted),
    kmsKeyId: snapshot?.KmsKeyId || null,
    vpcId: snapshot?.VpcId || null,
    storageType: snapshot?.StorageType || null,
    allocatedStorage: Number(snapshot?.AllocatedStorage || 0),
  };
}

function describeSnapshotArtifact(snapshot) {
  const integrityFields = snapshotIntegrityFields(snapshot);
  return {
    kind: 'RDS_SNAPSHOT',
    checksumAlgorithm: 'SHA-256',
    checksumScope: 'RDS_SNAPSHOT_METADATA',
    checksum: sha256Text(JSON.stringify(integrityFields)),
    sizeBytes: null,
    fileCount: null,
    entries: null,
    snapshot: {
      ...integrityFields,
      status: snapshot?.Status || null,
      percentProgress: Number(snapshot?.PercentProgress || 0),
    },
  };
}

function rdsLocation(region, snapshotIdentifier) {
  const safeRegion = String(region || '').trim();
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(safeRegion)) {
    throw backupError('AWS region is invalid for the RDS snapshot location.', 'INVALID_AWS_REGION');
  }
  return `rds-snapshot://${safeRegion}/${validateRdsIdentifier(snapshotIdentifier, 'RDS snapshot identifier')}`;
}

class RdsSnapshotAdapter {
  constructor(options = {}) {
    this.provider = 'RDS_SNAPSHOT';
    this.region = String(options.region || '').trim();
    if (!this.region) throw backupError('AWS region is required for RDS snapshots.', 'RDS_CONFIG_MISSING');
    this.dbInstanceIdentifier = validateRdsIdentifier(options.dbInstanceIdentifier, 'RDS DB instance identifier');
    this.client = options.client || new RDSClient({ region: this.region });
    this.snapshotWaiter = options.snapshotWaiter || waitUntilDBSnapshotAvailable;
    this.instanceWaiter = options.instanceWaiter || waitUntilDBInstanceAvailable;
    this.maxWaitSeconds = Math.max(60, Number(options.maxWaitSeconds || 1800));
    this.requireEncrypted = options.requireEncrypted !== false;
  }

  parseLocation(location) {
    let parsed;
    try {
      parsed = new URL(String(location || ''));
    } catch (_) {
      throw backupError('RDS snapshot location is invalid.', 'INVALID_BACKUP_LOCATION');
    }
    if (parsed.protocol !== 'rds-snapshot:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw backupError('RDS snapshot location is invalid.', 'INVALID_BACKUP_LOCATION');
    }
    if (parsed.hostname !== this.region) {
      throw backupError('RDS snapshot location uses an unexpected region.', 'INVALID_BACKUP_LOCATION');
    }
    const identifier = validateRdsIdentifier(parsed.pathname.replace(/^\/+/, ''), 'RDS snapshot identifier');
    return { snapshotIdentifier: identifier };
  }

  async describeSnapshot(snapshotIdentifier) {
    let response;
    try {
      response = await this.client.send(new DescribeDBSnapshotsCommand({
        DBSnapshotIdentifier: validateRdsIdentifier(snapshotIdentifier, 'RDS snapshot identifier'),
        SnapshotType: 'manual',
      }));
    } catch (error) {
      if (['DBSnapshotNotFound', 'DBSnapshotNotFoundFault'].includes(error?.name) || Number(error?.$metadata?.httpStatusCode) === 404) {
        throw backupError('RDS snapshot was not found.', 'BACKUP_ARTIFACT_MISSING');
      }
      throw error;
    }
    const snapshot = response?.DBSnapshots?.[0];
    if (!snapshot) throw backupError('RDS snapshot was not found.', 'BACKUP_ARTIFACT_MISSING');
    return snapshot;
  }

  async findSnapshot(snapshotIdentifier) {
    try {
      return await this.describeSnapshot(snapshotIdentifier);
    } catch (error) {
      if (error?.code === 'BACKUP_ARTIFACT_MISSING') return null;
      throw error;
    }
  }

  async describeInstance(instanceIdentifier) {
    const identifier = validateRdsIdentifier(instanceIdentifier, 'RDS restore target identifier');
    try {
      const response = await this.client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }));
      const instance = response?.DBInstances?.[0];
      if (!instance) throw backupError('Restored RDS instance was not found.', 'RDS_RESTORE_TARGET_MISSING', { retryable: true });
      return instance;
    } catch (error) {
      if (['DBInstanceNotFound', 'DBInstanceNotFoundFault'].includes(error?.name) || Number(error?.$metadata?.httpStatusCode) === 404) {
        throw backupError('Restored RDS instance was not found.', 'RDS_RESTORE_TARGET_MISSING', { retryable: true });
      }
      throw error;
    }
  }

  validateSnapshot(snapshot) {
    if (snapshot.DBInstanceIdentifier !== this.dbInstanceIdentifier) {
      throw backupError('RDS snapshot belongs to an unexpected source instance.', 'RDS_SNAPSHOT_SOURCE_MISMATCH');
    }
    if (this.requireEncrypted && !snapshot.Encrypted) {
      throw backupError('RDS snapshots must be encrypted at rest.', 'RDS_SNAPSHOT_NOT_ENCRYPTED');
    }
    if (snapshot.Status !== 'available') {
      throw backupError('RDS snapshot is not available for recovery.', 'RDS_SNAPSHOT_NOT_AVAILABLE', { retryable: true });
    }
  }

  async createDatabaseSnapshot({ backupReference }) {
    const reference = assertSafeBackupReference(backupReference);
    const snapshotIdentifier = snapshotIdentifierFromReference(reference);
    let snapshot = await this.findSnapshot(snapshotIdentifier);
    let idempotent = Boolean(snapshot);
    if (snapshot && snapshot.DBInstanceIdentifier !== this.dbInstanceIdentifier) {
      throw backupError('Snapshot identifier already belongs to a different RDS source.', 'BACKUP_IDEMPOTENCY_CONFLICT');
    }
    if (!snapshot) {
      const response = await this.client.send(new CreateDBSnapshotCommand({
        DBInstanceIdentifier: this.dbInstanceIdentifier,
        DBSnapshotIdentifier: snapshotIdentifier,
        Tags: [
          { Key: 'ManagedBy', Value: 'LGSV-HR' },
          { Key: 'BackupReference', Value: reference },
        ],
      }));
      snapshot = response?.DBSnapshot || null;
      idempotent = false;
    }
    if (snapshot?.Status !== 'available') {
      const waiterResult = await this.snapshotWaiter(
        { client: this.client, maxWaitTime: this.maxWaitSeconds, minDelay: 15, maxDelay: 60 },
        { DBSnapshotIdentifier: snapshotIdentifier, SnapshotType: 'manual' }
      );
      if (waiterResult?.state && waiterResult.state !== 'SUCCESS') {
        throw backupError('RDS snapshot did not become available in time.', 'RDS_SNAPSHOT_WAIT_FAILED', { retryable: true });
      }
      snapshot = await this.describeSnapshot(snapshotIdentifier);
    }
    this.validateSnapshot(snapshot);
    const descriptor = describeSnapshotArtifact(snapshot);
    return {
      provider: this.provider,
      location: rdsLocation(this.region, snapshotIdentifier),
      descriptor,
      idempotent,
    };
  }

  async verifyStoredArtifact(location, expectedChecksum) {
    const expected = validateExpectedChecksum(expectedChecksum);
    const { snapshotIdentifier } = this.parseLocation(location);
    const snapshot = await this.describeSnapshot(snapshotIdentifier);
    this.validateSnapshot(snapshot);
    const descriptor = describeSnapshotArtifact(snapshot);
    return {
      valid: descriptor.checksum === expected,
      expectedChecksum: expected,
      actualChecksum: descriptor.checksum,
      descriptor,
    };
  }

  async validateRestoreCandidate({ location, expectedChecksum }) {
    const verification = await this.verifyStoredArtifact(location, expectedChecksum);
    return {
      valid: verification.valid,
      isolatedRestoreRequired: true,
      sourceInstanceIdentifier: this.dbInstanceIdentifier,
      snapshot: verification.descriptor.snapshot,
      verification,
    };
  }

  async restoreToNewInstance({
    location,
    expectedChecksum,
    newDbInstanceIdentifier,
    dbInstanceClass,
    dbSubnetGroupName,
    vpcSecurityGroupIds,
    publiclyAccessible = false,
    tags = [],
    waitForAvailable = false,
  }) {
    const verification = await this.verifyStoredArtifact(location, expectedChecksum);
    if (!verification.valid) {
      throw backupError('RDS snapshot failed integrity verification.', 'BACKUP_INTEGRITY_MISMATCH');
    }
    const target = validateRdsIdentifier(newDbInstanceIdentifier, 'RDS restore target identifier');
    if (target === this.dbInstanceIdentifier) {
      throw backupError('RDS snapshot restores must use a new DB instance.', 'RDS_IN_PLACE_RESTORE_BLOCKED');
    }
    if (!target.startsWith('lgsv-restore-')) {
      throw backupError('RDS restore target must use the lgsv-restore- prefix.', 'INVALID_RDS_RESTORE_TARGET');
    }
    if (!String(dbInstanceClass || '').trim()) {
      throw backupError('RDS restore DB instance class is required.', 'RDS_RESTORE_CONFIG_MISSING');
    }
    try {
      const existing = await this.client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: target }));
      if (existing?.DBInstances?.length) {
        throw backupError('RDS restore target already exists.', 'RDS_RESTORE_TARGET_EXISTS');
      }
    } catch (error) {
      if (error instanceof Error && error.code === 'RDS_RESTORE_TARGET_EXISTS') throw error;
      if (!['DBInstanceNotFound', 'DBInstanceNotFoundFault'].includes(error?.name) && Number(error?.$metadata?.httpStatusCode) !== 404) {
        throw error;
      }
    }
    const { snapshotIdentifier } = this.parseLocation(location);
    const response = await this.client.send(new RestoreDBInstanceFromDBSnapshotCommand({
      DBInstanceIdentifier: target,
      DBSnapshotIdentifier: snapshotIdentifier,
      DBInstanceClass: String(dbInstanceClass).trim(),
      DBSubnetGroupName: String(dbSubnetGroupName || '').trim() || undefined,
      VpcSecurityGroupIds: Array.isArray(vpcSecurityGroupIds) ? vpcSecurityGroupIds.map(String) : undefined,
      PubliclyAccessible: Boolean(publiclyAccessible),
      CopyTagsToSnapshot: true,
      Tags: [
        { Key: 'ManagedBy', Value: 'LGSV-HR' },
        { Key: 'RecoveryPurpose', Value: 'ControlledRestore' },
        ...tags.filter(tag => tag?.Key && tag?.Value).map(tag => ({ Key: String(tag.Key), Value: String(tag.Value) })),
      ],
    }));
    if (waitForAvailable) {
      const waiterResult = await this.instanceWaiter(
        { client: this.client, maxWaitTime: this.maxWaitSeconds, minDelay: 30, maxDelay: 90 },
        { DBInstanceIdentifier: target }
      );
      if (waiterResult?.state && waiterResult.state !== 'SUCCESS') {
        throw backupError('Restored RDS instance did not become available in time.', 'RDS_RESTORE_WAIT_FAILED', { retryable: true });
      }
    }
    return {
      initiated: true,
      sourceSnapshotIdentifier: snapshotIdentifier,
      newDbInstanceIdentifier: target,
      status: response?.DBInstance?.DBInstanceStatus || 'creating',
      endpoint: response?.DBInstance?.Endpoint?.Address || null,
      inPlace: false,
    };
  }

  async verifyRestoredInstance({ location, expectedChecksum, newDbInstanceIdentifier }) {
    const verification = await this.verifyStoredArtifact(location, expectedChecksum);
    if (!verification.valid) {
      throw backupError('RDS snapshot failed integrity verification.', 'BACKUP_INTEGRITY_MISMATCH');
    }
    const target = validateRdsIdentifier(newDbInstanceIdentifier, 'RDS restore target identifier');
    if (target === this.dbInstanceIdentifier || !target.startsWith('lgsv-restore-')) {
      throw backupError('RDS restore target is not an isolated recovery instance.', 'RDS_IN_PLACE_RESTORE_BLOCKED');
    }
    const instance = await this.describeInstance(target);
    const status = String(instance.DBInstanceStatus || '').toLowerCase();
    const pending = status !== 'available';
    const encrypted = instance.StorageEncrypted === true;
    const privateNetwork = instance.PubliclyAccessible !== true;
    const endpoint = instance.Endpoint?.Address || null;
    const port = Number(instance.Endpoint?.Port || instance.Port || 3306);
    const snapshotIdentifier = this.parseLocation(location).snapshotIdentifier;
    const snapshotMatches = !instance.DBSnapshotIdentifier || instance.DBSnapshotIdentifier === snapshotIdentifier;
    const engineMatches = !instance.Engine || instance.Engine === verification.descriptor.snapshot.engine;
    return {
      valid: !pending && encrypted && privateNetwork && Boolean(endpoint) && snapshotMatches && engineMatches,
      pending,
      status: status || 'unknown',
      targetInstanceIdentifier: target,
      endpoint,
      port,
      encrypted,
      privateNetwork,
      snapshotMatches,
      engineMatches,
      artifactVerification: verification,
    };
  }
}

module.exports = {
  RdsSnapshotAdapter,
  describeSnapshotArtifact,
  rdsLocation,
  snapshotIdentifierFromReference,
  snapshotIntegrityFields,
  validateRdsIdentifier,
};
