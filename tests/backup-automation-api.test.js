'use strict';

process.env.NODE_ENV = 'test';
process.env.DB_USER ||= 'test';
process.env.DB_PASSWORD ||= 'test-only';
process.env.DB_NAME ||= 'test';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { splitStatements } = require('../database/mysql-compatible-migration');
const pool = require('../config/db');
const router = require('../server/backup-recovery');

const {
  clampPaginationToTotal,
  drillMutation,
  normalizeAutomationTiming,
  paginationOptions,
  retentionMutation,
  scheduleMutation,
} = router._test;

function expectCode(callback, code) {
  assert.throws(callback, error => error?.code === code, `Expected ${code}.`);
}

async function run() {
  const root = path.join(__dirname, '..');
  const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
  const wrapper = read('migrations/20260714123000-backup-automation-action-idempotency.js');
  const up = read('migrations/sqls/20260714123000_backup_automation_action_idempotency-up.sql');
  const down = read('migrations/sqls/20260714123000_backup_automation_action_idempotency-down.sql');
  const route = read('server/backup-recovery.js');
  const automationService = read('services/backup/backupAutomationService.js');

  assert(wrapper.includes('20260714123000_backup_automation_action_idempotency-up.sql'));
  assert(wrapper.includes('20260714123000_backup_automation_action_idempotency-down.sql'));
  assert(up.includes('CREATE TABLE IF NOT EXISTS backup_automation_action_requests'));
  assert(up.includes('id BIGINT AUTO_INCREMENT PRIMARY KEY'));
  assert(up.includes('uq_backup_automation_action_idempotency UNIQUE (idempotency_key)'));
  assert(up.includes("ENUM('SCHEDULE_RUN','RETENTION_UPDATE','RETENTION_RUN','DRILL_RUN')"));
  assert(up.includes('FOREIGN KEY (step_up_challenge_id) REFERENCES backup_step_up_challenges(id)'));
  assert(up.includes('ADD COLUMN IF NOT EXISTS idempotency_key'));
  assert(up.includes('ADD COLUMN IF NOT EXISTS request_fingerprint'));
  assert(down.includes('DROP TABLE IF EXISTS backup_automation_action_requests'));
  assert.strictEqual(splitStatements(up).length, 2);
  assert.strictEqual(splitStatements(down).length, 2);

  for (const endpoint of [
    "'/schedules'",
    "'/schedules/:scheduleId/run-now'",
    "'/retention-policy'",
    "'/retention/run'",
    "'/notifications'",
    "'/notifications/:notificationId/read'",
    "'/restore-drills'",
    "'/restore-drills/:drillId/run-now'",
    "'/provider-readiness'",
  ]) assert(route.includes(endpoint), `Missing automation endpoint ${endpoint}.`);
  assert(route.includes("purpose: 'SCHEDULE_RUN'"));
  assert(route.includes("purpose: 'RETENTION_EXECUTE'"));
  assert(route.includes("purpose: 'DRILL_RUN'"));
  assert(route.includes('backupAutomation.start()'));
  assert(route.includes("row.retention_status === 'ACTIVE'"), 'Expired/deleted artifacts must not count as available coverage.');
  assert(automationService.includes("retention_status='ACTIVE' AND artifact_deleted_at IS NULL"));
  assert(automationService.includes("rj.status IN ('AWAITING_APPROVAL','APPROVED','DRY_RUN_IN_PROGRESS'"));
  assert(automationService.includes("SET status='EXPIRED',rollback_available=0"));

  const page = paginationOptions({ page: 999, page_size: 500, search: '<payroll>' });
  assert.strictEqual(page.pageSize, 100);
  assert.strictEqual(page.search, 'payroll');
  clampPaginationToTotal(page, 201);
  assert.strictEqual(page.page, 3);
  assert.strictEqual(page.offset, 200);

  assert.deepStrictEqual(normalizeAutomationTiming({ frequency: 'WEEKLY', run_time: '03:30', day_of_week: 7 }), {
    frequency: 'WEEKLY',
    run_time: '03:30:00',
    day_of_week: 7,
    day_of_month: null,
    timezone: 'Asia/Manila',
  });
  expectCode(
    () => normalizeAutomationTiming({ frequency: 'WEEKLY', run_time: '03:30', day_of_week: 0 }),
    'INVALID_AUTOMATION_DAY'
  );

  const schedule = scheduleMutation({
    schedule_name: 'Nightly database backup',
    backup_type: 'DATABASE',
    storage_provider: 'LOCAL',
    included_modules: ['payroll', 'reports'],
    frequency: 'DAILY',
    run_time: '02:00',
    timezone: 'Asia/Manila',
    enabled: true,
  });
  assert(schedule.next_run_at instanceof Date);
  assert.deepStrictEqual(schedule.included_modules, ['payroll', 'reports']);
  expectCode(() => scheduleMutation({
    schedule_name: 'Invalid RDS files',
    backup_type: 'FILES',
    storage_provider: 'RDS_SNAPSHOT',
    included_modules: ['file_storage'],
    frequency: 'DAILY',
    run_time: '02:00',
  }), 'BACKUP_PROVIDER_TYPE_MISMATCH');

  const retention = retentionMutation({
    policy_name: 'Default retention',
    backup_type: 'ALL',
    storage_provider: 'ALL',
    keep_last: 7,
    max_age_days: 90,
    delete_expired_artifacts: false,
    enabled: false,
  });
  assert.strictEqual(retention.backup_type, null);
  assert.strictEqual(retention.storage_provider, null);
  expectCode(() => retentionMutation({ policy_name: 'Bad', keep_last: 0, max_age_days: 1 }), 'INVALID_AUTOMATION_INPUT');

  const drill = drillMutation({
    drill_name: 'Weekly S3 database drill',
    backup_type: 'DATABASE',
    storage_provider: 'S3',
    affected_module: 'payroll',
    frequency: 'WEEKLY',
    run_time: '03:00',
    day_of_week: 7,
    enabled: false,
  });
  assert.strictEqual(drill.storage_provider_filter, 'S3');
  assert.strictEqual(drill.module_key_filter, 'payroll');
  assert.strictEqual(drill.next_run_at, null);

  console.log('Backup automation API and idempotency tests: PASS');
}

run()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
