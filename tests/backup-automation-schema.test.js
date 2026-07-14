'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { splitStatements } = require('../database/mysql-compatible-migration');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const timestamp = '20260714120000';
const slug = 'backup_automation_and_restore_drills';
const wrapper = read(`migrations/${timestamp}-backup-automation-and-restore-drills.js`);
const up = read(`migrations/sqls/${timestamp}_${slug}-up.sql`);
const down = read(`migrations/sqls/${timestamp}_${slug}-down.sql`);

assert(wrapper.includes(`runSqlFile(db, '${timestamp}_${slug}-up.sql')`));
assert(wrapper.includes(`runSqlFile(db, '${timestamp}_${slug}-down.sql')`));

const tables = [
  'backup_retention_policies',
  'backup_schedules',
  'backup_action_notifications',
  'backup_restore_drill_schedules',
  'backup_restore_drill_runs'
];

for (const table of tables) {
  assert(up.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} must be created idempotently.`);
  const block = up.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));
  assert(block, `${table} must use InnoDB and utf8mb4.`);
  assert(block[0].includes('id BIGINT AUTO_INCREMENT PRIMARY KEY'), `${table} must use a BIGINT identity.`);
  assert(down.includes(`DROP TABLE IF EXISTS ${table}`), `${table} must be removed by down migration.`);
}

assert(up.includes('uq_backup_schedule_reference UNIQUE (schedule_reference)'));
assert(up.includes('uq_backup_schedule_idempotency UNIQUE (idempotency_key)'));
assert.strictEqual(
  (up.match(/request_fingerprint CHAR\(64\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/g) || []).length,
  2,
  'Backup and drill schedules must persist strict request fingerprints.'
);
assert.strictEqual(
  (up.match(/CHAR_LENGTH\(request_fingerprint\) = 64/g) || []).length,
  2,
  'Both schedule tables must validate SHA-256 request fingerprints.'
);
assert(up.includes("backup_type ENUM('DATABASE','FILES','CONFIGURATION','MODULE_STATE','DEPLOYMENT_VERSION','FULL_BACKUP')"));
assert(up.includes("storage_provider ENUM('LOCAL','S3','RDS_SNAPSHOT')"));
assert(up.includes("frequency ENUM('HOURLY','DAILY','WEEKLY','MONTHLY')"));
assert(up.includes("timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Manila'"));
assert(up.includes('CHECK (included_modules IS NULL OR JSON_VALID(included_modules))'));
assert(up.includes('day_of_week BETWEEN 1 AND 7'));
assert(up.includes('day_of_month BETWEEN 1 AND 31'));
assert(up.includes('FOREIGN KEY (retention_policy_id) REFERENCES backup_retention_policies(id)'));

for (const field of ['keep_last', 'max_age_days', 'delete_expired_artifacts', 'backup_type', 'storage_provider']) {
  assert(up.includes(field), `Retention policy must include ${field}.`);
}
assert(up.includes('CHECK (keep_last >= 1 AND max_age_days >= 1)'));

assert(up.includes('uq_backup_action_notification_dedupe UNIQUE (dedupe_key)'));
assert(up.includes('FOREIGN KEY (recipient_user_id) REFERENCES users(id)'));
assert(up.includes("status ENUM('UNREAD','READ','RESOLVED')"));
assert(up.includes('chk_backup_notification_status_evidence'));

assert(up.includes("selection_strategy ENUM('LATEST_VERIFIED')"));
assert(up.includes('backup_type_filter'));
assert(up.includes('storage_provider_filter'));
assert(up.includes('module_key_filter'));
assert(up.includes("status ENUM('QUEUED','RUNNING','PASSED','FAILED','SKIPPED')"));
assert(up.includes('FOREIGN KEY (schedule_id) REFERENCES backup_restore_drill_schedules(id)'));
assert(up.includes('FOREIGN KEY (backup_set_id) REFERENCES backup_sets(id)'));
assert(up.includes('result_message_encrypted LONGTEXT'));
assert(up.includes('failure_message_encrypted TEXT'));
assert(up.includes('chk_backup_drill_run_passed_evidence'));

assert(up.includes('ALTER TABLE backup_sets'));
assert(up.includes('ADD COLUMN IF NOT EXISTS schedule_id BIGINT NULL'));
assert(up.includes('ADD COLUMN IF NOT EXISTS expires_at DATETIME NULL'));
assert(up.includes("retention_status ENUM('ACTIVE','EXPIRED','DELETED') NOT NULL DEFAULT 'ACTIVE'"));
assert(up.includes('ADD COLUMN IF NOT EXISTS artifact_deleted_at DATETIME NULL'));
assert(up.includes('FOREIGN KEY (schedule_id) REFERENCES backup_schedules(id) ON DELETE SET NULL'));
assert(up.includes('chk_backup_sets_retention_evidence'));

for (const foreignKey of [
  'fk_backup_retention_created_by',
  'fk_backup_schedule_created_by',
  'fk_backup_notification_recipient',
  'fk_backup_drill_schedule_created_by',
  'fk_backup_drill_run_created_by'
]) {
  assert(up.includes(foreignKey), `Expected actor foreign key ${foreignKey}.`);
}

assert(!/\b(?:password|secret|access_key|private_key)\b/i.test(up), 'Migration must never contain secrets.');
assert(!/\bDROP\s+(?:TABLE|COLUMN|DATABASE)\b/i.test(up), 'Up migration must be additive.');
assert(down.indexOf('DROP FOREIGN KEY fk_backup_sets_schedule') < down.indexOf('DROP TABLE IF EXISTS backup_schedules'));
assert(down.indexOf('DROP TABLE IF EXISTS backup_restore_drill_runs') < down.indexOf('DROP TABLE IF EXISTS backup_restore_drill_schedules'));
assert.strictEqual(splitStatements(up).length, 6, 'All up statements must be parsed by the migration runner.');
assert.strictEqual(splitStatements(down).length, 6, 'All down statements must be parsed by the migration runner.');

console.log('Backup automation and restore-drill schema migration tests: PASS');
