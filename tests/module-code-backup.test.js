'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';

const {
  BackupBundleBuilder,
  BackupRuntime,
  DEFAULT_MODULE_SOURCE_MAP,
  LocalStorageAdapter,
  ModuleCodeService,
} = require('../services/backup');

const ENCRYPTION_KEY = 'cd'.repeat(32);
const EXPECTED_MODULES = [
  'authentication', 'account_management', 'rbac', 'employee_201', 'organization_setup',
  'onboarding', 'attendance', 'attendance_sync', 'leave', 'operational_logs',
  'payroll_settings', 'payroll', 'payroll_approval', 'payslip', 'reports',
  'self_service', 'audit_trail', 'blockchain', 'system_health', 'support_center',
  'backup_restore', 'file_storage', 'notification_service',
];

async function temporaryDirectory(prefix) {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFixture(root, relativePath, body) {
  const filePath = path.join(root, ...relativePath.split('/'));
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, body, 'utf8');
  return filePath;
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error => error?.code === code, `Expected error code ${code}`);
}

async function createFixture() {
  const root = await temporaryDirectory('lgsv-module-code-');
  const sourceRoot = path.join(root, 'known-good');
  const activeRoot = path.join(root, 'active');
  await writeFixture(sourceRoot, 'server/payroll.js', "'use strict';\nmodule.exports = { version: 'known-good' };\n");
  await writeFixture(sourceRoot, 'public/js/payroll.js', "window.payrollVersion = 'known-good';\n");
  await writeFixture(sourceRoot, '.env', 'DB_PASSWORD=must-never-enter-artifact\n');
  await writeFixture(activeRoot, 'server/payroll.js', "'use strict';\nmodule.exports = { version: 'broken' };\n");
  await writeFixture(activeRoot, 'server/obsolete.js', "module.exports = 'remove-me';\n");
  await writeFixture(activeRoot, 'public/js/payroll.js', "window.payrollVersion = 'broken';\n");
  return { root, sourceRoot, activeRoot };
}

async function testModuleMapCoverage() {
  for (const moduleKey of EXPECTED_MODULES) {
    assert(Array.isArray(DEFAULT_MODULE_SOURCE_MAP[moduleKey]), `Missing source mapping for ${moduleKey}.`);
    assert(DEFAULT_MODULE_SOURCE_MAP[moduleKey].length > 0, `Empty source mapping for ${moduleKey}.`);
  }
}

async function testCaptureAndValidation() {
  const fixture = await createFixture();
  try {
    const service = new ModuleCodeService({
      sourceRoot: fixture.sourceRoot,
      activeRoot: fixture.activeRoot,
      transactionRoot: path.join(fixture.root, 'transactions'),
      moduleSourceMap: { payroll: ['server', 'public/js/payroll.js'] },
      cutoverEnabled: true,
    });
    const componentPath = path.join(fixture.root, 'component');
    const captured = await service.capture({
      destinationRoot: componentPath,
      includedModules: ['payroll'],
      appVersion: '1.0.0',
      deploymentCommit: 'known-good-commit',
    });
    assert.strictEqual(captured.manifest.kind, 'LGSV_MODULE_SOURCE');
    assert.deepStrictEqual(captured.manifest.modules, ['payroll']);
    assert(captured.manifest.files.some(file => file.path === 'server/payroll.js'));
    assert(captured.manifest.files.some(file => file.path === 'public/js/payroll.js'));
    assert.strictEqual(captured.manifest.files.some(file => file.path.includes('.env')), false);
    const validation = await service.validateComponent(componentPath, { requiredModule: 'payroll' });
    assert.strictEqual(validation.valid, true);
    assert.strictEqual(validation.fileCount, 2);

    await fs.promises.appendFile(path.join(componentPath, 'tree', 'server', 'payroll.js'), '// tampered\n');
    await expectCode(service.validateComponent(componentPath), 'MODULE_CODE_INTEGRITY_MISMATCH');
    await expectCode(service.capture({
      destinationRoot: path.join(fixture.root, 'unknown'),
      includedModules: ['unknown-module'],
    }), 'MODULE_SOURCE_MAPPING_MISSING');
  } finally {
    await fs.promises.rm(fixture.root, { recursive: true, force: true });
  }
}

