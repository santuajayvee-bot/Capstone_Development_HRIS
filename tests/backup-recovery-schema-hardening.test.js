'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { splitStatements } = require('../database/mysql-compatible-migration');

const root = path.join(__dirname, '..');
const wrapper = fs.readFileSync(
  path.join(root, 'migrations', '20260712123000-backup-restore-execution-hardening.js'),
  'utf8'
);
const up = fs.readFileSync(
  path.join(root, 'migrations', 'sqls', '20260712123000_backup_restore_execution_hardening-up.sql'),
  'utf8'
);
const down = fs.readFileSync(
  path.join(root, 'migrations', 'sqls', '20260712123000_backup_restore_execution_hardening-down.sql'),
  'utf8'
);
const adaptiveWrapper = fs.readFileSync(
  path.join(root, 'migrations', '20260714130000-adaptive-single-admin-backup-approval.js'),
  'utf8'
);
const adaptiveUp = fs.readFileSync(
  path.join(root, 'migrations', 'sqls', '20260714130000_adaptive_single_admin_backup_approval-up.sql'),
  'utf8'
);
const adaptiveDown = fs.readFileSync(
  path.join(root, 'migrations', 'sqls', '20260714130000_adaptive_single_admin_backup_approval-down.sql'),
  'utf8'
);

assert(wrapper.includes("runSqlFile(db, '20260712123000_backup_restore_execution_hardening-up.sql')"));
assert(wrapper.includes("runSqlFile(db, '20260712123000_backup_restore_execution_hardening-down.sql')"));

assert(up.includes('CREATE TABLE IF NOT EXISTS backup_step_up_challenges'));
assert(up.includes('id BIGINT AUTO_INCREMENT PRIMARY KEY'));
assert(up.includes('challenge_token_hash CHAR(64)'));
assert(up.includes("status ENUM('PENDING','VERIFIED','CONSUMED','EXPIRED','FAILED')"));
assert(up.includes('FOREIGN KEY (user_id) REFERENCES users(id)'));
assert(up.includes('FOREIGN KEY (employee_id) REFERENCES employees(Employee_ID)'));
assert(up.includes('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'));
assert(!/\b(?:otp|totp|mfa)_(?:code|secret)\b/i.test(up), 'Migration must never store an MFA code or secret.');

for (const table of ['backup_sets', 'module_recovery_points', 'restore_jobs', 'module_rollback_requests']) {
  const tableBlock = up.match(new RegExp(`ALTER TABLE ${table}[\\s\\S]*?(?=;\\s*(?:UPDATE|ALTER TABLE|$))`));
  assert(tableBlock, `Expected an ALTER block for ${table}.`);
}

for (const prefix of ['backup_sets', 'module_recovery', 'restore_jobs', 'module_rollback']) {
  assert(
    up.includes(`uq_${prefix}_idempotency UNIQUE (idempotency_key)`),
    `${prefix} must enforce a unique operation idempotency key.`
  );
}

assert(up.includes('chk_backup_sets_maker_checker'));
assert(up.includes('chk_backup_sets_idempotency'));
assert(up.includes('chk_module_recovery_identifiers'));
assert(up.includes('chk_restore_jobs_idempotency'));
assert(up.includes('chk_module_rollback_idempotency'));
assert(up.includes('approved_by <> created_by'));
assert(up.includes('verified_by <> created_by'));
assert(up.includes('chk_restore_jobs_maker_checker'));
assert(up.includes('approved_by <> requested_by'));
assert(up.includes('chk_module_rollback_maker_checker'));
assert(up.includes("dry_run_status = 'PASSED'"));
assert(up.includes("integrity_status = 'PASSED'"));
assert(up.includes('restored_checksum = expected_checksum'));
assert(up.includes("verification_status = 'MATCH'"));
assert(up.includes('FOREIGN KEY (backup_set_id) REFERENCES backup_sets(id)'));
assert(up.includes('FOREIGN KEY (recovery_point_id) REFERENCES module_recovery_points(id)'));
assert(!/\bDROP\s+(?:TABLE|COLUMN)\b/i.test(up), 'The up migration must not drop tables or columns.');

assert(down.includes('DROP TABLE IF EXISTS backup_step_up_challenges'));
assert(down.includes('DROP FOREIGN KEY fk_restore_jobs_backup_set'));
assert(down.includes('DROP FOREIGN KEY fk_module_rollback_recovery'));
assert(down.includes('DROP COLUMN IF EXISTS idempotency_key'));
assert(down.includes("MODIFY COLUMN status ENUM('PENDING','IN_PROGRESS','COMPLETED','FAILED','CANCELLED')"));

assert.strictEqual(splitStatements(up).length, 14, 'The migration runner must parse every up statement.');
assert.strictEqual(splitStatements(down).length, 9, 'The migration runner must parse every down statement.');

assert(adaptiveWrapper.includes("runSqlFile(db, '20260714130000_adaptive_single_admin_backup_approval-up.sql')"));
assert(adaptiveWrapper.includes("runSqlFile(db, '20260714130000_adaptive_single_admin_backup_approval-down.sql')"));
for (const constraint of [
  'chk_backup_sets_maker_checker',
  'chk_restore_jobs_maker_checker',
  'chk_module_rollback_maker_checker',
]) {
  assert(adaptiveUp.includes(`DROP CONSTRAINT ${constraint}`), `${constraint} must be removed for the single-administrator workflow.`);
  assert(adaptiveDown.includes(`ADD CONSTRAINT ${constraint}`), `${constraint} must be restored by the down migration.`);
}
assert(!adaptiveUp.includes('chk_backup_sets_verified_artifact'), 'Artifact verification evidence must remain enforced.');
assert(!adaptiveUp.includes('chk_restore_jobs_approval_evidence'), 'Restore MFA approval evidence must remain enforced.');
assert(!adaptiveUp.includes('chk_module_rollback_approval_evidence'), 'Rollback MFA approval evidence must remain enforced.');
assert.strictEqual(splitStatements(adaptiveUp).length, 3, 'Single-admin approval up migration must contain three ALTER statements.');
assert.strictEqual(splitStatements(adaptiveDown).length, 3, 'Single-admin approval down migration must contain three ALTER statements.');

console.log('Backup/restore schema hardening migration tests passed.');
