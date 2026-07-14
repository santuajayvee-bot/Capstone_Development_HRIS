'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { splitStatements } = require('../database/mysql-compatible-migration');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const wrapper = read('migrations/20260713090000-backup-recovery-operational-completeness.js');
const up = read('migrations/sqls/20260713090000_backup_recovery_operational_completeness-up.sql');
const down = read('migrations/sqls/20260713090000_backup_recovery_operational_completeness-down.sql');
const sameVersionWrapper = read('migrations/20260714103000-allow-same-version-module-rollback.js');
const sameVersionUp = read('migrations/sqls/20260714103000_allow_same_version_module_rollback-up.sql');
const sameVersionDown = read('migrations/sqls/20260714103000_allow_same_version_module_rollback-down.sql');
const route = read('server/backup-recovery.js');
const runtime = read('services/backup/backupRuntime.js');
const moduleCode = read('services/backup/moduleCodeService.js');
const rds = read('services/backup/rdsSnapshotAdapter.js');
const ui = read('public/js/system-admin.js');

assert(wrapper.includes('20260713090000_backup_recovery_operational_completeness-up.sql'));
assert(wrapper.includes('20260713090000_backup_recovery_operational_completeness-down.sql'));
for (const table of ['backup_sets', 'restore_jobs', 'module_rollback_requests']) {
  assert(up.includes(`ALTER TABLE ${table}`));
  assert(up.includes(`chk_${table === 'module_rollback_requests' ? 'module_rollback' : table}_request_fingerprint`));
}
assert.strictEqual(splitStatements(up).length, 9);
assert.strictEqual(splitStatements(down).length, 3);
assert(sameVersionWrapper.includes('20260714103000_allow_same_version_module_rollback-up.sql'));
assert(sameVersionWrapper.includes('20260714103000_allow_same_version_module_rollback-down.sql'));
assert(sameVersionUp.includes('DROP CONSTRAINT chk_module_rollback_versions'));
assert(!sameVersionUp.includes('DROP TABLE'));
assert(!sameVersionUp.includes('DROP COLUMN'));
assert(sameVersionDown.includes("CONCAT(LEFT(target_version, 71), '+rollback')"));
assert(sameVersionDown.includes('ADD CONSTRAINT chk_module_rollback_versions'));
assert.strictEqual(splitStatements(sameVersionUp).length, 1);
assert.strictEqual(splitStatements(sameVersionDown).length, 2);
assert(route.includes('IDEMPOTENCY_CONFLICT'));
assert(route.includes('recoverExpiredOperations'));
assert(route.includes("'/restore-jobs/:jobId/verify-target'"));
assert(route.includes('recordRecoveryHealth'));
assert(runtime.includes('verifyPendingRestore'));
assert(runtime.includes('applyModuleRollback'));
assert(runtime.includes("['DEPLOYMENT_VERSION', 'FULL_BACKUP'].includes(type)"));
assert(moduleCode.includes('DEFAULT_MODULE_SOURCE_MAP'));
assert(moduleCode.includes('MODULE_CODE_POST_CUTOVER_MISMATCH'));
assert(moduleCode.includes('restoreTransactionSnapshot'));
assert(route.includes("bs.backup_type IN ('DEPLOYMENT_VERSION','FULL_BACKUP')"));
assert(route.includes('result.restored === true && result.integrityPassed === true && result.verified === true'));
assert(rds.includes('verifyRestoredInstance'));
assert(ui.includes('verifyRestoreTarget'));
assert(ui.includes("'DRY_RUN_PASSED', 'PENDING'"));
assert(ui.includes('sessionStorage.setItem(storageKey, value)'));

console.log('Backup and recovery operational completeness tests: PASS');
