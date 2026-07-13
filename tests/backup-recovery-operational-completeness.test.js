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
const route = read('server/backup-recovery.js');
const runtime = read('services/backup/backupRuntime.js');
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
assert(route.includes('IDEMPOTENCY_CONFLICT'));
assert(route.includes('recoverExpiredOperations'));
assert(route.includes("'/restore-jobs/:jobId/verify-target'"));
assert(route.includes('recordRecoveryHealth'));
assert(runtime.includes('verifyPendingRestore'));
assert(rds.includes('verifyRestoredInstance'));
assert(ui.includes('verifyRestoreTarget'));
assert(ui.includes("'DRY_RUN_PASSED', 'PENDING'"));
assert(ui.includes('sessionStorage.setItem(storageKey, value)'));

console.log('Backup and recovery operational completeness tests: PASS');
