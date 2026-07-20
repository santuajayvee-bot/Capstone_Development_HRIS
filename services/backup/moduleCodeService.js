'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { sha256File } = require('./artifactIntegrity');
const { backupError } = require('./backupErrors');
const {
  assertSafeBackupReference,
  isInside,
  normalizeRelativePath,
  removeTemporaryTree,
  resolveInside,
} = require('./fileTree');

const SOURCE_MANIFEST_NAME = 'source-manifest.json';
const SOURCE_TREE_NAME = 'tree';
const SOURCE_FORMAT_VERSION = 1;
const DEFAULT_MAX_SOURCE_FILES = 15000;
const DEFAULT_MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
const SAFE_SOURCE_EXTENSIONS = new Set(['.js', '.json', '.html', '.css', '.svg', '.png', '.ico']);
const FORBIDDEN_SOURCE_PATH = /(^|\/)(?:\.env(?:\.|$)|\.git|node_modules|secure_uploads|uploads|artifacts|scratch|backups|restored-artifacts)(?:\/|$)|\.(?:pem|key|p12|pfx|jks)$/i;

// These are repository-owned paths only. Client input can select a module key,
// but it can never supply or expand filesystem paths used for code recovery.
const DEFAULT_MODULE_SOURCE_MAP = Object.freeze({
  authentication: [
    'server/auth.js', 'server/trusted-devices.js', 'server/middleware.js',
    'server/middleware/encryptedCommunication.js', 'routes/authRoutes.js',
    'controllers/authController.js', 'db/authQueries.js', 'services/mfaService.js',
    'services/passwordService.js', 'services/recaptchaService.js', 'services/tokenService.js',
    'services/trustedDeviceService.js', 'public/js/auth.js', 'public/js/login.js',
    'public/js/register.js', 'public/js/device-fingerprint.js', 'public/js/security-utils.js',
    'public/css/auth.css', 'public/css/login.css', 'public/pages/register.html',
  ],
  account_management: [
    'server/account-creation-requests.js', 'routes/accountRoutes.js',
    'controllers/accountController.js', 'controllers/accountCreationRequestController.js',
    'services/accountCreationRequestService.js', 'services/accountPasswordService.js',
    'public/js/register.js', 'public/js/system-admin.js', 'public/pages/register.html',
    'public/pages/system-admin.html', 'public/css/system-admin.css',
  ],
  rbac: [
    'server/admin-rbac.js', 'server/middleware.js', 'server/middleware/authorize-level.js',
    'public/js/system-admin.js', 'public/pages/system-admin.html', 'public/css/system-admin.css',
  ],
  employee_201: [
    'server/201-file-management.js', 'server/encrypted-file-vault.js',
    'server/data-protection.js', 'server/privacy-protection.js', 'public/js/201file.js',
    'public/js/employees.js', 'public/pages/201file.html', 'public/pages/employees.html',
    'public/pages/employee-profile.html', 'public/css/employees.css',
  ],
  organization_setup: [
    'server.js', 'public/pages/organization-setup.html', 'public/js/employees.js',
    'public/pages/employees.html', 'public/css/employees.css',
  ],
  onboarding: [
    'server/onboarding.js', 'public/js/onboarding.js', 'public/js/recruitment.js',
    'public/pages/onboarding.html', 'public/pages/recruitment.html',
    'public/css/recruitment.css',
  ],
  attendance: [
    'server/attendance.js', 'server/attendance-absence.js', 'server/attendance-policy-engine.js',
    'server/attendance-rate-limits.js', 'server/attendance-service.js', 'server/dtr-punch.js',
    'server/tardiness-policy.js', 'public/js/attendance.js', 'public/js/attendance-realtime.js',
    'public/pages/attendance.html', 'public/css/attendance.css',
  ],
  attendance_sync: [
    'server/biometric.js', 'server/attendance-service.js', 'public/attendance-station.html',
    'public/js/attendance-realtime.js', 'public/pages/attendance.html', 'public/css/attendance.css',
  ],
  leave: [
    'server.js', 'public/js/leave.js', 'public/pages/leave.html', 'public/css/leave.css',
  ],
  performance: [
    'server.js', 'server/performance-management.js', 'public/js/performance.js',
    'public/pages/performance.html', 'public/css/performance.css',
    'migrations/20260718110000-performance-management.js',
  ],
  operational_logs: [
    'server.js', 'public/js/logistics-payroll.js', 'public/js/payroll.js',
    'public/pages/payroll.html', 'public/css/main.css',
  ],
  payroll_settings: [
    'server/payroll.js', 'server/employee-payroll-policy.js', 'public/js/payroll-compensation.js',
    'public/js/salary-calculation.js', 'public/pages/payroll-compensation.html',
    'public/pages/salary-calculation.html',
  ],
  payroll: [
    'server/payroll.js', 'server/payroll-attendance-deductions.js', 'server/payroll-rate-limits.js',
    'server/employee-payroll-policy.js', 'server/statutory-percentage-deduction.js',
    'server/utils/payrollHash.js', 'server/utils/payrollSchedule.js', 'public/js/payroll.js',
    'public/js/logistics-payroll.js', 'public/js/payroll-compensation.js',
    'public/js/salary-calculation.js', 'public/pages/payroll.html',
    'public/pages/payroll-compensation.html', 'public/pages/salary-calculation.html',
  ],
  payroll_approval: [
    'server/payroll.js', 'server/utils/payrollHash.js', 'public/js/payroll.js',
    'public/pages/payroll.html',
  ],
  payslip: [
    'server/payroll.js', 'server/employee-dashboard.js', 'public/js/employee-dashboard.js',
    'public/pages/employee-dashboard.html', 'public/js/payroll.js', 'public/pages/payroll.html',
  ],
  reports: [
    'server/reports.js', 'public/js/reports.js', 'public/pages/reports.html',
    'public/css/reports.css',
  ],
  self_service: [
    'server/self-service.js', 'server/employee-dashboard.js', 'public/js/self-service.js',
    'public/js/employee-dashboard.js', 'public/pages/self-service.html',
    'public/pages/employee-dashboard.html', 'public/css/employee-dashboard.css',
  ],
  audit_trail: [
    'server/admin-rbac.js', 'server/privacy-protection.js', 'public/js/system-admin.js',
    'public/pages/system-admin.html', 'public/css/system-admin.css',
  ],
  blockchain: [
    'server/routes/blockchain-payroll.js', 'server/routes/blockchain-dtr.js',
    'server/controllers/blockchainPayrollController.js', 'server/controllers/blockchainDtrController.js',
    'server/utils/payrollHash.js', 'server/utils/dtrHash.js', 'chaincode/payroll-audit',
    'public/js/blockchain.js', 'public/pages/blockchain.html', 'public/css/blockchain.css',
  ],
  system_health: [
    'server/admin-rbac.js', 'public/js/system-admin.js', 'public/pages/system-admin.html',
    'public/css/system-admin.css',
  ],
  support_center: [
    'server/admin-rbac.js', 'public/js/system-admin.js', 'public/pages/system-admin.html',
    'public/css/system-admin.css',
  ],
  backup_restore: [
    'server/backup-recovery.js', 'services/backup', 'services/backupStepUpService.js',
    'public/js/system-admin.js', 'public/pages/system-admin.html', 'public/css/system-admin.css',
  ],
  file_storage: [
    'server/encrypted-file-vault.js', 'server/201-file-management.js',
    'server/data-protection.js', 'public/js/201file.js', 'public/pages/201file.html',
  ],
  notification_service: [
    'server/realtime.js', 'services/socketDeviceDetectionService.js',
    'public/js/attendance-realtime.js', 'public/js/app.js',
  ],
});

