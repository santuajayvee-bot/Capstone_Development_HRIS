'use strict';

const fs = require('fs');
const path = require('path');
const { backupError } = require('./backupErrors');
const { copyRegularTree, createBudget, safeLabel } = require('./fileTree');

const SENSITIVE_CONFIG_FILE = /(^|[\\/])\.env(?:\.|$)|\.(?:pem|key|p12|pfx|jks)$|(^|[\\/])(?:id_rsa|credentials)(?:$|[.\\/])/i;
const SENSITIVE_STATE_KEY = /(^|_)(?:password|secret|token|private_key|credential|connection_string|bank_account|pii)(_|$)/i;
const SAFE_RUNTIME_ENV_KEYS = [
  'APP_VERSION',
  'DB_TIME_ZONE',
  'MFA_ENABLED',
  'MFA_REQUIRE_ALL_USERS',
  'FABRIC_ENABLED',
  'SYSTEM_HEALTH_AUTO_CHECK_ENABLED',
  'SYSTEM_HEALTH_INTERVAL_MINUTES',
  'AWS_TLS_TERMINATED_AT_LOAD_BALANCER',
];

function normalizeSourceDefinitions(sources, options = {}) {
  const usedLabels = new Set();
  return (Array.isArray(sources) ? sources : []).map((source, index) => {
    const sourcePath = path.resolve(typeof source === 'string' ? source : source?.path || '');
    const label = safeLabel(typeof source === 'string' ? path.basename(sourcePath) : source?.label, `source-${index + 1}`);
    if (usedLabels.has(label)) throw backupError('Backup source labels must be unique.', 'DUPLICATE_BACKUP_SOURCE_LABEL');
    usedLabels.add(label);
    if (options.rejectSensitiveConfig && SENSITIVE_CONFIG_FILE.test(sourcePath)) {
      throw backupError('Secret-bearing configuration files cannot be copied into backups.', 'SENSITIVE_CONFIG_BACKUP_BLOCKED');
    }
    return { label, path: sourcePath };
  });
}

function redactSensitiveState(value, depth = 0) {
  if (depth > 12) return '[MAX_DEPTH]';
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 10000).map(item => redactSensitiveState(item, depth + 1));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value).slice(0, 10000)) {
      result[key] = SENSITIVE_STATE_KEY.test(key) ? '[REDACTED]' : redactSensitiveState(nested, depth + 1);
    }
    return result;
  }
  return String(value);
}

