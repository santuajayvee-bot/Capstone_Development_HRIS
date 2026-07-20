const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const scriptPath = path.join(__dirname, '..', 'scripts', 'backup-restore-controlled-e2e.js');
const script = fs.readFileSync(scriptPath, 'utf8');

function functionBlock(name, nextName) {
  const start = script.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} is missing from the controlled backup test.`);
  const end = nextName ? script.indexOf(`\nasync function ${nextName}(`, start) : script.length;
  assert.ok(end > start, `${name} could not be isolated for safety assertions.`);
  return script.slice(start, end);
}

const actorLookup = functionBlock('findTestActors', 'findSingleAdminActor');
const adminCount = functionBlock('countActiveSystemAdmins', 'findTemporaryEmployeeLink');
const workflow = functionBlock('runSingleAdminWorkflow', 'runAutomationWorkflow');

assert.ok(script.includes("process.argv.includes('--single-admin')"), 'The controlled runner must expose --single-admin mode.');
assert.ok(script.includes("assert.notEqual(String(process.env.NODE_ENV || 'development').toLowerCase(), 'production'"), 'Controlled testing must fail closed in production.');
assert.ok(script.includes("['127.0.0.1', 'localhost', '::1'].includes(url.hostname)"), 'Controlled testing must target localhost only.');
assert.ok(script.includes('TRIM(r.name)'), 'System Administrator role normalization must ignore surrounding whitespace.');

assert.ok(!script.includes('leaveOnlySystemAdminActive'), 'Controlled testing must never disable other System Administrator accounts.');
assert.ok(!script.includes('restoreSystemAdminStates'), 'No temporary administrator-state restoration should be necessary.');
assert.ok(!script.includes('auditControlledAdminToggle'), 'Controlled testing must not create artificial account-toggle audits.');
assert.ok(!script.includes('CONTROLLED_SINGLE_ADMIN_DEACTIVATE'), 'Controlled testing must not record administrator deactivation events.');
assert.ok(!workflow.includes('UPDATE users SET is_active'), 'The one-admin workflow must not change any administrator active state.');
assert.ok(!workflow.includes('temporarily_deactivated_admins'), 'Results must not imply that other administrators were temporarily disabled.');

assert.ok(adminCount.includes('SELECT COUNT(*) AS total'), 'The workflow must read the active administrator count without modifying accounts.');
assert.ok(workflow.includes('activeAdminCountBefore = await countActiveSystemAdmins()'), 'The workflow must capture the administrator count before testing.');
assert.ok(workflow.includes('activeAdminCountAfter = await countActiveSystemAdmins()'), 'The workflow must capture the administrator count after testing.');
assert.ok(/activeAdminCountAfter,\r?\n\s+activeAdminCountBefore/.test(workflow), 'The workflow must prove the administrator count is unchanged.');
assert.ok(workflow.includes('admin_account_states_changed: false'), 'The result must explicitly report unchanged administrator account states.');

assert.ok(actorLookup.includes('return { maker: operator, checker: operator }'), 'Legacy controlled scenarios must use the same System Administrator for both aliases.');
assert.ok(!actorLookup.includes('admins.length >= 2'), 'Controlled tests must not require two active System Administrators.');
assert.ok(!script.includes('MAKER_CHECKER_REQUIRED'), 'Controlled tests must not expect self-verification to be blocked.');

assert.ok(workflow.includes("freshStepUp(session.token, admin, 'BACKUP_VERIFY'"), 'The initiating MFA-enabled administrator must verify the backup.');
assert.ok(workflow.includes("freshStepUp(session.token, admin, 'RESTORE_APPROVE'"), 'The initiating MFA-enabled administrator must approve the restore request.');
assert.ok(workflow.includes("freshStepUp(session.token, admin, 'RESTORE_DRY_RUN'"), 'The initiating MFA-enabled administrator must authorize the isolated dry-run.');
assert.ok(workflow.includes("approval_mode: 'SINGLE_ADMIN_STEP_UP'"), 'The result must use the permanent one-admin approval-mode identifier.');
assert.ok(workflow.includes("status: 'CANCELLED'"), 'The safe workflow must cancel after the dry-run.');
assert.ok(!workflow.includes(`/restore-jobs/\${restoreJobId}/execute`), 'Controlled one-admin testing must never call live restore execution.');
assert.ok(workflow.includes('live_restore_executed: false'), 'The result must explicitly report that no live restore was executed.');

console.log('Controlled one-admin backup/restore safety checks passed.');