function normalizeModuleKey(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,80}$/.test(key)) {
    throw backupError('Module key is invalid.', 'INVALID_MODULE_CODE_REQUEST');
  }
  return key;
}

function normalizeConfiguredPath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!raw || path.isAbsolute(raw) || FORBIDDEN_SOURCE_PATH.test(raw)) {
    throw backupError('Module source mapping contains an unsafe path.', 'UNSAFE_MODULE_SOURCE_PATH');
  }
  const normalized = normalizeRelativePath(raw);
  if (FORBIDDEN_SOURCE_PATH.test(normalized)) {
    throw backupError('Module source mapping contains a protected path.', 'UNSAFE_MODULE_SOURCE_PATH');
  }
  return normalized;
}

function normalizeModuleSourceMap(sourceMap = DEFAULT_MODULE_SOURCE_MAP) {
  const normalized = new Map();
  for (const [rawModule, rawPaths] of Object.entries(sourceMap || {})) {
    const moduleKey = normalizeModuleKey(rawModule);
    const paths = [...new Set((Array.isArray(rawPaths) ? rawPaths : []).map(normalizeConfiguredPath))];
    if (!paths.length) throw backupError(`Module ${moduleKey} has no source paths.`, 'MODULE_SOURCE_MAPPING_EMPTY');
    normalized.set(moduleKey, paths);
  }
  return normalized;
}

