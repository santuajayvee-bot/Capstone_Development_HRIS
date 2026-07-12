const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'public/js/system-admin.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'public/pages/system-admin.html'), 'utf8');

const context = {
  window: {},
  document: { addEventListener() {} },
  console,
  setTimeout() {},
  clearTimeout() {},
  requestAnimationFrame(callback) { callback(); },
};
vm.createContext(context);
vm.runInContext(script, context, { filename: 'public/js/system-admin.js' });

const hooks = context.window.__backupRecoveryUiTestHooks;
assert(hooks, 'Backup UI test hooks must be available.');

const verifiedUsable = {
  artifact_available: true,
  artifact_verified: true,
  is_restorable: true,
  data_backup_coverage: 'Covered',
};
assert.strictEqual(hooks.isRestorableBackupArtifact(verifiedUsable), true);
assert.strictEqual(hooks.backupArtifactReadiness(verifiedUsable), 'USABLE');
assert.strictEqual(hooks.backupCoverageStatus(verifiedUsable, 'data'), 'COVERED');

for (const unsafe of [
  { artifact_available: false, artifact_verified: true, is_restorable: true },
  { artifact_available: true, artifact_verified: false, is_restorable: true },
  { artifact_available: true, artifact_verified: true, is_restorable: false },
  { status: 'COMPLETED' },
  { status: 'VERIFIED' },
]) {
  assert.strictEqual(
    hooks.isRestorableBackupArtifact(unsafe),
    false,
    `Artifact must not be restorable from lifecycle status alone: ${JSON.stringify(unsafe)}`
  );
}

assert.strictEqual(
  hooks.backupCoverageStatus({ data_backup_coverage: 'Covered' }, 'data'),
  'NOT COVERED',
  'A backend coverage label without an explicit verified usable artifact must not display as covered.'
);
assert.strictEqual(
  hooks.isVerifiedRollbackPoint({ artifact_available: true, artifact_verified: true, rollback_available: true }),
  true
);
assert.strictEqual(
  hooks.isVerifiedRollbackPoint({ artifact_available: true, artifact_verified: false, rollback_available: true }),
  false
);
assert.strictEqual(
  hooks.isVerifiedRollbackRequestArtifact({
    artifact_location: 'safe/artifact.tar.gz',
    artifact_checksum: 'a'.repeat(64),
    verification_status: 'MATCH',
    integrity_status: 'PASSED',
  }),
  true,
  'A rollback response must require artifact evidence plus explicit verification and integrity results.'
);
assert.strictEqual(
  hooks.isVerifiedRollbackRequestArtifact({
    artifact_location: 'safe/artifact.tar.gz',
    artifact_checksum: 'a'.repeat(64),
    verification_status: 'MISMATCH',
    integrity_status: 'FAILED',
  }),
  false
);

assert.strictEqual(hooks.backupActionAllowed({ allowed_actions: ['RESTORE_APPROVE'] }, 'RESTORE_APPROVE'), true);
assert.strictEqual(hooks.backupActionAllowed({ allowed_actions: ['RESTORE_APPROVE'] }, 'RESTORE_EXECUTE'), false);
assert.strictEqual(hooks.backupActionAllowedAny({ can_approve: true }, ['RESTORE_APPROVE', 'APPROVE']), true);
assert.strictEqual(hooks.backupActionAllowedAny({}, ['RESTORE_APPROVE', 'APPROVE']), false);

for (const endpoint of [
  '/api/admin/backups/step-up/challenges',
  '/run`',
  '/verify`',
  '/approve`',
  '/dry-run`',
  '/execute`',
]) {
  assert(script.includes(endpoint), `Backup UI must call the lifecycle endpoint containing ${endpoint}.`);
}
for (const purpose of [
  'BACKUP_VERIFY',
  'RESTORE_APPROVE',
  'RESTORE_DRY_RUN',
  'RESTORE_EXECUTE',
  'ROLLBACK_APPROVE',
  'ROLLBACK_EXECUTE',
]) {
  assert(script.includes(purpose), `Backup UI must request the ${purpose} MFA purpose.`);
}

assert(!script.includes('SHA-256 manifest/checksum hash:'), 'The UI must never accept a user-supplied verification checksum.');
assert(script.includes("headers: { 'Idempotency-Key': idempotencyKey }"), 'Mutating recovery requests must carry an idempotency key.');
assert(script.includes("if (normalized !== 'CANCELLED')"), 'Manual restore/rollback completion and unprotected rejection must be blocked in the UI.');
assert(script.includes("payload: { approval_notes: notes }"), 'Checker approval notes must use the backend approval_notes contract.');
assert(script.includes("confirmation_phrase: confirmationPhrase.trim()"), 'Restore and rollback execution must carry the typed confirmation phrase.');
assert(script.includes("method: 'PATCH'") && script.includes("purpose: 'RESTORE_APPROVE'") && script.includes("purpose: 'ROLLBACK_APPROVE'"), 'Restore and rollback rejection must use checker MFA step-up before PATCH.');

assert(page.includes('id="backup-step-up-modal"'), 'Backup UI must include an MFA step-up dialog.');
assert(page.includes('autocomplete="one-time-code"'), 'MFA code input must use one-time-code autocomplete.');
assert(page.includes('isolated dry-run'), 'Restore lifecycle guidance must disclose isolated dry-run validation.');
assert(page.includes('maker-checker approval'), 'Recovery guidance must disclose maker-checker approval.');
assert(page.includes('Only artifacts reported by the backend as available and verified count as recovery coverage.'), 'Coverage semantics must be explicit.');

console.log('Backup and recovery UI workflow tests: PASS');