async function writePrivateJson(filePath, value) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(json, 'utf8') > 5 * 1024 * 1024) {
    throw backupError('Backup metadata or module state is too large.', 'BACKUP_METADATA_TOO_LARGE');
  }
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(filePath, json, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function captureSafeRuntimeConfiguration(environment = process.env) {
  return SAFE_RUNTIME_ENV_KEYS.reduce((result, key) => {
    if (environment[key] !== undefined && String(environment[key]).trim() !== '') {
      result[key] = String(environment[key]).trim().slice(0, 200);
    }
    return result;
  }, {});
}

class BackupBundleBuilder {
  constructor(options = {}) {
    this.mysqlBackupService = options.mysqlBackupService;
    this.primaryConnection = options.primaryConnection || null;
    this.integrityExecutor = options.integrityExecutor || null;
    this.fileSources = normalizeSourceDefinitions(options.fileSources);
    this.configurationSources = normalizeSourceDefinitions(options.configurationSources, { rejectSensitiveConfig: true });
    this.moduleStateProvider = options.moduleStateProvider || (async context => ({
      modules: context.includedModules,
      appVersion: context.appVersion,
      deploymentCommit: context.deploymentCommit,
    }));
    this.includeRowCounts = Boolean(options.includeRowCounts);
    this.maxFiles = options.maxFiles;
    this.maxBytes = options.maxBytes;
    this.environment = options.environment || process.env;
    this.moduleCodeService = options.moduleCodeService || null;
  }

  async copySources(sources, destinationRoot, budget) {
    if (!sources.length) throw backupError('No backup sources are configured for this artifact type.', 'BACKUP_SOURCE_MISSING');
    for (const source of sources) {
      await copyRegularTree(source.path, path.join(destinationRoot, source.label), {
        budget,
        maxFiles: this.maxFiles,
        maxBytes: this.maxBytes,
      });
    }
  }

  async addDatabase(bundlePath) {
    if (!this.mysqlBackupService || !this.primaryConnection) {
      throw backupError('MySQL backup service is not configured.', 'MYSQL_BACKUP_CONFIG_MISSING');
    }
    const databaseDirectory = path.join(bundlePath, 'database');
    await fs.promises.mkdir(databaseDirectory, { recursive: true, mode: 0o700 });
    const dumpResult = await this.mysqlBackupService.createDatabaseDump({
      outputPath: path.join(databaseDirectory, 'database.sql'),
      connection: this.primaryConnection,
      integrityExecutor: this.integrityExecutor,
      includeRowCounts: this.includeRowCounts,
    });
    if (dumpResult.expectedIntegrity) {
      await writePrivateJson(path.join(databaseDirectory, 'integrity.json'), dumpResult.expectedIntegrity);
    }
    return dumpResult;
  }

  async addFiles(bundlePath, budget) {
    await this.copySources(this.fileSources, path.join(bundlePath, 'files'), budget);
  }

  async addConfiguration(bundlePath, budget) {
    const configurationDirectory = path.join(bundlePath, 'configuration');
    if (this.configurationSources.length) {
      await this.copySources(this.configurationSources, path.join(configurationDirectory, 'files'), budget);
    }
    await writePrivateJson(
      path.join(configurationDirectory, 'runtime.json'),
      captureSafeRuntimeConfiguration(this.environment)
    );
  }

  async addModuleState(bundlePath, context) {
    const state = redactSensitiveState(await this.moduleStateProvider(context));
    await writePrivateJson(path.join(bundlePath, 'module-state', 'state.json'), state);
  }

  async addSourceCode(bundlePath, context) {
    if (!this.moduleCodeService) {
      throw backupError('Module source-code backup service is not configured.', 'MODULE_CODE_BACKUP_NOT_CONFIGURED');
    }
    return this.moduleCodeService.capture({
      destinationRoot: path.join(bundlePath, 'source-code'),
      includedModules: context.includedModules,
      appVersion: context.appVersion,
      deploymentCommit: context.deploymentCommit,
    });
  }

  async build({ bundlePath, backupReference, backupType, includedModules, appVersion, deploymentCommit }) {
    await fs.promises.mkdir(bundlePath, { recursive: true, mode: 0o700 });
    const context = { backupReference, backupType, includedModules, appVersion, deploymentCommit };
    const budget = createBudget({ maxFiles: this.maxFiles, maxBytes: this.maxBytes });
    const includesDatabase = ['DATABASE', 'FULL_BACKUP'].includes(backupType);
    const includesFiles = ['FILES', 'FULL_BACKUP'].includes(backupType);
    const includesConfiguration = ['CONFIGURATION', 'FULL_BACKUP'].includes(backupType);
    const includesModuleState = ['MODULE_STATE', 'DEPLOYMENT_VERSION', 'FULL_BACKUP'].includes(backupType);
    const includesSourceCode = ['DEPLOYMENT_VERSION', 'FULL_BACKUP'].includes(backupType);
    const database = includesDatabase ? await this.addDatabase(bundlePath) : null;
    if (includesFiles) await this.addFiles(bundlePath, budget);
    if (includesConfiguration) await this.addConfiguration(bundlePath, budget);
    if (includesModuleState) await this.addModuleState(bundlePath, context);
    const sourceCode = includesSourceCode ? await this.addSourceCode(bundlePath, context) : null;
    await writePrivateJson(path.join(bundlePath, 'lgsv-backup.json'), {
      formatVersion: 1,
      backupReference,
      backupType,
      includedModules,
      capturedAt: new Date().toISOString(),
      appVersion,
      deploymentCommit,
      components: {
        database: includesDatabase,
        files: includesFiles,
        configuration: includesConfiguration,
        moduleState: includesModuleState,
        sourceCode: includesSourceCode,
      },
      databaseIntegrityCaptured: Boolean(database?.expectedIntegrity),
    });
    return {
      database,
      sourceCode,
      components: {
        database: includesDatabase,
        files: includesFiles,
        configuration: includesConfiguration,
        moduleState: includesModuleState,
        sourceCode: includesSourceCode,
      },
    };
  }
}

module.exports = {
  BackupBundleBuilder,
  SAFE_RUNTIME_ENV_KEYS,
  captureSafeRuntimeConfiguration,
  normalizeSourceDefinitions,
  redactSensitiveState,
  writePrivateJson,
};