function isAllowedSourceFile(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  return !FORBIDDEN_SOURCE_PATH.test(normalized) && SAFE_SOURCE_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

function pathWithinConfiguredRoot(relativePath, configuredRoot) {
  return relativePath === configuredRoot || relativePath.startsWith(`${configuredRoot}/`);
}

async function lstatOrNull(filePath) {
  return fs.promises.lstat(filePath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
}

async function assertNoSymlinkPath(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  if (!isInside(root, candidate)) throw backupError('Module code path escaped its configured root.', 'UNSAFE_MODULE_SOURCE_PATH');
  const relative = path.relative(root, candidate);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (stat?.isSymbolicLink()) throw backupError('Symbolic links are not allowed in module code paths.', 'MODULE_CODE_SYMLINK_REJECTED');
  }
}

async function collectFilesForRoot(sourceRoot, configuredRoot) {
  const absoluteRoot = resolveInside(sourceRoot, ...configuredRoot.split('/'));
  await assertNoSymlinkPath(sourceRoot, absoluteRoot);
  const rootStat = await lstatOrNull(absoluteRoot);
  if (!rootStat) throw backupError(`Configured module source is missing: ${configuredRoot}`, 'MODULE_SOURCE_MISSING');
  if (rootStat.isSymbolicLink()) throw backupError('Symbolic links are not allowed in module code.', 'MODULE_CODE_SYMLINK_REJECTED');
  if (rootStat.isFile()) {
    if (!isAllowedSourceFile(configuredRoot)) throw backupError('Module source file type is not allowed.', 'MODULE_SOURCE_TYPE_BLOCKED');
    return [{ absolutePath: absoluteRoot, relativePath: configuredRoot, size: rootStat.size }];
  }
  if (!rootStat.isDirectory()) throw backupError('Module source must be a regular file or directory.', 'MODULE_SOURCE_TYPE_BLOCKED');

  const files = [];
  async function visit(directory) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativeCandidate = normalizeRelativePath(path.relative(sourceRoot, absolutePath));
      // Dependency trees, secrets, mutable uploads, and tool artifacts are
      // deliberately omitted even when they sit under an allowlisted folder.
      if (FORBIDDEN_SOURCE_PATH.test(relativeCandidate)) continue;
      const stat = await fs.promises.lstat(absolutePath);
      if (stat.isSymbolicLink()) throw backupError('Symbolic links are not allowed in module code.', 'MODULE_CODE_SYMLINK_REJECTED');
      if (stat.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) throw backupError('Module source may contain regular files only.', 'MODULE_SOURCE_TYPE_BLOCKED');
      const relativePath = relativeCandidate;
      if (!isAllowedSourceFile(relativePath)) throw backupError(`Module source file type is blocked: ${relativePath}`, 'MODULE_SOURCE_TYPE_BLOCKED');
      files.push({ absolutePath, relativePath, size: stat.size });
    }
  }
  await visit(absoluteRoot);
  return files;
}

