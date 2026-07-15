'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

process.env.NODE_ENV = 'test';

const {
  BackupBundleBuilder,
  BackupRuntime,
  BackupWorker,
  LocalStorageAdapter,
  MySqlBackupService,
  RdsSnapshotAdapter,
  S3StorageAdapter,
  compareIntegrityReports,
  createDatabaseIntegrityReport,
  describeArtifact,
} = require('../services/backup');
const { decryptFile, encryptFile, hashDecryptedFile } = require('../services/backup/envelopeEncryption');
const { validateDumpSafety } = require('../services/backup/mysqlBackupService');

const ENCRYPTION_KEY = 'ab'.repeat(32);
const tests = [];

function test(name, callback) {
  tests.push({ name, callback });
}

async function temporaryDirectory(prefix) {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error => error?.code === code, `Expected error code ${code}`);
}

async function streamToBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

class MemoryS3Client {
  constructor() {
    this.objects = new Map();
    this.commands = [];
  }

  async send(command) {
    const name = command.constructor.name;
    const input = command.input;
    this.commands.push({ name, input });
    const objectKey = `${input.Bucket}/${input.Key}`;
    if (name === 'PutObjectCommand') {
      if (input.IfNoneMatch === '*' && this.objects.has(objectKey)) {
        const error = new Error('precondition');
        error.name = 'PreconditionFailed';
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      this.objects.set(objectKey, {
        body: await streamToBuffer(input.Body),
        encryption: input.ServerSideEncryption,
      });
      return { ServerSideEncryption: input.ServerSideEncryption };
    }
    if (name === 'GetObjectCommand') {
      const stored = this.objects.get(objectKey);
      if (!stored) {
        const error = new Error('missing');
        error.name = 'NoSuchKey';
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return { Body: Readable.from(stored.body), ServerSideEncryption: stored.encryption };
    }
    throw new Error(`Unexpected S3 command ${name}`);
  }
}

function sampleSnapshot(overrides = {}) {
  return {
    DBSnapshotIdentifier: 'lgsv-backup-1',
    DBSnapshotArn: 'arn:aws:rds:ap-southeast-1:123456789012:snapshot:lgsv-backup-1',
    DBInstanceIdentifier: 'lgsv-production',
    SnapshotCreateTime: new Date('2026-07-12T12:00:00.000Z'),
    Engine: 'mysql',
    EngineVersion: '8.0.40',
    Port: 3306,
    Encrypted: true,
    KmsKeyId: 'arn:aws:kms:ap-southeast-1:123456789012:key/example',
    VpcId: 'vpc-123',
    StorageType: 'gp3',
    AllocatedStorage: 100,
    Status: 'available',
    PercentProgress: 100,
    ...overrides,
  };
}

class MemoryRdsClient {
  constructor() {
    this.snapshot = null;
    this.instances = new Map();
    this.commands = [];
  }

  async send(command) {
    const name = command.constructor.name;
    this.commands.push({ name, input: command.input });
    if (name === 'DescribeDBSnapshotsCommand') {
      if (!this.snapshot) {
        const error = new Error('missing');
        error.name = 'DBSnapshotNotFoundFault';
        throw error;
      }
      return { DBSnapshots: [this.snapshot] };
    }
    if (name === 'CreateDBSnapshotCommand') {
      this.snapshot = sampleSnapshot({ DBSnapshotIdentifier: command.input.DBSnapshotIdentifier });
      return { DBSnapshot: this.snapshot };
    }
    if (name === 'DescribeDBInstancesCommand') {
      const existing = this.instances.get(command.input.DBInstanceIdentifier);
      if (existing) return { DBInstances: [existing] };
      const error = new Error('missing');
      error.name = 'DBInstanceNotFoundFault';
      throw error;
    }
    if (name === 'RestoreDBInstanceFromDBSnapshotCommand') {
      const instance = {
        DBInstanceIdentifier: command.input.DBInstanceIdentifier,
        DBInstanceStatus: 'creating',
        DBSnapshotIdentifier: command.input.DBSnapshotIdentifier,
        Engine: 'mysql',
        StorageEncrypted: true,
        PubliclyAccessible: false,
        Endpoint: null,
      };
      this.instances.set(command.input.DBInstanceIdentifier, instance);
      return { DBInstance: instance };
    }
    throw new Error(`Unexpected RDS command ${name}`);
  }
}

function integrityExecutorFixture(rowCount = 2) {
  return {
    async execute(sql) {
      if (sql.includes('INFORMATION_SCHEMA.TABLES') && !sql.includes('COUNT(*)')) {
        return [[{ table_name: 'employees', engine: 'InnoDB', table_collation: 'utf8mb4_unicode_ci' }]];
      }
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
        return [[
          { table_name: 'employees', column_name: 'id', ordinal_position: 1, column_type: 'bigint', is_nullable: 'NO', column_default: null, column_key: 'PRI', extra: 'auto_increment', collation_name: null },
          { table_name: 'employees', column_name: 'name_encrypted', ordinal_position: 2, column_type: 'text', is_nullable: 'YES', column_default: null, column_key: '', extra: '', collation_name: 'utf8mb4_unicode_ci' },
        ]];
      }
      if (sql.startsWith('SELECT COUNT(*) AS row_count')) return [[{ row_count: rowCount }]];
      if (sql.startsWith('CHECK TABLE')) return [[{ Msg_type: 'status', Msg_text: 'OK' }]];
      throw new Error(`Unexpected integrity SQL: ${sql}`);
    },
  };
}

test('AES-256-GCM envelope hides plaintext, authenticates bytes, and decrypts correctly', async () => {
  const root = await temporaryDirectory('lgsv-envelope-');
  try {
    const source = path.join(root, 'source.sql');
    const encrypted = path.join(root, 'source.enc');
    const restored = path.join(root, 'restored.sql');
    await fs.promises.writeFile(source, 'sensitive payroll database contents', { mode: 0o600 });
    const result = await encryptFile(source, encrypted, ENCRYPTION_KEY, 'test-object');
    assert.strictEqual(result.algorithm, 'AES-256-GCM');
    assert.strictEqual((await fs.promises.readFile(encrypted)).includes(Buffer.from('sensitive payroll')), false);
    const hash = await hashDecryptedFile(encrypted, ENCRYPTION_KEY, 'test-object');
    assert.strictEqual(hash.sha256, crypto.createHash('sha256').update('sensitive payroll database contents').digest('hex'));
    await decryptFile(encrypted, restored, ENCRYPTION_KEY, 'test-object');
    assert.strictEqual(await fs.promises.readFile(restored, 'utf8'), 'sensitive payroll database contents');
    const tampered = await fs.promises.readFile(encrypted);
    tampered[Math.floor(tampered.length / 2)] ^= 1;
    await fs.promises.writeFile(encrypted, tampered);
    await expectCode(hashDecryptedFile(encrypted, ENCRYPTION_KEY, 'test-object'), 'BACKUP_DECRYPTION_FAILED');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('artifact SHA-256 changes whenever a directory payload changes', async () => {
  const root = await temporaryDirectory('lgsv-descriptor-');
  try {
    await fs.promises.writeFile(path.join(root, 'one.txt'), 'one');
    const before = await describeArtifact(root);
    await fs.promises.writeFile(path.join(root, 'one.txt'), 'two');
    const after = await describeArtifact(root);
    assert.notStrictEqual(before.checksum, after.checksum);
    assert.strictEqual(before.fileCount, 1);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('local adapter encrypts manifest and objects, verifies bytes, materializes, and enforces idempotency', async () => {
  const root = await temporaryDirectory('lgsv-local-adapter-');
  try {
    const source = path.join(root, 'source');
    await fs.promises.mkdir(source);
    await fs.promises.writeFile(path.join(source, 'database.sql'), 'confidential payroll row');
    const adapter = new LocalStorageAdapter({ rootPath: path.join(root, 'backups'), encryptionKey: ENCRYPTION_KEY });
    const stored = await adapter.storeArtifact({ artifactPath: source, backupReference: 'BACKUP-001' });
    assert.strictEqual(stored.provider, 'LOCAL');
    assert.strictEqual((await adapter.verifyStoredArtifact(stored.location, stored.descriptor.checksum)).valid, true);
    const storedNames = await fs.promises.readdir(path.join(root, 'backups', 'BACKUP-001'));
    assert.deepStrictEqual(storedNames.sort(), ['_lgsv_backup_manifest.enc', 'objects']);
    const encryptedObject = await fs.promises.readFile(path.join(root, 'backups', 'BACKUP-001', 'objects', '00000001.bin'));
    assert.strictEqual(encryptedObject.includes(Buffer.from('confidential payroll row')), false);
    const idempotent = await adapter.storeArtifact({ artifactPath: source, backupReference: 'BACKUP-001' });
    assert.strictEqual(idempotent.idempotent, true);
    const output = path.join(root, 'restore');
    await adapter.materializeArtifact({ location: stored.location, expectedChecksum: stored.descriptor.checksum, destinationRoot: output });
    assert.strictEqual(await fs.promises.readFile(path.join(output, 'payload', 'database.sql'), 'utf8'), 'confidential payroll row');
    await fs.promises.writeFile(path.join(source, 'database.sql'), 'different');
    await expectCode(adapter.storeArtifact({ artifactPath: source, backupReference: 'BACKUP-001' }), 'BACKUP_IDEMPOTENCY_CONFLICT');
    const objectPath = path.join(root, 'backups', 'BACKUP-001', 'objects', '00000001.bin');
    const objectBytes = await fs.promises.readFile(objectPath);
    objectBytes[20] ^= 1;
    await fs.promises.writeFile(objectPath, objectBytes);
    await expectCode(adapter.verifyStoredArtifact(stored.location, stored.descriptor.checksum), 'BACKUP_INTEGRITY_MISMATCH');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('local adapter fails closed when its 256-bit encryption key is missing', async () => {
  const root = await temporaryDirectory('lgsv-local-key-');
  try {
    const source = path.join(root, 'source.txt');
    await fs.promises.writeFile(source, 'secret');
    const adapter = new LocalStorageAdapter({ rootPath: path.join(root, 'backups') });
    await expectCode(adapter.storeArtifact({ artifactPath: source, backupReference: 'BACKUP-KEY' }), 'BACKUP_ENCRYPTION_KEY_MISSING');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('S3 adapter requires AES-256 server-side encryption and verifies downloaded object bytes', async () => {
  const root = await temporaryDirectory('lgsv-s3-adapter-');
  try {
    const source = path.join(root, 'source');
    await fs.promises.mkdir(source);
    await fs.promises.writeFile(path.join(source, 'a.enc'), 'already encrypted HR file');
    const client = new MemoryS3Client();
    const adapter = new S3StorageAdapter({ bucket: 'lgsv-hr-backups', prefix: 'production/backups', region: 'ap-southeast-1', client });
    const stored = await adapter.storeArtifact({ artifactPath: source, backupReference: 'BACKUP-S3-1' });
    assert(client.commands.filter(command => command.name === 'PutObjectCommand').every(command => command.input.ServerSideEncryption === 'AES256'));
    assert.strictEqual((await adapter.verifyStoredArtifact(stored.location, stored.descriptor.checksum)).valid, true);
    const output = path.join(root, 'restore');
    await adapter.materializeArtifact({ location: stored.location, expectedChecksum: stored.descriptor.checksum, destinationRoot: output });
    assert.strictEqual(await fs.promises.readFile(path.join(output, 'payload', 'a.enc'), 'utf8'), 'already encrypted HR file');
    const payloadKey = [...client.objects.keys()].find(key => key.includes('/objects/') && key.endsWith('/payload/a.enc'));
    client.objects.get(payloadKey).body[0] ^= 1;
    const verification = await adapter.verifyStoredArtifact(stored.location, stored.descriptor.checksum);
    assert.strictEqual(verification.valid, false);
    client.objects.get(payloadKey).encryption = undefined;
    await expectCode(adapter.verifyStoredArtifact(stored.location, stored.descriptor.checksum), 'S3_ENCRYPTION_REQUIRED');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('RDS adapter creates encrypted snapshots idempotently and only restores into a new prefixed instance', async () => {
  const client = new MemoryRdsClient();
  const adapter = new RdsSnapshotAdapter({
    region: 'ap-southeast-1',
    dbInstanceIdentifier: 'lgsv-production',
    client,
    snapshotWaiter: async () => ({ state: 'SUCCESS' }),
    instanceWaiter: async () => ({ state: 'SUCCESS' }),
  });
  const stored = await adapter.createDatabaseSnapshot({ backupReference: 'BACKUP-1' });
  assert.strictEqual(stored.descriptor.snapshot.encrypted, true);
  assert.strictEqual((await adapter.verifyStoredArtifact(stored.location, stored.descriptor.checksum)).valid, true);
  const repeated = await adapter.createDatabaseSnapshot({ backupReference: 'BACKUP-1' });
  assert.strictEqual(repeated.idempotent, true);
  await expectCode(adapter.restoreToNewInstance({
    location: stored.location,
    expectedChecksum: stored.descriptor.checksum,
    newDbInstanceIdentifier: 'lgsv-production',
    dbInstanceClass: 'db.t4g.small',
  }), 'RDS_IN_PLACE_RESTORE_BLOCKED');
  const restore = await adapter.restoreToNewInstance({
    location: stored.location,
    expectedChecksum: stored.descriptor.checksum,
    newDbInstanceIdentifier: 'lgsv-restore-20260712',
    dbInstanceClass: 'db.t4g.small',
  });
  assert.strictEqual(restore.inPlace, false);
  assert.strictEqual(restore.status, 'creating');
});

test('mysqldump uses execFile without shell interpolation or password arguments', async () => {
  const root = await temporaryDirectory('lgsv-mysqldump-');
  try {
    let captured;
    const service = new MySqlBackupService({
      workRoot: path.join(root, 'work'),
      captureSourceIntegrity: false,
      execFileRunner: async (file, args, options) => {
        captured = { file, args, options, optionFile: await fs.promises.readFile(args[0].split('=').slice(1).join('='), 'utf8') };
        const output = args.find(argument => argument.startsWith('--result-file=')).slice('--result-file='.length);
        await fs.promises.writeFile(output, '-- MySQL dump\nCREATE TABLE `employees` (`id` BIGINT);\n-- Dump completed\n');
        return { stdout: '', stderr: '' };
      },
    });
    const outputPath = path.join(root, 'database.sql');
    const result = await service.createDatabaseDump({
      outputPath,
      connection: { host: 'localhost', port: 3306, user: 'backup_user', password: 'never-on-command-line', database: 'lgsv_hr_db' },
    });
    assert.strictEqual(captured.file, 'mysqldump');
    assert.strictEqual(captured.options.shell, false);
    assert.strictEqual(captured.args.some(argument => argument.includes('never-on-command-line')), false);
    assert(captured.optionFile.includes('password="never-on-command-line"'));
    assert(/^[a-f0-9]{64}$/.test(result.checksum));
    assert.strictEqual(await fs.promises.access(captured.args[0].slice('--defaults-extra-file='.length)).then(() => true).catch(() => false), false);
    const unsafe = path.join(root, 'unsafe.sql');
    await fs.promises.writeFile(unsafe, '-- MySQL dump\nUSE `production`;\n');
    await expectCode(validateDumpSafety(unsafe), 'UNSAFE_MYSQL_DUMP');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('mysqldump retries without the MySQL GTID flag only for a MariaDB capability error', async () => {
  const root = await temporaryDirectory('lgsv-mariadb-dump-');
  try {
    const attempts = [];
    const service = new MySqlBackupService({
      workRoot: path.join(root, 'work'),
      captureSourceIntegrity: false,
      execFileRunner: async (_file, args) => {
        attempts.push([...args]);
        if (attempts.length === 1) {
          const error = new Error('unsupported client option');
          error.stderr = "mysqldump: unknown variable 'set-gtid-purged=OFF'";
          throw error;
        }
        const output = args.find(argument => argument.startsWith('--result-file=')).slice('--result-file='.length);
        await fs.promises.writeFile(output, '-- MySQL dump\nCREATE TABLE `employees` (`id` BIGINT);\n-- Dump completed\n');
        return { stdout: '', stderr: '' };
      },
    });
    const result = await service.createDatabaseDump({
      outputPath: path.join(root, 'database.sql'),
      connection: { host: 'localhost', port: 3306, user: 'backup_user', password: 'secret', database: 'lgsv_hr_db' },
    });
    assert.strictEqual(attempts.length, 2);
    assert(attempts[0].includes('--set-gtid-purged=OFF'));
    assert.strictEqual(attempts[1].includes('--set-gtid-purged=OFF'), false);
    assert(/^[a-f0-9]{64}$/.test(result.checksum));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('database integrity reports compare schema, row counts, and CHECK TABLE status', async () => {
  const expected = await createDatabaseIntegrityReport(integrityExecutorFixture(2), {
    databaseName: 'lgsv_hr_db', includeRowCounts: true, checkTables: true,
  });
  const actual = await createDatabaseIntegrityReport(integrityExecutorFixture(2), {
    databaseName: 'lgsv_restore_db', includeRowCounts: true, checkTables: true,
  });
  assert.strictEqual(compareIntegrityReports(expected, actual).valid, true);
  const changed = await createDatabaseIntegrityReport(integrityExecutorFixture(3), {
    databaseName: 'lgsv_restore_db', includeRowCounts: true, checkTables: true,
  });
  const mismatch = compareIntegrityReports(expected, changed);
  assert.strictEqual(mismatch.valid, false);
  assert.strictEqual(mismatch.rowCountMismatches[0].table, 'employees');
});

test('database dry-run creates and always drops an isolated scratch schema', async () => {
  const root = await temporaryDirectory('lgsv-dry-restore-');
  try {
    const dumpPath = path.join(root, 'database.sql');
    await fs.promises.writeFile(dumpPath, '-- MySQL dump\nCREATE TABLE `employees` (`id` BIGINT);\n-- Dump completed\n');
    const sql = [];
    const admin = {
      async execute(statement) {
        sql.push(statement);
        if (statement.startsWith('CREATE DATABASE') || statement.startsWith('DROP DATABASE')) return [{ affectedRows: 1 }];
        return integrityExecutorFixture(0).execute(statement);
      },
      async end() {},
    };
    const service = new MySqlBackupService({
      workRoot: path.join(root, 'work'),
      connectionFactory: async () => admin,
      execFileRunner: async () => ({ stdout: '', stderr: '' }),
      primaryConnection: { host: 'primary.example', port: 3306, user: 'u', password: 'p', database: 'lgsv_hr_db' },
      nodeEnv: 'production',
    });
    const result = await service.runDryRestore({
      dumpPath,
      restoreConnection: { host: 'restore-test.example', port: 3306, user: 'u', password: 'p' },
    });
    assert.strictEqual(result.safeToRestore, true);
    assert(sql.some(statement => statement.startsWith('CREATE DATABASE `lgsv_restore_')));
    assert(sql.some(statement => statement.startsWith('DROP DATABASE `lgsv_restore_')));
    await expectCode(service.runDryRestore({
      dumpPath,
      restoreConnection: { host: 'primary.example', port: 3306, user: 'u', password: 'p' },
    }), 'RESTORE_ISOLATION_REQUIRED');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('controlled database apply restores only to an empty explicit target and reports post-restore integrity', async () => {
  const root = await temporaryDirectory('lgsv-live-db-restore-');
  try {
    const dumpPath = path.join(root, 'database.sql');
    await fs.promises.writeFile(dumpPath, '-- MySQL dump\nCREATE TABLE `employees` (`id` BIGINT);\n-- Dump completed\n');
    const sql = [];
    const admin = {
      async execute(statement) {
        sql.push(statement);
        if (statement.includes('INFORMATION_SCHEMA.SCHEMATA')) return [[]];
        if (statement.startsWith('CREATE DATABASE') || statement.startsWith('DROP DATABASE')) return [{ affectedRows: 1 }];
        return integrityExecutorFixture(0).execute(statement);
      },
      async end() {},
    };
    const service = new MySqlBackupService({
      workRoot: path.join(root, 'work'),
      connectionFactory: async () => admin,
      execFileRunner: async () => ({ stdout: '', stderr: '' }),
    });
    const restored = await service.applyDatabaseRestore({
      dumpPath,
      targetConnection: { host: 'restore.example', port: 3306, user: 'restore', password: 'secret' },
      targetDatabaseName: 'lgsv_recovered',
      sourceDatabaseName: 'lgsv_hr_db',
    });
    assert.strictEqual(restored.restored, true);
    assert.strictEqual(restored.inPlace, false);
    assert(sql.includes('CREATE DATABASE `lgsv_recovered` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'));
    await expectCode(service.applyDatabaseRestore({
      dumpPath,
      targetConnection: { host: 'restore.example', port: 3306, user: 'restore', password: 'secret' },
      targetDatabaseName: 'lgsv_hr_db',
      sourceDatabaseName: 'lgsv_hr_db',
      allowInPlace: false,
    }), 'IN_PLACE_RESTORE_BLOCKED');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('runtime completes encrypted local backup, dry-run, controlled DB restore, and normalized integrity result', async () => {
  const root = await temporaryDirectory('lgsv-runtime-');
  try {
    let dumpCalls = 0;
    const fakeMysql = {
      async createDatabaseDump({ outputPath }) {
        dumpCalls += 1;
        await fs.promises.writeFile(outputPath, '-- MySQL dump\nCREATE TABLE `employees` (`id` BIGINT);\n-- Dump completed\n', { mode: 0o600 });
        return { dumpPath: outputPath, checksum: '0'.repeat(64), sizeBytes: 75, expectedIntegrity: null };
      },
      async runDryRestore() {
        return { safeToRestore: true, actualIntegrity: { schemaHash: '1'.repeat(64), allTablesHealthy: true }, comparison: { valid: true } };
      },
      async applyDatabaseRestore() {
        return { restored: true, actualIntegrity: { schemaHash: '1'.repeat(64), allTablesHealthy: true }, comparison: { valid: true } };
      },
    };
    const adapter = new LocalStorageAdapter({ rootPath: path.join(root, 'backups'), encryptionKey: ENCRYPTION_KEY });
    const builder = new BackupBundleBuilder({
      mysqlBackupService: fakeMysql,
      primaryConnection: { host: 'db', user: 'u', password: 'p', database: 'lgsv_hr_db' },
    });
    const runtime = new BackupRuntime({
      adapters: [adapter],
      mysqlBackupService: fakeMysql,
      bundleBuilder: builder,
      workRoot: path.join(root, 'work'),
      primaryConnection: { database: 'lgsv_hr_db' },
      dryRunConnection: { host: 'dry', user: 'u', password: 'p' },
      liveRestoreConnection: { host: 'target', user: 'u', password: 'p' },
      liveRestoreDatabaseName: 'lgsv_recovered',
      liveRestoreEnabled: true,
    });
    const backup = await runtime.createBackup({
      backupReference: 'RUNTIME-DB-1', backupType: 'DATABASE', storageProvider: 'LOCAL', includedModules: ['payroll'],
    });
    assert.strictEqual(backup.status, 'COMPLETED');
    const repeated = await runtime.createBackup({
      backupReference: 'RUNTIME-DB-1', backupType: 'DATABASE', storageProvider: 'LOCAL', includedModules: ['payroll'],
    });
    assert.strictEqual(repeated.idempotent, true);
    assert.strictEqual(dumpCalls, 1, 'Idempotent retries must not create a second database dump.');
    const dryRun = await runtime.runRestoreDryRun({
      backupReference: backup.backupReference,
      backupType: backup.backupType,
      storageProvider: backup.storageProvider,
      storageLocation: backup.storageLocation,
      expectedChecksum: backup.checksum,
    });
    assert.strictEqual(dryRun.safeToRestore, true);
    const restored = await runtime.applyRestore({
      backupReference: backup.backupReference,
      backupType: backup.backupType,
      storageProvider: backup.storageProvider,
      storageLocation: backup.storageLocation,
      expectedChecksum: backup.checksum,
    });
    assert.strictEqual(restored.restored, true);
    assert.strictEqual(restored.integrityPassed, true);
    assert.strictEqual(restored.restoredChecksum, backup.checksum);
    assert.strictEqual(restored.integrityReport.targetIntegrity.schemaHash, '1'.repeat(64));
    assert.strictEqual(restored.verified, true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('runtime normalizes RDS restore as initiated and pending post-restore verification', async () => {
  const root = await temporaryDirectory('lgsv-runtime-rds-');
  try {
    const client = new MemoryRdsClient();
    const adapter = new RdsSnapshotAdapter({
      region: 'ap-southeast-1',
      dbInstanceIdentifier: 'lgsv-production',
      client,
      snapshotWaiter: async () => ({ state: 'SUCCESS' }),
      instanceWaiter: async () => ({ state: 'SUCCESS' }),
    });
    const expectedDatabaseIntegrity = await createDatabaseIntegrityReport(integrityExecutorFixture(2), {
      databaseName: 'lgsv_hr_db', includeRowCounts: true, checkTables: true,
    });
    const fakeMysql = {
      async captureDatabaseIntegrity() { return expectedDatabaseIntegrity; },
    };
    const runtime = new BackupRuntime({
      adapters: [adapter],
      bundleBuilder: {},
      mysqlBackupService: fakeMysql,
      primaryConnection: { host: 'source', user: 'backup', password: 'secret', database: 'lgsv_hr_db' },
      workRoot: path.join(root, 'work'),
      liveRestoreEnabled: true,
      rdsRestoreOptions: { dbInstanceClass: 'db.t4g.small' },
      rdsVerificationConnection: { user: 'verify', password: 'secret', database: 'lgsv_hr_db' },
      captureRowCounts: true,
    });
    const backup = await runtime.createBackup({ backupReference: 'RDS-RUNTIME-1', backupType: 'DATABASE', storageProvider: 'RDS_SNAPSHOT' });
    const result = await runtime.applyRestore({
      backupReference: backup.backupReference,
      backupType: backup.backupType,
      storageProvider: backup.storageProvider,
      storageLocation: backup.storageLocation,
      expectedChecksum: backup.checksum,
      newRdsInstanceIdentifier: 'lgsv-restore-runtime-1',
    });
    assert.strictEqual(result.initiated, true);
    assert.strictEqual(result.restored, false);
    assert.strictEqual(result.integrityPassed, false);
    assert.strictEqual(result.pendingVerification, true);
    assert.strictEqual(result.verified, true);

    client.instances.set(result.newDbInstanceIdentifier, {
      ...client.instances.get(result.newDbInstanceIdentifier),
      DBInstanceStatus: 'available',
      StorageEncrypted: true,
      PubliclyAccessible: false,
      Endpoint: { Address: 'lgsv-restore.example.rds.amazonaws.com', Port: 3306 },
    });
    const verifiedTarget = await runtime.verifyPendingRestore({
      backupType: backup.backupType,
      storageProvider: backup.storageProvider,
      storageLocation: backup.storageLocation,
      expectedChecksum: backup.checksum,
      restoreTarget: result.newDbInstanceIdentifier,
      expectedIntegrity: backup.integrityReport,
    });
    assert.strictEqual(verifiedTarget.pendingVerification, false);
    assert.strictEqual(verifiedTarget.integrityPassed, true);
    assert.strictEqual(verifiedTarget.restoredChecksum, backup.checksum);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('configuration bundles reject .env and private-key sources', async () => {
  assert.throws(
    () => new BackupBundleBuilder({ configurationSources: [{ label: 'env', path: path.join(process.cwd(), '.env') }] }),
    error => error?.code === 'SENSITIVE_CONFIG_BACKUP_BLOCKED'
  );
  assert.throws(
    () => new BackupBundleBuilder({ configurationSources: [{ label: 'key', path: path.join(process.cwd(), 'server.key') }] }),
    error => error?.code === 'SENSITIVE_CONFIG_BACKUP_BLOCKED'
  );
});

test('runtime stages verified file/config recovery and blocks live restore by default', async () => {
  const root = await temporaryDirectory('lgsv-runtime-config-');
  try {
    const configPath = path.join(root, 'app-config.json');
    await fs.promises.writeFile(configPath, '{"feature":true}');
    const adapter = new LocalStorageAdapter({ rootPath: path.join(root, 'backups'), encryptionKey: ENCRYPTION_KEY });
    const builder = new BackupBundleBuilder({ configurationSources: [{ label: 'app-config.json', path: configPath }] });
    const disabled = new BackupRuntime({ adapters: [adapter], bundleBuilder: builder, workRoot: path.join(root, 'work-disabled') });
    const backup = await disabled.createBackup({ backupReference: 'CONFIG-1', backupType: 'CONFIGURATION', storageProvider: 'LOCAL' });
    await expectCode(disabled.applyRestore({
      backupReference: 'CONFIG-1', backupType: 'CONFIGURATION', storageProvider: 'LOCAL', storageLocation: backup.storageLocation, expectedChecksum: backup.checksum,
    }), 'LIVE_RESTORE_DISABLED');
    const enabled = new BackupRuntime({
      adapters: [adapter],
      bundleBuilder: builder,
      workRoot: path.join(root, 'work-enabled'),
      restoreOutputRoot: path.join(root, 'recovered'),
      liveRestoreEnabled: true,
    });
    const result = await enabled.applyRestore({
      backupReference: 'CONFIG-1', backupType: 'CONFIGURATION', storageProvider: 'LOCAL', storageLocation: backup.storageLocation, expectedChecksum: backup.checksum,
    });
    assert.strictEqual(result.restored, true);
    assert.strictEqual(result.integrityPassed, true);
    assert.strictEqual(result.recoveredComponents.requiresCutover, true);
    assert.strictEqual(await fs.promises.readFile(path.join(result.recoveredComponents.recoveryOutputLocation, 'configuration', 'files', 'app-config.json'), 'utf8'), '{"feature":true}');
    const repeated = await enabled.applyRestore({
      backupReference: 'CONFIG-1', backupType: 'CONFIGURATION', storageProvider: 'LOCAL', storageLocation: backup.storageLocation, expectedChecksum: backup.checksum,
    });
    assert.strictEqual(repeated.recoveredComponents.idempotent, true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('backup worker stops at COMPLETED until the API-authorized administrator verifies it', async () => {
  const transitions = [];
  const worker = new BackupWorker({
    runtime: {
      async createBackup() {
        return { status: 'COMPLETED', storageLocation: 'local-backup:///WORKER-1', checksum: 'a'.repeat(64), fileSize: 100 };
      },
    },
    repository: {
      async transitionBackup(transition) {
        transitions.push(transition);
        return true;
      },
    },
  });
  const result = await worker.execute({
    backupSet: { id: 1, status: 'PENDING', backup_reference: 'WORKER-1', backup_type: 'DATABASE', storage_provider: 'LOCAL' },
  });
  assert.strictEqual(result.status, 'COMPLETED');
  assert.strictEqual(result.administratorVerificationRequired, true);
  assert.deepStrictEqual(transitions.map(item => `${item.expectedStatus}->${item.status}`), [
    'PENDING->RUNNING', 'RUNNING->COMPLETED',
  ]);
});

(async () => {
  for (const entry of tests) {
    await entry.callback();
    console.log(`PASS: ${entry.name}`);
  }
  console.log(`Backup runtime tests passed (${tests.length}).`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
