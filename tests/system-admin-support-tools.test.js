const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const envExample = read('.env.example');
const admin = read('server/admin-rbac.js');
const migration = read('migrations/sqls/20260705130000_system_admin_support_tools-up.sql');
const downMigration = read('migrations/sqls/20260705130000_system_admin_support_tools-down.sql');
const healthMigration = read('migrations/sqls/20260705143000_system_health_checks-up.sql');
const healthDownMigration = read('migrations/sqls/20260705143000_system_health_checks-down.sql');
const performanceMigration = read('migrations/sqls/20260706100000_system_admin_performance_indexes-up.sql');
const performanceDownMigration = read('migrations/sqls/20260706100000_system_admin_performance_indexes-down.sql');
const healthHistoryMigration = read('migrations/sqls/20260706103000_system_health_history-up.sql');
const healthHistoryDownMigration = read('migrations/sqls/20260706103000_system_health_history-down.sql');
const systemAdminPage = read('public/pages/system-admin.html');
const blockchainPage = read('public/pages/blockchain.html');
const attendancePage = read('public/pages/attendance.html');
const authScript = read('public/js/auth.js');
const appScript = read('public/js/app.js');
const systemAdminScript = read('public/js/system-admin.js');
const systemAdminCss = read('public/css/system-admin.css');

assert(admin.includes('router.use(requireLevel4)'), 'System Admin support routes must require Level 4 access.');
assert(admin.includes("router.use(requirePermission('admin_panel:access'))"), 'System Admin support routes must require admin panel permission.');

for (const route of [
  '/system-health',
  '/blockchain-support/status',
  '/users/:userId/unlock',
  '/users/:userId/revoke-sessions',
  '/users/:userId/reset-mfa',
  '/support-tickets',
  '/backups/request',
  '/system-health/check',
  '/system-health/check/:moduleKey',
  '/system-health/history',
]) {
  assert(admin.includes(route), `Missing System Admin support route: ${route}`);
}

assert(admin.includes('identity_verified'), 'MFA reset must require identity verification confirmation.');
assert(admin.includes('MFA_TOTP_Secret_Encrypted = NULL'), 'MFA reset must clear encrypted TOTP secret.');
assert(admin.includes("Status = 'SUPERSEDED'"), 'MFA reset must supersede pending MFA challenges.');
assert(admin.includes('Revoked_At = NOW()'), 'Session support actions must revoke server-side sessions.');
assert(admin.includes('logAuditEntryWithExecutor'), 'Mutating support actions must write audit logs in transaction.');
assert(admin.includes('encryptColumnValue'), 'Support free-text fields must be encrypted before storage.');

assert(migration.includes('CREATE TABLE IF NOT EXISTS system_support_ticket'), 'Support ticket table migration missing.');
assert(migration.includes('CREATE TABLE IF NOT EXISTS system_backup_log'), 'Backup log table migration missing.');
assert(migration.includes('description_encrypted TEXT NULL'), 'Support ticket descriptions must be encrypted.');
assert(migration.includes('resolution_encrypted TEXT NULL'), 'Support ticket resolutions must be encrypted.');
assert(migration.includes('backup_location_encrypted TEXT NULL'), 'Backup locations must be encrypted.');
assert(migration.includes('notes_encrypted TEXT NULL'), 'Backup notes must be encrypted.');
assert(!/description\s+TEXT/i.test(migration), 'Do not add plaintext support ticket description storage.');
assert(!/resolution\s+TEXT/i.test(migration), 'Do not add plaintext support ticket resolution storage.');

assert(downMigration.includes('DROP TABLE IF EXISTS system_backup_log'), 'Down migration must drop backup log table.');
assert(downMigration.includes('DROP TABLE IF EXISTS system_support_ticket'), 'Down migration must drop support ticket table.');

assert(healthMigration.includes('CREATE TABLE IF NOT EXISTS system_health_checks'), 'System health checks table migration missing.');
assert(healthMigration.includes("status ENUM('ONLINE','WARNING','OFFLINE','MAINTENANCE')"), 'Health status enum must be explicit and MySQL-compatible.');
assert(healthMigration.includes('dependency_status TEXT NULL'), 'Health dependencies must be stored without requiring a nonportable JSON feature.');
assert(healthMigration.includes('UNIQUE KEY uq_system_health_checks_module_key'), 'Health module keys must be unique.');
assert(healthDownMigration.includes('DROP TABLE IF EXISTS system_health_checks'), 'Down migration must drop system health checks table.');
assert(performanceMigration.includes('idx_users_employee_id'), 'Performance migration must index user-employee joins.');
assert(performanceMigration.includes('idx_system_audit_log_module_timestamp'), 'Performance migration must index audit module/timestamp filters.');
assert(performanceDownMigration.includes('DROP INDEX idx_users_employee_id'), 'Performance down migration must drop user index.');
assert(performanceDownMigration.includes('DROP INDEX idx_system_audit_log_module_timestamp'), 'Performance down migration must drop audit index.');
assert(healthHistoryMigration.includes('CREATE TABLE IF NOT EXISTS system_health_check_history'), 'System health history table migration missing.');
assert(healthHistoryMigration.includes("trigger_type ENUM('MANUAL','SCHEDULED')"), 'Health history must distinguish manual and scheduled checks.');
assert(healthHistoryMigration.includes('idx_system_health_history_module_time'), 'Health history must index module/time trends.');
assert(healthHistoryDownMigration.includes('DROP TABLE IF EXISTS system_health_check_history'), 'Health history down migration must drop history table.');