async function writeJsonExclusive(filePath, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(filePath, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

async function readJson(filePath, maxBytes = 16 * 1024 * 1024) {
  const stat = await fs.promises.lstat(filePath).catch(error => {
    if (error.code === 'ENOENT') throw backupError('Module source manifest is missing.', 'MODULE_CODE_MANIFEST_MISSING');
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw backupError('Module source manifest is invalid.', 'MODULE_CODE_MANIFEST_INVALID');
  }
  try {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  } catch (error) {
    throw backupError('Module source manifest is unreadable.', 'MODULE_CODE_MANIFEST_INVALID', { cause: error });
  }
}

function syntaxCheck(relativePath, body) {
  const extension = path.extname(relativePath).toLowerCase();
  try {
    if (extension === '.js') new vm.Script(body, { filename: relativePath, displayErrors: true });
    if (extension === '.json') JSON.parse(body);
    if (['.html', '.css', '.svg'].includes(extension) && !String(body).trim()) {
      throw new Error('File is empty.');
    }
  } catch (error) {
    throw backupError(`Recovered module source failed syntax validation: ${relativePath}`, 'MODULE_CODE_SYNTAX_INVALID', { cause: error });
  }
}

class ModuleCodeService {
  constructor(options = {}) {
    this.sourceRoot = path.resolve(options.sourceRoot || process.cwd());
    this.activeRoot = path.resolve(options.activeRoot || this.sourceRoot);
    this.transactionRoot = path.resolve(options.transactionRoot || path.join(os.homedir(), '.lgsv-hr', 'code-rollback-transactions'));
    this.moduleSourceMap = normalizeModuleSourceMap(options.moduleSourceMap);
    this.maxFiles = Number(options.maxFiles || DEFAULT_MAX_SOURCE_FILES);
    this.maxBytes = Number(options.maxBytes || DEFAULT_MAX_SOURCE_BYTES);
    this.cutoverEnabled = Boolean(options.cutoverEnabled);
    this.afterFileApplied = typeof options.afterFileApplied === 'function' ? options.afterFileApplied : null;
    this.cutoverInProgress = false;
  }

  modulePaths(moduleKey) {
    const key = normalizeModuleKey(moduleKey);
    const paths = this.moduleSourceMap.get(key);
    if (!paths) throw backupError(`Module source mapping is unavailable for ${key}.`, 'MODULE_SOURCE_MAPPING_MISSING');
    return paths;
  }

  async capture({ destinationRoot, includedModules, appVersion, deploymentCommit }) {
    const modules = [...new Set((includedModules || []).map(normalizeModuleKey))].sort();
    if (!modules.length) throw backupError('A deployment backup must select at least one module.', 'MODULE_SELECTION_REQUIRED');
    const destination = path.resolve(destinationRoot);
    const treeRoot = path.join(destination, SOURCE_TREE_NAME);
    await fs.promises.mkdir(treeRoot, { recursive: true, mode: 0o700 });

    const indexed = new Map();
    const moduleRoots = {};
    let totalBytes = 0;
    for (const moduleKey of modules) {
      const roots = this.modulePaths(moduleKey);
      moduleRoots[moduleKey] = [...roots];
      let moduleFileCount = 0;
      for (const configuredRoot of roots) {
        const files = await collectFilesForRoot(this.sourceRoot, configuredRoot);
        for (const file of files) {
          moduleFileCount += 1;
          let indexedFile = indexed.get(file.relativePath);
          if (!indexedFile) {
            indexedFile = { ...file, modules: new Set() };
            indexed.set(file.relativePath, indexedFile);
            totalBytes += file.size;
            if (indexed.size > this.maxFiles) throw backupError('Module source artifact exceeds the file limit.', 'BACKUP_FILE_LIMIT_EXCEEDED');
            if (totalBytes > this.maxBytes) throw backupError('Module source artifact exceeds the size limit.', 'BACKUP_SIZE_LIMIT_EXCEEDED');
          }
          indexedFile.modules.add(moduleKey);
        }
      }
      if (!moduleFileCount) throw backupError(`No source files were found for ${moduleKey}.`, 'MODULE_SOURCE_MISSING');
    }

    const files = [];
    for (const indexedFile of [...indexed.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'))) {
      const destinationPath = resolveInside(treeRoot, ...indexedFile.relativePath.split('/'));
      await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
      await fs.promises.copyFile(indexedFile.absolutePath, destinationPath, fs.constants.COPYFILE_EXCL);
      await fs.promises.chmod(destinationPath, 0o600).catch(() => {});
      files.push({
        path: indexedFile.relativePath,
        size: indexedFile.size,
        sha256: await sha256File(destinationPath),
        modules: [...indexedFile.modules].sort(),
      });
    }

    const manifest = {
      formatVersion: SOURCE_FORMAT_VERSION,
      kind: 'LGSV_MODULE_SOURCE',
      modules,
      moduleRoots,
      capturedAt: new Date().toISOString(),
      appVersion: String(appVersion || 'unknown').slice(0, 80),
      deploymentCommit: String(deploymentCommit || 'unknown').slice(0, 80),
      fileCount: files.length,
      sizeBytes: totalBytes,
      files,
    };
    await writeJsonExclusive(path.join(destination, SOURCE_MANIFEST_NAME), manifest);
    return { manifest, componentPath: destination };
  }

  async validateComponent(componentPath, options = {}) {
    const component = path.resolve(componentPath);
    const manifest = await readJson(path.join(component, SOURCE_MANIFEST_NAME));
    if (manifest?.formatVersion !== SOURCE_FORMAT_VERSION || manifest?.kind !== 'LGSV_MODULE_SOURCE') {
      throw backupError('Module source manifest format is invalid.', 'MODULE_CODE_MANIFEST_INVALID');
    }
    const modules = [...new Set((Array.isArray(manifest.modules) ? manifest.modules : []).map(normalizeModuleKey))];
    if (!modules.length || !manifest.moduleRoots || typeof manifest.moduleRoots !== 'object' || !Array.isArray(manifest.files)) {
      throw backupError('Module source manifest is incomplete.', 'MODULE_CODE_MANIFEST_INVALID');
    }
    if (options.requiredModule && !modules.includes(normalizeModuleKey(options.requiredModule))) {
      throw backupError('The recovery artifact does not contain the requested module.', 'MODULE_CODE_NOT_IN_BACKUP');
    }
    if (manifest.files.length !== Number(manifest.fileCount) || manifest.files.length > this.maxFiles) {
      throw backupError('Module source manifest file count is invalid.', 'MODULE_CODE_MANIFEST_INVALID');
    }

    const treeRoot = path.join(component, SOURCE_TREE_NAME);
    const seen = new Set();
    let totalBytes = 0;
    for (const entry of manifest.files) {
      const relativePath = normalizeRelativePath(entry?.path);
      if (!isAllowedSourceFile(relativePath) || seen.has(relativePath) || !/^[a-f0-9]{64}$/i.test(String(entry?.sha256 || ''))) {
        throw backupError('Module source manifest contains an invalid file entry.', 'MODULE_CODE_MANIFEST_INVALID');
      }
      seen.add(relativePath);
      const entryModules = [...new Set((Array.isArray(entry.modules) ? entry.modules : []).map(normalizeModuleKey))];
      if (!entryModules.length || entryModules.some(moduleKey => !modules.includes(moduleKey))) {
        throw backupError('Module source file ownership is invalid.', 'MODULE_CODE_MANIFEST_INVALID');
      }
      for (const moduleKey of entryModules) {
        const configuredRoots = this.modulePaths(moduleKey);
        if (!configuredRoots.some(root => pathWithinConfiguredRoot(relativePath, root))) {
          throw backupError('Module source file is outside the server allowlist.', 'MODULE_CODE_PATH_NOT_ALLOWED');
        }
      }
      const filePath = resolveInside(treeRoot, ...relativePath.split('/'));
      await assertNoSymlinkPath(treeRoot, filePath);
      const stat = await lstatOrNull(filePath);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== Number(entry.size)) {
        throw backupError('Recovered module source does not match its manifest.', 'MODULE_CODE_INTEGRITY_MISMATCH');
      }
      const actualHash = await sha256File(filePath);
      if (!crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(String(entry.sha256).toLowerCase(), 'hex'))) {
        throw backupError('Recovered module source checksum mismatch.', 'MODULE_CODE_INTEGRITY_MISMATCH');
      }
      totalBytes += stat.size;
      if (totalBytes > this.maxBytes) throw backupError('Recovered module source exceeds the size limit.', 'BACKUP_SIZE_LIMIT_EXCEEDED');
      const extension = path.extname(relativePath).toLowerCase();
      if (['.js', '.json', '.html', '.css', '.svg'].includes(extension)) {
        syntaxCheck(relativePath, await fs.promises.readFile(filePath, 'utf8'));
      }
    }
    if (totalBytes !== Number(manifest.sizeBytes)) {
      throw backupError('Module source manifest size is invalid.', 'MODULE_CODE_INTEGRITY_MISMATCH');
    }
    return { valid: true, manifest, treeRoot, fileCount: seen.size, sizeBytes: totalBytes };
  }

  async currentManagedFiles(moduleKey) {
    const indexed = new Map();
    for (const configuredRoot of this.modulePaths(moduleKey)) {
      const files = await collectFilesForRoot(this.activeRoot, configuredRoot).catch(error => {
        if (error.code === 'MODULE_SOURCE_MISSING') return [];
        throw error;
      });
      for (const file of files) indexed.set(file.relativePath, file);
    }
    return indexed;
  }

  async restoreTransactionSnapshot(snapshotRoot, managedPaths) {
    for (const relativePath of managedPaths) {
      const target = resolveInside(this.activeRoot, ...relativePath.split('/'));
      await assertNoSymlinkPath(this.activeRoot, target);
      await fs.promises.rm(target, { force: true });
    }
    const beforeRoot = path.join(snapshotRoot, 'before');
    const beforeStat = await lstatOrNull(beforeRoot);
    if (!beforeStat) return;
    async function copyBack(directory, activeRoot) {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const source = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await copyBack(source, activeRoot);
          continue;
        }
        if (!entry.isFile()) throw backupError('Rollback transaction snapshot is invalid.', 'CODE_CUTOVER_ROLLBACK_FAILED');
        const relativePath = normalizeRelativePath(path.relative(beforeRoot, source));
        const destination = resolveInside(activeRoot, ...relativePath.split('/'));
        await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await fs.promises.copyFile(source, destination);
      }
    }
    await copyBack(beforeRoot, this.activeRoot);
  }

  async applyModuleRollback({ componentPath, affectedModule, backupReference }) {
    if (!this.cutoverEnabled) throw backupError('Module code cutover is disabled by server configuration.', 'MODULE_CODE_CUTOVER_DISABLED');
    if (this.cutoverInProgress) throw backupError('Another module code cutover is already running.', 'MODULE_CODE_CUTOVER_BUSY', { retryable: true });
    this.cutoverInProgress = true;
    const moduleKey = normalizeModuleKey(affectedModule);
    const reference = assertSafeBackupReference(backupReference);
    let transactionPath = null;
    let preserveTransaction = false;
    try {
      const validation = await this.validateComponent(componentPath, { requiredModule: moduleKey });
      const selectedEntries = validation.manifest.files.filter(entry => Array.isArray(entry.modules) && entry.modules.includes(moduleKey));
      if (!selectedEntries.length) throw backupError('The recovery artifact contains no files for this module.', 'MODULE_CODE_NOT_IN_BACKUP');

      const sourcePaths = new Set(selectedEntries.map(entry => normalizeRelativePath(entry.path)));
      const currentFiles = await this.currentManagedFiles(moduleKey);
      const managedPaths = new Set([...sourcePaths, ...currentFiles.keys()]);
      await fs.promises.mkdir(this.transactionRoot, { recursive: true, mode: 0o700 });
      const transactionId = `${reference}-${moduleKey}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      transactionPath = resolveInside(this.transactionRoot, transactionId);
      const beforeRoot = path.join(transactionPath, 'before');
      await fs.promises.mkdir(beforeRoot, { recursive: true, mode: 0o700 });

      for (const [relativePath, current] of currentFiles) {
        const snapshotPath = resolveInside(beforeRoot, ...relativePath.split('/'));
        await fs.promises.mkdir(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
        await fs.promises.copyFile(current.absolutePath, snapshotPath, fs.constants.COPYFILE_EXCL);
      }
      await writeJsonExclusive(path.join(transactionPath, 'transaction.json'), {
        formatVersion: 1,
        backupReference: reference,
        module: moduleKey,
        createdAt: new Date().toISOString(),
        managedPaths: [...managedPaths].sort(),
      });

      try {
        for (const relativePath of currentFiles.keys()) {
          if (sourcePaths.has(relativePath)) continue;
          const target = resolveInside(this.activeRoot, ...relativePath.split('/'));
          await assertNoSymlinkPath(this.activeRoot, target);
          await fs.promises.rm(target, { force: true });
        }

        let appliedCount = 0;
        for (const entry of selectedEntries) {
          const relativePath = normalizeRelativePath(entry.path);
          const source = resolveInside(validation.treeRoot, ...relativePath.split('/'));
          const target = resolveInside(this.activeRoot, ...relativePath.split('/'));
          await assertNoSymlinkPath(this.activeRoot, target);
          await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          const temporary = `${target}.lgsv-restore-${crypto.randomBytes(4).toString('hex')}`;
          await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
          await fs.promises.rm(target, { force: true });
          await fs.promises.rename(temporary, target);
          await fs.promises.chmod(target, 0o600).catch(() => {});
          appliedCount += 1;
          if (this.afterFileApplied) await this.afterFileApplied({ relativePath, appliedCount });
        }

        for (const entry of selectedEntries) {
          const target = resolveInside(this.activeRoot, ...normalizeRelativePath(entry.path).split('/'));
          const actualHash = await sha256File(target);
          if (actualHash !== String(entry.sha256).toLowerCase()) {
            throw backupError('Applied module source failed post-cutover verification.', 'MODULE_CODE_POST_CUTOVER_MISMATCH');
          }
        }

        await removeTemporaryTree(this.transactionRoot, transactionPath);
        transactionPath = null;
        return {
          cutoverApplied: true,
          affectedModule: moduleKey,
          appliedFiles: selectedEntries.length,
          removedFiles: [...currentFiles.keys()].filter(relativePath => !sourcePaths.has(relativePath)).length,
          restartRequired: selectedEntries.some(entry => entry.path.endsWith('.js') && !entry.path.startsWith('public/')),
          verified: true,
          integrityPassed: true,
          manifest: {
            deploymentCommit: validation.manifest.deploymentCommit,
            appVersion: validation.manifest.appVersion,
            fileCount: selectedEntries.length,
          },
        };
      } catch (error) {
        await this.restoreTransactionSnapshot(transactionPath, managedPaths).catch(restoreError => {
          error.rollbackError = restoreError;
          preserveTransaction = true;
        });
        throw error;
      }
    } finally {
      if (transactionPath && !preserveTransaction && isInside(this.transactionRoot, transactionPath)) {
        await removeTemporaryTree(this.transactionRoot, transactionPath).catch(() => {});
      }
      this.cutoverInProgress = false;
    }
  }
}

module.exports = {
  DEFAULT_MODULE_SOURCE_MAP,
  ModuleCodeService,
  SOURCE_FORMAT_VERSION,
  SOURCE_MANIFEST_NAME,
  SOURCE_TREE_NAME,
  isAllowedSourceFile,
  normalizeModuleSourceMap,
};
