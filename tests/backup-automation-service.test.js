'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

process.env.NODE_ENV = 'test';

const {
  BackupAutomationService,
  BackupRuntime,
  LocalStorageAdapter,
  RdsSnapshotAdapter,
  S3StorageAdapter,
  computeNextRunAt,
  providerReadinessFromEnv,
} = require('../services/backup');
const { describeSnapshotArtifact, rdsLocation } = require('../services/backup/rdsSnapshotAdapter');

const tests = [];
const ENCRYPTION_KEY = 'c4'.repeat(32);

function test(name, callback) {
  tests.push({ name, callback });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error => error?.code === code, `Expected ${code}`);
}

async function bodyBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

class DeleteCapableS3Client {
  constructor() {
    this.objects = new Map();
  }

  async send(command) {
    const name = command.constructor.name;
    const input = command.input;
    if (name === 'PutObjectCommand') {
      const key = `${input.Bucket}/${input.Key}`;
      if (input.IfNoneMatch === '*' && this.objects.has(key)) {
        const error = new Error('exists');
        error.name = 'PreconditionFailed';
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      this.objects.set(key, { body: await bodyBuffer(input.Body), encryption: input.ServerSideEncryption });
      return {};
    }
    if (name === 'GetObjectCommand') {
      const object = this.objects.get(`${input.Bucket}/${input.Key}`);
      if (!object) {
        const error = new Error('missing');
        error.name = 'NoSuchKey';
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return { Body: Readable.from(object.body), ServerSideEncryption: object.encryption };
    }
    if (name === 'DeleteObjectsCommand') {
      for (const object of input.Delete.Objects) this.objects.delete(`${input.Bucket}/${object.Key}`);
      return { Errors: [] };
    }
    throw new Error(`Unexpected S3 command: ${name}`);
  }
}

function snapshot(overrides = {}) {
  return {
    DBSnapshotIdentifier: 'lgsv-backup-1',
    DBSnapshotArn: 'arn:aws:rds:ap-southeast-1:123456789012:snapshot:lgsv-backup-1',
    DBInstanceIdentifier: 'lgsv-production',
    SnapshotCreateTime: new Date('2026-07-01T00:00:00.000Z'),
    Engine: 'mysql',
    EngineVersion: '8.0.40',
    Port: 3306,
    Encrypted: true,
    KmsKeyId: 'kms-key-reference',
    VpcId: 'vpc-1',
    StorageType: 'gp3',
    AllocatedStorage: 100,
    Status: 'available',
    PercentProgress: 100,
    ...overrides,
  };
}

class DeleteCapableRdsClient {
  constructor(value) {
    this.snapshot = value;
    this.deleted = false;
  }

  async send(command) {
    if (command.constructor.name === 'DescribeDBSnapshotsCommand') {
      if (!this.snapshot) {
        const error = new Error('missing');
        error.name = 'DBSnapshotNotFoundFault';
        throw error;
      }
      return { DBSnapshots: [this.snapshot] };
    }
    if (command.constructor.name === 'DeleteDBSnapshotCommand') {
      this.snapshot = null;
      this.deleted = true;
      return {};
    }
    throw new Error(`Unexpected RDS command: ${command.constructor.name}`);
  }
}

class RestoreDrillRdsClient {
  constructor(value) {
    this.snapshot = value;
    this.instances = new Map();
    this.tags = new Map();
    this.commands = [];
  }

  async send(command) {
    const name = command.constructor.name;
    const input = command.input;
    this.commands.push({ name, input });
    if (name === 'DescribeDBSnapshotsCommand') return { DBSnapshots: [this.snapshot] };
    if (name === 'DescribeDBInstancesCommand') {
      const instance = this.instances.get(input.DBInstanceIdentifier);
      if (instance) return { DBInstances: [instance] };
      const error = new Error('missing');
      error.name = 'DBInstanceNotFoundFault';
      throw error;
    }
    if (name === 'RestoreDBInstanceFromDBSnapshotCommand') {
      const arn = `arn:aws:rds:ap-southeast-1:123456789012:db:${input.DBInstanceIdentifier}`;
      const instance = {
        DBInstanceIdentifier: input.DBInstanceIdentifier,
        DBInstanceArn: arn,
        DBInstanceStatus: 'available',
        DBSnapshotIdentifier: input.DBSnapshotIdentifier,
        Engine: 'mysql',
        StorageEncrypted: true,
        PubliclyAccessible: false,
        Endpoint: { Address: 'restore.internal', Port: 3306 },
      };
      this.instances.set(input.DBInstanceIdentifier, instance);
      this.tags.set(arn, input.Tags);
      return { DBInstance: instance };
    }
    if (name === 'ListTagsForResourceCommand') return { TagList: this.tags.get(input.ResourceName) || [] };
    if (name === 'DeleteDBInstanceCommand') {
      this.instances.delete(input.DBInstanceIdentifier);
      return {};
    }
    throw new Error(`Unexpected RDS command: ${name}`);
  }
}

class FakeRepository {
  constructor() {
    this.schedule = {
      id: 4,
      schedule_reference: 'SCH-4',
      name: 'Daily protected backup',
      backup_type: 'FILES',
      storage_provider: 'LOCAL',
      included_modules: JSON.stringify(['reports']),
      frequency: 'DAILY',
      run_time: '02:00:00',
      timezone: 'Asia/Manila',
      next_run_at: new Date('2026-07-14T18:00:00.000Z'),
      retention_max_age_days: 30,
      created_by: 1,
    };
    this.backup = null;
    this.scheduleStatus = null;
    this.audits = [];
    this.notifications = [];
    this.expired = [];
    this.deleted = [];
    this.retentionRows = [];
    this.pendingActions = [];
    this.checkers = [1, 15];
    this.drillSchedule = {
      id: 8,
      schedule_reference: 'DRS-8',
      name: 'Weekly drill',
      frequency: 'WEEKLY',
      run_time: '03:00:00',
      day_of_week: 1,
      timezone: 'Asia/Manila',
      next_run_at: new Date('2026-07-19T19:00:00.000Z'),
      created_by: 1,
    };
    this.drillBackup = null;
    this.drillRun = null;
    this.persistedMetadata = null;
  }

  async listDueBackupSchedules() { return [this.schedule]; }
  async getBackupSchedule() { return this.schedule; }
  async claimBackupSchedule() { return true; }
  async markBackupScheduleStarted() { this.scheduleStatus = 'RUNNING'; }
  async finishBackupSchedule(_id, status) { this.scheduleStatus = status; }
  async createScheduledBackup({ schedule, expiresAt }) {
    this.backup = {
      id: 41,
      backup_reference: 'BKP-SCH-4-20260715020000',
      backup_type: schedule.backup_type,
      storage_provider: schedule.storage_provider,
      included_modules: schedule.included_modules,
      status: 'PENDING',
      expires_at: expiresAt,
    };
    return this.backup;
  }
  async transitionBackup({ backupSetId, expectedStatus, status, patch }) {
    assert.strictEqual(backupSetId, 41);
    assert.strictEqual(this.backup.status, expectedStatus);
    this.backup.status = status;
    Object.assign(this.backup, patch);
    return true;
  }
  async persistBackupIntegrityMetadata(id, result) { this.persistedMetadata = { id, result }; return true; }
  async audit(action, details) { this.audits.push({ action, details }); }

  async listRetentionPolicies() {
    return [{ id: 3, keep_last: 1, max_age_days: 30, delete_expired_artifacts: true, created_by: 1 }];
  }
  async listRetentionScope() { return this.retentionRows; }
  async markBackupExpired(id) { this.expired.push(id); return true; }
  async markArtifactDeleted(id) { this.deleted.push(id); return true; }
  async listPendingCheckerActions() { return this.pendingActions; }
  async listEligibleCheckers(excluded) { return this.checkers.filter(id => id !== Number(excluded)); }
  async upsertNotification(value) { this.notifications.push(value); }
  async resolveStaleCheckerNotifications() { return 2; }

  async listDueDrillSchedules() { return [this.drillSchedule]; }
  async getDrillSchedule() { return this.drillSchedule; }
  async claimDrillSchedule() { return true; }
  async markDrillScheduleStarted() {}
  async finishDrillSchedule(_id, status) { this.drillScheduleStatus = status; }
  async findLatestVerifiedBackup() { return this.drillBackup; }
  async createDrillRun({ backup }) {
    this.drillRun = { id: 77, run_reference: 'DRILL-8', backup_set_id: backup?.id || null, status: 'RUNNING' };
    return this.drillRun;
  }
  async finishDrillRun(_id, value) { Object.assign(this.drillRun, value); return true; }
}

test('computeNextRunAt handles hourly, Manila daily, ISO weekly, and month-end schedules', () => {
  assert.strictEqual(
    computeNextRunAt({ frequency: 'HOURLY' }, new Date('2026-07-14T01:23:45.000Z')).toISOString(),
    '2026-07-14T02:23:45.000Z'
  );
  assert.strictEqual(
    computeNextRunAt({ frequency: 'DAILY', run_time: '10:00', timezone: 'Asia/Manila' }, new Date('2026-07-14T01:00:00.000Z')).toISOString(),
    '2026-07-14T02:00:00.000Z'
  );
  assert.strictEqual(
    computeNextRunAt({ frequency: 'WEEKLY', run_time: '09:00', day_of_week: 1, timezone: 'Asia/Manila' }, new Date('2026-07-14T00:00:00.000Z')).toISOString(),
    '2026-07-20T01:00:00.000Z'
  );
  assert.strictEqual(
    computeNextRunAt({ frequency: 'MONTHLY', run_time: '08:00', day_of_month: 31, timezone: 'Asia/Manila' }, new Date('2026-04-29T01:00:00.000Z')).toISOString(),
    '2026-04-30T00:00:00.000Z'
  );
});

test('provider readiness reports only configuration names and never secret values', () => {
  const secret = 'do-not-return-this-password';
  const result = providerReadinessFromEnv({
    AWS_REGION: 'ap-southeast-1',
    AWS_S3_BUCKET: 'lgsv-secure-backups',
    AWS_RDS_DB_INSTANCE_IDENTIFIER: 'lgsv-production',
    BACKUP_DRY_RUN_DB_HOST: 'isolated-db',
    BACKUP_DRY_RUN_DB_USER: 'restore-user',
    BACKUP_DRY_RUN_DB_PASSWORD: secret,
    BACKUP_DRY_RUN_DB_NAME: 'restore_test',
  });
  assert.strictEqual(result.s3.ready, true);
  assert.strictEqual(result.rdsSnapshot.ready, true);
  assert.strictEqual(result.databaseDryRun.ready, true);
  assert.strictEqual(JSON.stringify(result).includes(secret), false);
  assert.strictEqual(result.rdsIsolatedRestore.ready, false);

  const complete = providerReadinessFromEnv({
    AWS_REGION: 'ap-southeast-1',
    AWS_S3_BUCKET: 'lgsv-secure-backups',
    AWS_RDS_DB_INSTANCE_IDENTIFIER: 'lgsv-production',
    AWS_RDS_RESTORE_INSTANCE_CLASS: 'db.t4g.small',
    AWS_RDS_RESTORE_SUBNET_GROUP: 'private-db-subnets',
    AWS_RDS_RESTORE_SECURITY_GROUP_IDS: 'sg-123',
    AWS_RDS_RESTORE_WAIT_FOR_AVAILABLE: 'true',
    BACKUP_RDS_VERIFY_DB_USER: 'integrity_reader',
    BACKUP_RDS_VERIFY_DB_PASSWORD: secret,
    BACKUP_RDS_VERIFY_DB_NAME: 'lgsv_hr_db',
    BACKUP_RDS_VERIFY_DB_SSL: 'true',
  });
  assert.strictEqual(complete.rdsIsolatedRestore.ready, true);
  assert.strictEqual(JSON.stringify(complete).includes(secret), false);
});

test('LOCAL retention deletion verifies identity, removes only its artifact, and is idempotent', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lgsv-retention-local-'));
  try {
    const source = path.join(root, 'source');
    await fs.promises.mkdir(source);
    await fs.promises.writeFile(path.join(source, 'file.txt'), 'protected backup payload');
    const adapter = new LocalStorageAdapter({ rootPath: path.join(root, 'backups'), encryptionKey: ENCRYPTION_KEY });
    const stored = await adapter.storeArtifact({ artifactPath: source, backupReference: 'RETENTION-LOCAL-1' });
    await expectCode(adapter.deleteArtifact({ location: stored.location, expectedChecksum: '0'.repeat(64) }), 'BACKUP_RETENTION_IDENTITY_MISMATCH');
    assert.strictEqual((await adapter.deleteArtifact({ location: stored.location, expectedChecksum: stored.descriptor.checksum })).deleted, true);
    assert.strictEqual((await adapter.deleteArtifact({ location: stored.location, expectedChecksum: stored.descriptor.checksum })).idempotent, true);
    assert.strictEqual(await fs.promises.access(source).then(() => true), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('S3 retention deletion removes immutable objects before its manifest and is idempotent', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lgsv-retention-s3-'));
  try {
    await fs.promises.writeFile(path.join(root, 'payload.txt'), 'S3 backup payload');
    const client = new DeleteCapableS3Client();
    const adapter = new S3StorageAdapter({ bucket: 'lgsv-secure-backups', prefix: 'backups', region: 'ap-southeast-1', client });
    const stored = await adapter.storeArtifact({ artifactPath: root, backupReference: 'RETENTION-S3-1' });
    assert.ok(client.objects.size >= 2);
    await adapter.deleteArtifact({ location: stored.location, expectedChecksum: stored.descriptor.checksum });
    assert.strictEqual(client.objects.size, 0);
    assert.strictEqual((await adapter.deleteArtifact({ location: stored.location, expectedChecksum: stored.descriptor.checksum })).idempotent, true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('RDS retention deletion fails closed without explicit opt-in and checks managed snapshot identity', async () => {
  const value = snapshot();
  const checksum = describeSnapshotArtifact(value).checksum;
  const location = rdsLocation('ap-southeast-1', value.DBSnapshotIdentifier);
  const disabledClient = new DeleteCapableRdsClient(value);
  const disabled = new RdsSnapshotAdapter({ region: 'ap-southeast-1', dbInstanceIdentifier: 'lgsv-production', client: disabledClient });
  await expectCode(disabled.deleteArtifact({ location, expectedChecksum: checksum }), 'RDS_RETENTION_DELETE_DISABLED');
  assert.strictEqual(disabledClient.deleted, false);

  const enabledClient = new DeleteCapableRdsClient(value);
  const enabled = new RdsSnapshotAdapter({
    region: 'ap-southeast-1', dbInstanceIdentifier: 'lgsv-production', client: enabledClient, allowDeleteSnapshots: true,
  });
  const result = await enabled.deleteArtifact({ location, expectedChecksum: checksum });
  assert.strictEqual(result.deletionPending, true);
  assert.strictEqual(enabledClient.deleted, true);
});

test('RDS adapter deletes only a tagged disposable restore-drill instance without a final snapshot', async () => {
  const value = snapshot();
  const client = new RestoreDrillRdsClient(value);
  const adapter = new RdsSnapshotAdapter({
    region: 'ap-southeast-1',
    dbInstanceIdentifier: 'lgsv-production',
    client,
    instanceWaiter: async () => ({ state: 'SUCCESS' }),
    instanceDeleteWaiter: async () => ({ state: 'SUCCESS' }),
  });
  const descriptor = describeSnapshotArtifact(value);
  const location = rdsLocation('ap-southeast-1', value.DBSnapshotIdentifier);
  const target = 'lgsv-restore-drill-abc123';
  await adapter.restoreToNewInstance({
    location,
    expectedChecksum: descriptor.checksum,
    newDbInstanceIdentifier: target,
    dbInstanceClass: 'db.t4g.small',
    dbSubnetGroupName: 'private-db-subnets',
    vpcSecurityGroupIds: ['sg-123'],
    waitForAvailable: true,
    recoveryPurpose: 'ScheduledRestoreDrill',
    drillReference: 'DRILL-TEST-1',
  });
  const deleted = await adapter.deleteRestoreDrillInstance({
    location,
    newDbInstanceIdentifier: target,
    drillReference: 'DRILL-TEST-1',
  });
  assert.strictEqual(deleted.deleted, true);
  const command = client.commands.find(item => item.name === 'DeleteDBInstanceCommand');
  assert.strictEqual(command.input.SkipFinalSnapshot, true);
  assert.strictEqual(command.input.DeleteAutomatedBackups, true);
  await expectCode(adapter.deleteRestoreDrillInstance({
    location,
    newDbInstanceIdentifier: 'lgsv-production',
    drillReference: 'DRILL-TEST-1',
  }), 'UNSAFE_RDS_DRILL_DELETE');
});

test('runtime performs true RDS disposable restore, database integrity verification, and cleanup', async () => {
  const calls = [];
  const expectedDatabase = {
    databaseName: 'lgsv_hr_db',
    schemaHash: 'a'.repeat(64),
    schema: { tables: [] },
    rowCounts: null,
    allTablesHealthy: true,
  };
  const adapter = {
    provider: 'RDS_SNAPSHOT',
    async deleteRestoreDrillInstance(input) { calls.push(['delete', input]); return { deleted: true }; },
    async restoreToNewInstance(input) { calls.push(['restore', input]); return { initiated: true, newDbInstanceIdentifier: input.newDbInstanceIdentifier }; },
    async verifyRestoredInstance(input) {
      calls.push(['verify-infrastructure', input]);
      return { valid: true, pending: false, endpoint: 'restore.internal', port: 3306, encrypted: true, privateNetwork: true };
    },
  };
  const runtime = new BackupRuntime({
    adapters: [adapter],
    mysqlBackupService: {
      async captureDatabaseIntegrity({ connection }) {
        calls.push(['verify-database', connection]);
        return { ...expectedDatabase };
      },
    },
    rdsVerificationConnection: { user: 'reader', password: 'secret', database: 'lgsv_hr_db', sslEnabled: true },
    rdsRestoreOptions: {
      dbInstanceClass: 'db.t4g.small',
      dbSubnetGroupName: 'private-db-subnets',
      vpcSecurityGroupIds: ['sg-123'],
      waitForAvailable: true,
    },
  });
  const result = await runtime.runRdsRestoreDrill({
    backupReference: 'BKP-RDS-1',
    storageLocation: 'rds-snapshot://ap-southeast-1/lgsv-snapshot-1',
    expectedChecksum: 'd'.repeat(64),
    expectedIntegrity: { database: expectedDatabase },
    drillReference: 'DRILL-RDS-1',
  });
  assert.strictEqual(result.safeToRestore, true);
  assert.strictEqual(result.liveRestoreApplied, false);
  assert.strictEqual(result.disposableInstanceDeleted, true);
  assert.deepStrictEqual(calls.map(call => call[0]), ['delete', 'restore', 'verify-infrastructure', 'verify-database', 'delete']);
  assert.strictEqual(calls[1][1].publiclyAccessible, false);
  assert.strictEqual(calls[1][1].waitForAvailable, true);
  assert.strictEqual(calls[3][1].host, 'restore.internal');
});

test('runtime fails the RDS drill when disposable instance cleanup fails', async () => {
  let deletionCount = 0;
  const expectedDatabase = { databaseName: 'lgsv_hr_db', schemaHash: 'a'.repeat(64), schema: { tables: [] }, rowCounts: null, allTablesHealthy: true };
  const adapter = {
    provider: 'RDS_SNAPSHOT',
    async deleteRestoreDrillInstance() {
      deletionCount += 1;
      if (deletionCount > 1) { const error = new Error('cleanup'); error.code = 'AWS_DELETE_FAILED'; throw error; }
      return { deleted: true };
    },
    async restoreToNewInstance() { return { initiated: true }; },
    async verifyRestoredInstance() { return { valid: true, pending: false, endpoint: 'restore.internal', port: 3306 }; },
  };
  const runtime = new BackupRuntime({
    adapters: [adapter],
    mysqlBackupService: { async captureDatabaseIntegrity() { return { ...expectedDatabase }; } },
    rdsVerificationConnection: { user: 'reader', password: 'secret', database: 'lgsv_hr_db', sslEnabled: true },
    rdsRestoreOptions: { dbInstanceClass: 'db.t4g.small', dbSubnetGroupName: 'private', vpcSecurityGroupIds: ['sg-1'], waitForAvailable: true },
  });
  await expectCode(runtime.runRdsRestoreDrill({
    backupReference: 'BKP-RDS-2', storageLocation: 'rds-snapshot://ap-southeast-1/lgsv-snapshot-2',
    expectedChecksum: 'e'.repeat(64), expectedIntegrity: { database: expectedDatabase }, drillReference: 'DRILL-RDS-2',
  }), 'RDS_DRILL_CLEANUP_FAILED');
});

test('runtime still removes the disposable RDS instance after an integrity failure', async () => {
  let deletionCount = 0;
  const expectedDatabase = { databaseName: 'lgsv_hr_db', schemaHash: 'a'.repeat(64), schema: { tables: [] }, rowCounts: null };
  const adapter = {
    provider: 'RDS_SNAPSHOT',
    async deleteRestoreDrillInstance() { deletionCount += 1; return { deleted: true }; },
    async restoreToNewInstance() { return { initiated: true }; },
    async verifyRestoredInstance() { return { valid: false, pending: false, endpoint: 'restore.internal', port: 3306 }; },
  };
  const runtime = new BackupRuntime({
    adapters: [adapter],
    mysqlBackupService: { async captureDatabaseIntegrity() { throw new Error('must not connect after infrastructure failure'); } },
    rdsVerificationConnection: { user: 'reader', password: 'secret', database: 'lgsv_hr_db', sslEnabled: true },
    rdsRestoreOptions: { dbInstanceClass: 'db.t4g.small', dbSubnetGroupName: 'private', vpcSecurityGroupIds: ['sg-1'], waitForAvailable: true },
  });
  await expectCode(runtime.runRdsRestoreDrill({
    backupReference: 'BKP-RDS-3', storageLocation: 'rds-snapshot://ap-southeast-1/lgsv-snapshot-3',
    expectedChecksum: '1'.repeat(64), expectedIntegrity: { database: expectedDatabase }, drillReference: 'DRILL-RDS-3',
  }), 'RDS_DRILL_INTEGRITY_FAILED');
  assert.strictEqual(deletionCount, 2);
});

test('due schedule creates an artifact and stops at COMPLETED pending an independent checker', async () => {
  const repository = new FakeRepository();
  const runtime = {
    async createBackup() {
      return {
        storageLocation: 'local-backup:///scheduled', checksum: crypto.randomBytes(32).toString('hex'),
        fileSize: 123, status: 'COMPLETED', verified: true,
      };
    },
    async verifyBackup() { return { valid: true }; },
  };
  const service = new BackupAutomationService({ repository, runtime, clock: () => new Date('2026-07-14T18:05:00.000Z') });
  const results = await service.runDueBackupSchedules();
  assert.strictEqual(results[0].status, 'COMPLETED');
  assert.strictEqual(results[0].independentVerificationRequired, true);
  assert.strictEqual(repository.backup.status, 'COMPLETED');
  assert.strictEqual(repository.scheduleStatus, 'SUCCESS');
  assert.strictEqual(repository.backup.verified_by, undefined);
});

test('scheduled RDS backup persists source integrity metadata before checker verification', async () => {
  const repository = new FakeRepository();
  repository.schedule.backup_type = 'DATABASE';
  repository.schedule.storage_provider = 'RDS_SNAPSHOT';
  const integrityReport = {
    snapshot: { snapshotIdentifier: 'lgsv-snapshot-1' },
    database: { databaseName: 'lgsv_hr_db', schemaHash: 'a'.repeat(64), schema: { tables: [] } },
  };
  const runtime = {
    async createBackup() {
      return {
        storageProvider: 'RDS_SNAPSHOT', storageLocation: 'rds-snapshot://ap-southeast-1/lgsv-snapshot-1',
        checksum: 'c'.repeat(64), fileSize: null, status: 'COMPLETED', integrityReport,
      };
    },
  };
  const service = new BackupAutomationService({ repository, runtime, clock: () => new Date('2026-07-14T18:05:00.000Z') });
  const result = await service.runDueBackupSchedules();
  assert.strictEqual(result[0].status, 'COMPLETED');
  assert.strictEqual(repository.persistedMetadata.id, 41);
  assert.strictEqual(repository.persistedMetadata.result.integrityReport, integrityReport);
});

test('retention keeps newest verified evidence and deletes only the expired artifact bytes', async () => {
  const repository = new FakeRepository();
  repository.retentionRows = [
    { id: 2, verified_at: new Date('2026-07-10T00:00:00Z'), storage_provider: 'LOCAL', storage_location: 'new', checksum: 'a'.repeat(64) },
    { id: 1, verified_at: new Date('2026-01-01T00:00:00Z'), storage_provider: 'LOCAL', storage_location: 'old', checksum: 'b'.repeat(64), backup_reference: 'OLD' },
  ];
  const deletedLocations = [];
  const runtime = { async deleteArtifact(value) { deletedLocations.push(value.storageLocation); return { deleted: true }; } };
  const service = new BackupAutomationService({ repository, runtime, clock: () => new Date('2026-07-14T00:00:00Z') });
  const result = await service.enforceRetention();
  assert.deepStrictEqual(deletedLocations, ['old']);
  assert.deepStrictEqual(repository.expired, [1]);
  assert.deepStrictEqual(repository.deleted, [1]);
  assert.strictEqual(result[0].status, 'DELETED');
});

test('notification reconciliation excludes the maker and creates checker inbox entries', async () => {
  const repository = new FakeRepository();
  repository.pendingActions = [{
    id: 41, requested_by: 1, category: 'BACKUP_VERIFICATION_REQUIRED', resourceType: 'BACKUP_SET',
    title: 'Backup verification required', message: 'Backup is ready.',
  }];
  const service = new BackupAutomationService({ repository, runtime: {} });
  const result = await service.reconcileNotifications();
  assert.strictEqual(result.pendingActions, 1);
  assert.strictEqual(repository.notifications.length, 1);
  assert.strictEqual(repository.notifications[0].recipientUserId, 15);
  assert.strictEqual(repository.notifications[0].actionRequired, true);
});

test('scheduled restore drill selects only the repository verified candidate and never applies a live restore', async () => {
  const repository = new FakeRepository();
  repository.drillBackup = {
    id: 50, backup_reference: 'VERIFIED-50', backup_type: 'FILES', storage_provider: 'LOCAL',
    storage_location: 'local-backup:///VERIFIED-50', checksum: 'e'.repeat(64), status: 'VERIFIED',
  };
  let dryRuns = 0;
  let liveRestores = 0;
  const runtime = {
    async runRestoreDryRun() { dryRuns += 1; return { safeToRestore: true, checks: [{ status: 'PASS' }] }; },
    async applyRestore() { liveRestores += 1; throw new Error('must not be called'); },
  };
  const service = new BackupAutomationService({ repository, runtime });
  const result = await service.runDrillById(8, { actorId: 15, scheduledFor: new Date('2026-07-20T00:00:00Z') });
  assert.strictEqual(result.status, 'PASSED');
  assert.strictEqual(result.liveRestoreApplied, false);
  assert.strictEqual(dryRuns, 1);
  assert.strictEqual(liveRestores, 0);
  assert.strictEqual(repository.drillScheduleStatus, 'PASSED');
});

test('scheduled RDS drill uses disposable RDS orchestration and not metadata-only dry run', async () => {
  const repository = new FakeRepository();
  repository.drillBackup = {
    id: 51, backup_reference: 'VERIFIED-RDS-51', backup_type: 'DATABASE', storage_provider: 'RDS_SNAPSHOT',
    storage_location: 'rds-snapshot://ap-southeast-1/lgsv-snapshot-51', checksum: 'f'.repeat(64),
    status: 'VERIFIED', expected_integrity: { database: { schemaHash: 'a'.repeat(64) } },
  };
  let rdsDrills = 0;
  let metadataDryRuns = 0;
  const runtime = {
    async runRdsRestoreDrill(input) {
      rdsDrills += 1;
      assert.strictEqual(input.expectedIntegrity, repository.drillBackup.expected_integrity);
      return { safeToRestore: true, liveRestoreApplied: false, disposableInstanceDeleted: true };
    },
    async runRestoreDryRun() { metadataDryRuns += 1; throw new Error('must not be called'); },
  };
  const service = new BackupAutomationService({ repository, runtime });
  const result = await service.runDrillById(8, { actorId: 15, scheduledFor: new Date('2026-07-20T00:00:00Z') });
  assert.strictEqual(result.status, 'PASSED');
  assert.strictEqual(rdsDrills, 1);
  assert.strictEqual(metadataDryRuns, 0);
});

test('scheduled RDS cleanup failure marks the run failed and creates administrator notifications', async () => {
  const repository = new FakeRepository();
  repository.drillBackup = {
    id: 52, backup_reference: 'VERIFIED-RDS-52', backup_type: 'DATABASE', storage_provider: 'RDS_SNAPSHOT',
    storage_location: 'rds-snapshot://ap-southeast-1/lgsv-snapshot-52', checksum: '2'.repeat(64),
    expected_integrity: { database: { schemaHash: 'a'.repeat(64) } },
  };
  const cleanupError = new Error('cleanup failed');
  cleanupError.code = 'RDS_DRILL_CLEANUP_FAILED';
  const service = new BackupAutomationService({
    repository,
    runtime: { async runRdsRestoreDrill() { throw cleanupError; } },
  });
  await expectCode(service.runDrillById(8, { actorId: 15, scheduledFor: new Date('2026-07-20T00:00:00Z') }), 'RDS_DRILL_CLEANUP_FAILED');
  assert.strictEqual(repository.drillRun.status, 'FAILED');
  assert.strictEqual(repository.notifications.some(item => item.category === 'DRILL_RESULT'), true);
});

test('automation timer is non-blocking, non-overlapping, and can be stopped cleanly', async () => {
  const repository = new FakeRepository();
  const service = new BackupAutomationService({
    repository,
    runtime: {},
    intervalMs: 60000,
    environment: {
      BACKUP_AUTOMATION_ENABLED: 'false',
      BACKUP_RETENTION_AUTOMATION_ENABLED: 'false',
      BACKUP_RESTORE_DRILL_AUTOMATION_ENABLED: 'false',
    },
  });
  assert.strictEqual(service.start(), service);
  assert.strictEqual(service.timer.hasRef(), false);
  const firstTimer = service.timer;
  service.start();
  assert.strictEqual(service.timer, firstTimer);
  service.stop();
  assert.strictEqual(service.timer, null);
  await service.inFlight;
});

(async () => {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.callback();
      console.log(`PASS ${entry.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${entry.name}`);
      console.error(error);
    }
  }
  if (failed) process.exitCode = 1;
  else console.log(`PASS ${tests.length} backup automation tests`);
})();