async function testTransactionalCutoverAndAutomaticRevert() {
  const fixture = await createFixture();
  try {
    const map = { payroll: ['server', 'public/js/payroll.js'] };
    const service = new ModuleCodeService({
      sourceRoot: fixture.sourceRoot,
      activeRoot: fixture.activeRoot,
      transactionRoot: path.join(fixture.root, 'transactions'),
      moduleSourceMap: map,
      cutoverEnabled: true,
    });
    const componentPath = path.join(fixture.root, 'component');
    await service.capture({ destinationRoot: componentPath, includedModules: ['payroll'] });
    const result = await service.applyModuleRollback({
      componentPath,
      affectedModule: 'payroll',
      backupReference: 'CODE-ROLLBACK-1',
    });
    assert.strictEqual(result.cutoverApplied, true);
    assert.strictEqual(result.integrityPassed, true);
    assert.strictEqual(result.removedFiles, 1);
    assert((await fs.promises.readFile(path.join(fixture.activeRoot, 'server/payroll.js'), 'utf8')).includes('known-good'));
    assert.strictEqual(await fs.promises.access(path.join(fixture.activeRoot, 'server/obsolete.js')).then(() => true).catch(() => false), false);

    await writeFixture(fixture.activeRoot, 'server/payroll.js', "module.exports = { version: 'broken-again' };\n");
    await writeFixture(fixture.activeRoot, 'server/obsolete.js', "module.exports = 'restore-on-failure';\n");
    const failing = new ModuleCodeService({
      sourceRoot: fixture.sourceRoot,
      activeRoot: fixture.activeRoot,
      transactionRoot: path.join(fixture.root, 'transactions-failing'),
      moduleSourceMap: map,
      cutoverEnabled: true,
      afterFileApplied: async ({ appliedCount }) => {
        if (appliedCount === 1) throw new Error('simulated cutover failure');
      },
    });
    await assert.rejects(failing.applyModuleRollback({
      componentPath,
      affectedModule: 'payroll',
      backupReference: 'CODE-ROLLBACK-2',
    }), /simulated cutover failure/);
    assert((await fs.promises.readFile(path.join(fixture.activeRoot, 'server/payroll.js'), 'utf8')).includes('broken-again'));
    assert((await fs.promises.readFile(path.join(fixture.activeRoot, 'server/obsolete.js'), 'utf8')).includes('restore-on-failure'));

    const disabled = new ModuleCodeService({
      sourceRoot: fixture.sourceRoot,
      activeRoot: fixture.activeRoot,
      moduleSourceMap: map,
      cutoverEnabled: false,
    });
    await expectCode(disabled.applyModuleRollback({
      componentPath,
      affectedModule: 'payroll',
      backupReference: 'CODE-ROLLBACK-3',
    }), 'MODULE_CODE_CUTOVER_DISABLED');
  } finally {
    await fs.promises.rm(fixture.root, { recursive: true, force: true });
  }
}

async function testEncryptedDeploymentBackupAndRuntimeRollback() {
  const fixture = await createFixture();
  try {
    const moduleCodeService = new ModuleCodeService({
      sourceRoot: fixture.sourceRoot,
      activeRoot: fixture.activeRoot,
      transactionRoot: path.join(fixture.root, 'transactions'),
      moduleSourceMap: { payroll: ['server/payroll.js', 'public/js/payroll.js'] },
      cutoverEnabled: true,
    });
    const adapter = new LocalStorageAdapter({
      rootPath: path.join(fixture.root, 'encrypted-backups'),
      encryptionKey: ENCRYPTION_KEY,
    });
    const builder = new BackupBundleBuilder({ moduleCodeService });
    const runtime = new BackupRuntime({
      adapters: [adapter],
      bundleBuilder: builder,
      moduleCodeService,
      workRoot: path.join(fixture.root, 'work'),
      liveRestoreEnabled: false,
      appVersion: '1.0.0',
      deploymentCommit: 'known-good-commit',
    });
    const backup = await runtime.createBackup({
      backupReference: 'DEPLOYMENT-1',
      backupType: 'DEPLOYMENT_VERSION',
      storageProvider: 'LOCAL',
      includedModules: ['payroll'],
    });
    assert.strictEqual(backup.status, 'COMPLETED');
    assert.strictEqual(backup.verification.valid, true);
    const dryRun = await runtime.runRestoreDryRun({
      backupReference: backup.backupReference,
      backupType: backup.backupType,
      storageProvider: backup.storageProvider,
      storageLocation: backup.storageLocation,
      expectedChecksum: backup.checksum,
    });
    assert.strictEqual(dryRun.safeToRestore, true);
    assert.strictEqual(dryRun.sourceCodeValidation.valid, true);
    const restored = await runtime.applyRestore({
      backupReference: backup.backupReference,
      backupType: backup.backupType,
      storageProvider: backup.storageProvider,
      storageLocation: backup.storageLocation,
      expectedChecksum: backup.checksum,
      affectedModule: 'payroll',
      rollback: true,
    });
    assert.strictEqual(restored.restored, true);
    assert.strictEqual(restored.integrityPassed, true);
    assert.strictEqual(restored.recoveredComponents.requiresCutover, false);
    assert.strictEqual(restored.recoveredComponents.sourceCode.affectedModule, 'payroll');
    assert((await fs.promises.readFile(path.join(fixture.activeRoot, 'server/payroll.js'), 'utf8')).includes('known-good'));
    await expectCode(runtime.applyRestore({
      backupReference: backup.backupReference,
      backupType: 'MODULE_STATE',
      storageProvider: backup.storageProvider,
      storageLocation: backup.storageLocation,
      expectedChecksum: backup.checksum,
      affectedModule: 'payroll',
      rollback: true,
    }), 'MODULE_CODE_ARTIFACT_REQUIRED');
  } finally {
    await fs.promises.rm(fixture.root, { recursive: true, force: true });
  }
}

(async () => {
  const tests = [
    ['every recovery module has a server-owned source allowlist', testModuleMapCoverage],
    ['module source capture stores real files and rejects tampering or unknown modules', testCaptureAndValidation],
    ['module cutover replaces code transactionally and automatically reverts failures', testTransactionalCutoverAndAutomaticRevert],
    ['encrypted deployment backup performs validated runtime code rollback', testEncryptedDeploymentBackupAndRuntimeRollback],
  ];
  for (const [name, callback] of tests) {
    await callback();
    console.log(`PASS: ${name}`);
  }
  console.log(`Module code backup tests passed (${tests.length}).`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
