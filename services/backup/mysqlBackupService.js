'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');
const mysql = require('mysql2/promise');
const { sha256File } = require('./artifactIntegrity');
const { backupError, safeProcessError } = require('./backupErrors');
const { compareIntegrityReports, createDatabaseIntegrityReport, validateDatabaseIdentifier } = require('./databaseIntegrity');
const { secureRemoveTemporaryTree } = require('./fileTree');

const DEFAULT_TOOL_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_DUMP_BYTES = 20 * 1024 * 1024 * 1024;

function defaultExecFileRunner(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function cleanProcessEnvironment() {
  const environment = { ...process.env };
  delete environment.MYSQL_PWD;
  delete environment.MYSQL_TEST_LOGIN_FILE;
  return environment;
}

function validateConnectionConfig(input, options = {}) {
  const config = input && typeof input === 'object' ? input : {};
  const required = ['host', 'user', 'password'];
  for (const key of required) {
    if (!String(config[key] ?? '').trim()) {
      throw backupError(`MySQL ${key} is required for backup operations.`, 'MYSQL_BACKUP_CONFIG_MISSING');
    }
  }
  const port = Number(config.port || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw backupError('MySQL port is invalid.', 'MYSQL_BACKUP_CONFIG_INVALID');
  }
  const database = options.databaseRequired === false && !config.database
    ? null
    : validateDatabaseIdentifier(config.database, 'MySQL database name');
  return {
    ...config,
    host: String(config.host).trim(),
    port,
    user: String(config.user).trim(),
    password: String(config.password),
    database,
  };
}

function quoteOptionFileValue(value) {
  const text = String(value ?? '');
  if (/[\r\n\0]/.test(text)) {
    throw backupError('MySQL backup configuration contains invalid control characters.', 'MYSQL_BACKUP_CONFIG_INVALID');
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function mysqlOptionFile(config, databaseOverride = undefined) {
  const normalized = validateConnectionConfig(
    { ...config, database: databaseOverride === undefined ? config.database : databaseOverride },
    { databaseRequired: databaseOverride !== null }
  );
  const lines = [
    '[client]',
    `host=${quoteOptionFileValue(normalized.host)}`,
    `port=${normalized.port}`,
    `user=${quoteOptionFileValue(normalized.user)}`,
    `password=${quoteOptionFileValue(normalized.password)}`,
    'protocol=tcp',
    'default-character-set=utf8mb4',
  ];
  const sslEnabled = normalized.sslEnabled === true || Boolean(normalized.ssl);
  if (sslEnabled) {
    lines.push(`ssl-mode=${normalized.sslRejectUnauthorized === false ? 'REQUIRED' : 'VERIFY_IDENTITY'}`);
    if (normalized.sslCaPath) lines.push(`ssl-ca=${quoteOptionFileValue(path.resolve(normalized.sslCaPath))}`);
    if (normalized.sslCertPath) lines.push(`ssl-cert=${quoteOptionFileValue(path.resolve(normalized.sslCertPath))}`);
    if (normalized.sslKeyPath) lines.push(`ssl-key=${quoteOptionFileValue(path.resolve(normalized.sslKeyPath))}`);
  }
  if (normalized.database) lines.push(`database=${quoteOptionFileValue(normalized.database)}`);
  return `${lines.join('\n')}\n`;
}

async function validateDumpSafety(dumpPath, options = {}) {
  const resolved = path.resolve(dumpPath);
  const stat = await fs.promises.lstat(resolved).catch(error => {
    if (error.code === 'ENOENT') throw backupError('MySQL dump artifact is missing.', 'MYSQL_DUMP_MISSING');
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw backupError('MySQL dump artifact is empty or invalid.', 'INVALID_MYSQL_DUMP');
  }
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_DUMP_BYTES);
  if (stat.size > maxBytes) {
    throw backupError('MySQL dump exceeds the configured restore size limit.', 'BACKUP_SIZE_LIMIT_EXCEEDED');
  }
  const prohibited = [
    /^(?:CREATE|DROP|ALTER)\s+DATABASE\b/i,
    /^USE\s+/i,
    /^(?:CREATE|ALTER|DROP)\s+USER\b/i,
    /^(?:GRANT|REVOKE)\s+/i,
    /^SET\s+(?:@@)?GLOBAL\b/i,
    /^(?:INSTALL|UNINSTALL)\s+PLUGIN\b/i,
    /^(?:SHUTDOWN|SYSTEM|SOURCE|\\!)\b/i,
    /^LOAD\s+DATA\s+(?:LOCAL\s+)?INFILE\b/i,
  ];
  let linesRead = 0;
  const reader = readline.createInterface({
    input: fs.createReadStream(resolved, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const rawLine of reader) {
    linesRead += 1;
    const line = rawLine
      .trim()
      .replace(/^\/\*![0-9]{5,6}\s*/, '')
      .replace(/\*\/;?\s*$/, '')
      .trim();
    if (!line || line.startsWith('--') || line.startsWith('#')) continue;
    if (prohibited.some(pattern => pattern.test(line))) {
      throw backupError('MySQL dump contains a statement that is unsafe for controlled restore.', 'UNSAFE_MYSQL_DUMP');
    }
  }
  if (!linesRead) throw backupError('MySQL dump artifact is empty.', 'INVALID_MYSQL_DUMP');
  return { valid: true, sizeBytes: stat.size };
}

function mysql2ConnectionOptions(config, databaseOverride = undefined) {
  const normalized = validateConnectionConfig(
    { ...config, database: databaseOverride === undefined ? config.database : databaseOverride },
    { databaseRequired: false }
  );
  const ssl = normalized.ssl || (normalized.sslEnabled
    ? {
        ca: normalized.sslCaPath ? fs.readFileSync(normalized.sslCaPath) : undefined,
        cert: normalized.sslCertPath ? fs.readFileSync(normalized.sslCertPath) : undefined,
        key: normalized.sslKeyPath ? fs.readFileSync(normalized.sslKeyPath) : undefined,
        rejectUnauthorized: normalized.sslRejectUnauthorized !== false,
        minVersion: 'TLSv1.3',
      }
    : undefined);
  return {
    host: normalized.host,
    port: normalized.port,
    user: normalized.user,
    password: normalized.password,
    database: normalized.database || undefined,
    ssl,
    timezone: normalized.timezone || '+08:00',
  };
}

class MySqlBackupService {
  constructor(options = {}) {
    this.mysqldumpPath = String(options.mysqldumpPath || 'mysqldump');
    this.mysqlPath = String(options.mysqlPath || 'mysql');
    this.workRoot = path.resolve(options.workRoot || path.join(os.tmpdir(), 'lgsv-hr-backup-work'));
    this.execFileRunner = options.execFileRunner || defaultExecFileRunner;
    this.connectionFactory = options.connectionFactory || (config => mysql.createConnection(config));
    this.toolTimeoutMs = Math.max(1000, Number(options.toolTimeoutMs || DEFAULT_TOOL_TIMEOUT_MS));
    this.maxDumpBytes = Math.max(1024, Number(options.maxDumpBytes || DEFAULT_MAX_DUMP_BYTES));
    this.nodeEnv = String(options.nodeEnv || process.env.NODE_ENV || 'development').toLowerCase();
    this.primaryConnection = options.primaryConnection || null;
    this.allowSameServerDryRun = Boolean(options.allowSameServerDryRun);
  }

  async initialize() {
    await fs.promises.mkdir(this.workRoot, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(this.workRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw backupError('MySQL backup work root is unsafe.', 'UNSAFE_BACKUP_WORKSPACE');
    }
    await fs.promises.chmod(this.workRoot, 0o700).catch(() => {});
  }

  async createDefaultsFile(connection, databaseOverride = undefined) {
    await this.initialize();
    const directory = await fs.promises.mkdtemp(path.join(this.workRoot, '.mysql-client-'));
    const filePath = path.join(directory, 'client.cnf');
    await fs.promises.writeFile(filePath, mysqlOptionFile(connection, databaseOverride), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    return {
      filePath,
      cleanup: () => secureRemoveTemporaryTree(this.workRoot, directory),
    };
  }

  processOptions(cwd) {
    return {
      cwd,
      env: cleanProcessEnvironment(),
      timeout: this.toolTimeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      shell: false,
    };
  }

  async createDatabaseDump({ outputPath, connection, integrityExecutor = null, includeRowCounts = false }) {
    const normalized = validateConnectionConfig(connection);
    const resolvedOutput = path.resolve(outputPath);
    await fs.promises.mkdir(path.dirname(resolvedOutput), { recursive: true, mode: 0o700 });
    const parentStat = await fs.promises.lstat(path.dirname(resolvedOutput));
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw backupError('MySQL dump destination is unsafe.', 'UNSAFE_BACKUP_WORKSPACE');
    }
    if (await fs.promises.lstat(resolvedOutput).then(() => true).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error))) {
      throw backupError('MySQL dump destination already exists.', 'BACKUP_OUTPUT_EXISTS');
    }
    const expectedIntegrity = integrityExecutor
      ? await createDatabaseIntegrityReport(integrityExecutor, {
          databaseName: normalized.database,
          includeRowCounts,
          checkTables: true,
        })
      : null;
    const defaults = await this.createDefaultsFile(normalized, null);
    try {
      const args = [
        `--defaults-extra-file=${defaults.filePath}`,
        '--single-transaction',
        '--quick',
        '--routines',
        '--triggers',
        '--events',
        '--hex-blob',
        '--set-gtid-purged=OFF',
        '--default-character-set=utf8mb4',
        '--no-tablespaces',
        '--skip-extended-insert',
        '--add-drop-table',
        '--skip-add-locks',
        `--result-file=${resolvedOutput}`,
        normalized.database,
      ];
      try {
        await this.execFileRunner(this.mysqldumpPath, args, this.processOptions(path.dirname(resolvedOutput)));
      } catch (error) {
        await fs.promises.rm(resolvedOutput, { force: true }).catch(() => {});
        throw safeProcessError(error, 'MySQL backup');
      }
      const safety = await validateDumpSafety(resolvedOutput, { maxBytes: this.maxDumpBytes });
      return {
        dumpPath: resolvedOutput,
        checksum: await sha256File(resolvedOutput),
        sizeBytes: safety.sizeBytes,
        expectedIntegrity,
      };
    } finally {
      await defaults.cleanup().catch(() => {});
    }
  }

  async importDump({ dumpPath, connection, targetDatabaseName }) {
    const target = validateDatabaseIdentifier(targetDatabaseName, 'restore target database');
    const resolvedDump = path.resolve(dumpPath);
    await validateDumpSafety(resolvedDump, { maxBytes: this.maxDumpBytes });
    const defaults = await this.createDefaultsFile(connection, target);
    try {
      // SOURCE is interpreted by the mysql client, not by a shell. The path is
      // resolved by this service and control characters are rejected above.
      const sourcePath = resolvedDump.replace(/\\/g, '/');
      if (/[\r\n\0]/.test(sourcePath)) {
        throw backupError('MySQL dump path is unsafe.', 'UNSAFE_BACKUP_PATH');
      }
      const args = [
        `--defaults-extra-file=${defaults.filePath}`,
        '--binary-mode',
        '--default-character-set=utf8mb4',
        `--database=${target}`,
        `--execute=source ${sourcePath}`,
      ];
      try {
        await this.execFileRunner(this.mysqlPath, args, this.processOptions(path.dirname(resolvedDump)));
      } catch (error) {
        throw safeProcessError(error, 'MySQL restore');
      }
    } finally {
      await defaults.cleanup().catch(() => {});
    }
  }

  assertDryRunIsolation(restoreConnection) {
    if (this.nodeEnv !== 'production' || this.allowSameServerDryRun || !this.primaryConnection) return;
    const primary = validateConnectionConfig(this.primaryConnection);
    const restore = validateConnectionConfig(restoreConnection, { databaseRequired: false });
    if (primary.host.toLowerCase() === restore.host.toLowerCase() && primary.port === restore.port) {
      throw backupError('Production restore dry-runs require a separate MySQL host.', 'RESTORE_ISOLATION_REQUIRED');
    }
  }

  scratchDatabaseName() {
    return `lgsv_restore_${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 63);
  }

  async runDryRestore({ dumpPath, restoreConnection, expectedIntegrity = null }) {
    this.assertDryRunIsolation(restoreConnection);
    const normalized = validateConnectionConfig(restoreConnection, { databaseRequired: false });
    const scratchDatabase = this.scratchDatabaseName();
    const admin = await this.connectionFactory(mysql2ConnectionOptions(normalized, null));
    let created = false;
    try {
      // The identifier is generated entirely by this service and constrained by
      // validateDatabaseIdentifier; values remain parameterized everywhere else.
      validateDatabaseIdentifier(scratchDatabase, 'scratch database');
      await admin.execute(`CREATE DATABASE \`${scratchDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      created = true;
      await this.importDump({ dumpPath, connection: normalized, targetDatabaseName: scratchDatabase });
      const actualIntegrity = await createDatabaseIntegrityReport(admin, {
        databaseName: scratchDatabase,
        includeRowCounts: Boolean(expectedIntegrity?.rowCounts),
        checkTables: true,
      });
      const comparison = expectedIntegrity
        ? compareIntegrityReports(expectedIntegrity, actualIntegrity)
        : { valid: actualIntegrity.allTablesHealthy, schemaMatches: null, rowCountsMatch: null };
      return {
        safeToRestore: Boolean(comparison.valid),
        isolated: true,
        scratchDatabase,
        actualIntegrity,
        comparison,
      };
    } finally {
      if (created) {
        await admin.execute(`DROP DATABASE \`${scratchDatabase}\``).catch(() => {});
      }
      await admin.end?.().catch(() => {});
    }
  }

  async applyDatabaseRestore({
    dumpPath,
    targetConnection,
    targetDatabaseName,
    sourceDatabaseName,
    expectedIntegrity = null,
    allowInPlace = false,
  }) {
    const normalized = validateConnectionConfig(targetConnection, { databaseRequired: false });
    const target = validateDatabaseIdentifier(targetDatabaseName, 'restore target database');
    const source = validateDatabaseIdentifier(sourceDatabaseName, 'source database');
    const inPlace = target.toLowerCase() === source.toLowerCase();
    if (inPlace && !allowInPlace) {
      throw backupError('In-place database restore is disabled.', 'IN_PLACE_RESTORE_BLOCKED');
    }
    await validateDumpSafety(dumpPath, { maxBytes: this.maxDumpBytes });
    const admin = await this.connectionFactory(mysql2ConnectionOptions(normalized, null));
    let createdHere = false;
    try {
      const [schemaRows] = await admin.execute(
        'SELECT SCHEMA_NAME AS schema_name FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
        [target]
      );
      if (!schemaRows.length) {
        await admin.execute(`CREATE DATABASE \`${target}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        createdHere = true;
      } else if (!inPlace) {
        const [tableRows] = await admin.execute(
          'SELECT COUNT(*) AS table_count FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?',
          [target]
        );
        if (Number(tableRows[0]?.table_count || 0) > 0) {
          throw backupError('Restore target database must be empty.', 'RESTORE_TARGET_NOT_EMPTY');
        }
      }
      await this.importDump({ dumpPath, connection: normalized, targetDatabaseName: target });
      const actualIntegrity = await createDatabaseIntegrityReport(admin, {
        databaseName: target,
        includeRowCounts: Boolean(expectedIntegrity?.rowCounts),
        checkTables: true,
      });
      const comparison = expectedIntegrity
        ? compareIntegrityReports(expectedIntegrity, actualIntegrity)
        : { valid: actualIntegrity.allTablesHealthy, schemaMatches: null, rowCountsMatch: null };
      if (!comparison.valid && createdHere) {
        await admin.execute(`DROP DATABASE \`${target}\``);
        createdHere = false;
      }
      return {
        restored: Boolean(comparison.valid),
        targetDatabase: target,
        inPlace,
        actualIntegrity,
        comparison,
      };
    } catch (error) {
      if (createdHere) await admin.execute(`DROP DATABASE \`${target}\``).catch(() => {});
      throw error;
    } finally {
      await admin.end?.().catch(() => {});
    }
  }
}

module.exports = {
  MySqlBackupService,
  cleanProcessEnvironment,
  defaultExecFileRunner,
  mysql2ConnectionOptions,
  mysqlOptionFile,
  quoteOptionFileValue,
  validateConnectionConfig,
  validateDumpSafety,
};