assert(!systemAdminPage.includes('panel-blockchain-support'), 'Blockchain support UI must not remain inside System Admin tabs.');
assert(!systemAdminPage.includes('panel-biometric-settings'), 'Biometric settings UI must not remain inside System Admin tabs.');
assert(systemAdminPage.includes('id="sysadmin-tabs" hidden'), 'Legacy System Admin tab strip must be hidden when sections are sidebar modules.');
assert(systemAdminPage.includes('id="health-module-grid"'), 'System Health page must render module diagnostic cards.');
assert(systemAdminPage.includes('id="health-detail-modal"'), 'System Health page must include module details modal.');
assert(systemAdminPage.includes('id="health-history-tbody"'), 'System Health page must render recent history.');
assert(systemAdminPage.includes('id="health-run-status"'), 'System Health page must show health-check running status.');
assert(systemAdminPage.includes('id="health-run-check-btn"'), 'System Health page must have a bindable run-check button.');
assert(systemAdminPage.includes('id="health-detail-probable-cause"'), 'System Health details must show probable cause.');
assert(systemAdminPage.includes('id="health-detail-runbook"'), 'System Health details must show runbook steps.');
assert(systemAdminPage.includes('id="health-detail-drilldowns"'), 'System Health details must show drilldown actions.');
assert(systemAdminPage.includes('value="SYSTEM_HEALTH"'), 'Audit Trail must include System Health module filter.');
assert(blockchainPage.includes('bc-view-support'), 'Blockchain support view must live inside the Blockchain module.');
assert(attendancePage.includes('bio-device-settings-card'), 'Biometric settings must live inside Attendance Sync.');
assert(authScript.includes("params: { attTab: 'biometric' }"), 'Attendance Sync sidebar link must target the biometric tab.');
assert(authScript.includes("params: { blockchainView: 'support' }"), 'Blockchain Support sidebar link must target the blockchain support view.');
for (const tab of ['accounts', 'roles', 'audit', 'health', 'support', 'backups']) {
  assert(authScript.includes(`sysAdminTab: '${tab}'`), `System Admin sidebar must include ${tab} module entry.`);
}
for (const route of ['/admin/accounts', '/admin/rbac', '/admin/audit', '/admin/health', '/admin/support', '/admin/backups']) {
  assert(appScript.includes(route), `Missing System Admin sidebar route: ${route}`);
}
for (const key of [
  'dashboard',
  'authentication',
  'dpa_privacy',
  'account_management',
  'rbac',
  'employee_201',
  'organization_setup',
  'onboarding',
  'attendance',
  'attendance_sync',
  'leave',
  'operational_logs',
  'payroll_settings',
  'payroll',
  'payroll_approval',
  'payslip',
  'reports',
  'self_service',
  'audit_trail',
  'blockchain',
  'support_center',
  'backup_restore',
  'aws_readiness',
  'database',
]) {
  assert(admin.includes(`key: '${key}'`), `Missing health module definition: ${key}`);
  assert(systemAdminScript.includes(`['${key}'`), `Missing stale-backend health fallback module: ${key}`);
}
assert(admin.includes('checkAwsReadinessHealth'), 'System Health must include an AWS deployment readiness check.');
assert(admin.includes('DB_SSL'), 'AWS readiness check must verify RDS TLS readiness.');
assert(admin.includes('AES_ENCRYPTION_KEY'), 'AWS readiness check must verify AES key readiness.');
assert(admin.includes('AWS_S3_BUCKET'), 'AWS readiness check must verify S3 backup bucket readiness.');
assert(systemAdminScript.includes("['aws_readiness', 'AWS Deployment Readiness'"), 'System Health stale-backend fallback must include AWS readiness.');
for (const fn of ['runSystemHealthCheck', 'runSystemModuleHealthCheck', 'openSystemHealthDetails', 'filterSystemHealthModules']) {
  assert(systemAdminScript.includes(`window.${fn}`), `System Health UI must expose ${fn}.`);
}
assert(systemAdminScript.includes('SYS_HEALTH_FALLBACK_MODULES'), 'System Health UI must show fallback module cards when backend is stale.');
assert(systemAdminScript.includes('Restart npm start'), 'System Health UI must explain stale backend route failures.');
assert(systemAdminScript.includes('/api/admin/system-health/check'), 'System Health UI must call full health-check endpoint.');
assert(systemAdminScript.includes('/api/admin/system-health/check/${encodeURIComponent(moduleKey)}'), 'System Health UI must call per-module health-check endpoint.');
assert(systemAdminScript.includes('/api/admin/system-health/history?limit=30'), 'System Health UI must load recent health history.');
assert(systemAdminScript.includes('bindSystemHealthButtons'), 'System Health UI must bind health buttons through delegated events.');
assert(systemAdminScript.includes("data-health-action=\"details\""), 'System Health module cards must bind View Details buttons.');
assert(systemAdminScript.includes("data-health-action=\"check-module\""), 'System Health module cards must bind Check Module buttons.');
assert(systemAdminScript.includes("data-health-action=\"drilldown\""), 'System Health details must bind drilldown action buttons.');
assert(systemAdminScript.includes('systemHealthDrilldownActions'), 'System Health UI must build module drilldown actions.');
assert(systemAdminScript.includes('runSystemHealthDrilldownAction'), 'System Health UI must execute drilldown actions.');
assert(systemAdminScript.includes('prefillSystemHealthSupportTicket'), 'System Health UI must prefill support tickets from module results.');
assert(systemAdminScript.includes('SYS_HEALTH_AUDIT_MODULES'), 'System Health drilldowns must map modules to audit filters.');
assert(systemAdminScript.includes('SYS_HEALTH_RELATED_NAV'), 'System Health drilldowns must map modules to related navigation.');
assert(systemAdminCss.includes('health-drilldown-btn'), 'System Health drilldown actions must be styled.');
assert(systemAdminScript.includes('setSystemHealthRunning'), 'System Health UI must show running state while checks execute.');
assert(systemAdminScript.includes('health-run-status'), 'System Health UI must update the running status panel.');
assert(admin.includes('SYSTEM_HEALTH_MODULE_TIMEOUT_MS'), 'System Health module timeout must be controlled by env.');
assert(admin.includes('SYSTEM_HEALTH_SLOW_WARNING_MS'), 'System Health slow-check threshold must be controlled by env.');
assert(admin.includes('SYSTEM_HEALTH_CHECK_CONCURRENCY'), 'System Health concurrency must be controlled by env.');
assert(admin.includes('withSystemHealthTimeout'), 'System Health checks must enforce per-module timeout.');
assert(admin.includes('runWithConcurrency'), 'System Health full checks must use controlled concurrency.');
assert(admin.includes('SYSTEM_HEALTH_AUTO_CHECK_ENABLED'), 'System Health scheduler must be controlled by env.');
assert(admin.includes('SYSTEM_HEALTH_INTERVAL_MINUTES'), 'System Health scheduler interval must be configurable by env.');
assert(envExample.includes('SYSTEM_HEALTH_MODULE_TIMEOUT_MS=5000'), 'Env example must document System Health module timeout.');
assert(envExample.includes('SYSTEM_HEALTH_SLOW_WARNING_MS=3000'), 'Env example must document System Health slow-check threshold.');
assert(envExample.includes('SYSTEM_HEALTH_CHECK_CONCURRENCY=4'), 'Env example must document System Health concurrency.');
assert(admin.includes("triggerType: 'SCHEDULED'"), 'Scheduled System Health checks must persist as scheduled history.');
assert(admin.includes('SYSTEM_HEALTH_REMEDIATION'), 'System Health modules must include remediation metadata.');
assert(admin.includes('probable_cause'), 'System Health response must include probable cause.');
assert(admin.includes('runbook_steps'), 'System Health response must include runbook steps.');
assert(admin.includes('systemHealthHistoryRows'), 'System Health check responses must include current-run history rows.');
assert(admin.includes('mergeSystemHealthHistoryRows'), 'System Health check responses must merge current-run and stored history.');
assert(systemAdminScript.includes('health-detail-probable-cause'), 'System Health UI must render probable cause.');
assert(systemAdminScript.includes('health-detail-runbook'), 'System Health UI must render runbook steps.');
assert(systemAdminScript.includes('applySystemHealthHistory'), 'System Health UI must preserve current-run history when stored history is empty.');
assert(systemAdminScript.includes('healthHistoryRowsFromModules'), 'System Health UI must create fallback history rows from completed module results.');
assert(systemAdminScript.includes('mergeSystemHealthHistory'), 'System Health UI must merge new and existing history rows.');
assert(systemAdminScript.includes('/api/admin/users?include_stats=1'), 'Account Management must use lightweight account stats endpoint.');
assert(systemAdminScript.includes('ensureSysAdminEmployeesLoaded'), 'Employee directory must be loaded lazily for account registration.');
assert(systemAdminScript.includes("limit: '50'"), 'Audit Trail must use a smaller default page size.');
assert(!systemAdminScript.includes('setInterval(() => {') || systemAdminScript.includes('}, 30000);'), 'Account refresh interval should not poll every 5 seconds.');

console.log('System Admin support tools checks passed.');
