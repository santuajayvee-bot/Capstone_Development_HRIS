const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const admin = read('server/admin-rbac.js');
const migration = read('migrations/sqls/20260705130000_system_admin_support_tools-up.sql');
const downMigration = read('migrations/sqls/20260705130000_system_admin_support_tools-down.sql');
const healthMigration = read('migrations/sqls/20260705143000_system_health_checks-up.sql');
const healthDownMigration = read('migrations/sqls/20260705143000_system_health_checks-down.sql');
const systemAdminPage = read('public/pages/system-admin.html');
const blockchainPage = read('public/pages/blockchain.html');
const attendancePage = read('public/pages/attendance.html');
const authScript = read('public/js/auth.js');
const appScript = read('public/js/app.js');
const systemAdminScript = read('public/js/system-admin.js');

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

assert(!systemAdminPage.includes('panel-blockchain-support'), 'Blockchain support UI must not remain inside System Admin tabs.');
assert(!systemAdminPage.includes('panel-biometric-settings'), 'Biometric settings UI must not remain inside System Admin tabs.');
assert(systemAdminPage.includes('id="sysadmin-tabs" hidden'), 'Legacy System Admin tab strip must be hidden when sections are sidebar modules.');
assert(systemAdminPage.includes('id="health-module-grid"'), 'System Health page must render module diagnostic cards.');
assert(systemAdminPage.includes('id="health-detail-modal"'), 'System Health page must include module details modal.');
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
for (const key of ['authentication', 'account_management', 'rbac', 'employee_201', 'attendance_sync', 'backup_restore']) {
  assert(admin.includes(`key: '${key}'`), `Missing health module definition: ${key}`);
}
for (const fn of ['runSystemHealthCheck', 'runSystemModuleHealthCheck', 'openSystemHealthDetails', 'filterSystemHealthModules']) {
  assert(systemAdminScript.includes(`window.${fn}`), `System Health UI must expose ${fn}.`);
}
assert(systemAdminScript.includes('SYS_HEALTH_FALLBACK_MODULES'), 'System Health UI must show fallback module cards when backend is stale.');
assert(systemAdminScript.includes('Restart npm start'), 'System Health UI must explain stale backend route failures.');
assert(systemAdminScript.includes('/api/admin/system-health/check'), 'System Health UI must call full health-check endpoint.');
assert(systemAdminScript.includes('/api/admin/system-health/check/${encodeURIComponent(moduleKey)}'), 'System Health UI must call per-module health-check endpoint.');

console.log('System Admin support tools checks passed.');
