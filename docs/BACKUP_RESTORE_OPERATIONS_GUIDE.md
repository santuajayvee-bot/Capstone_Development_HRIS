# LGSV HR Backup and Restore Operations Guide

This guide explains how the LGSV HR backup, restore, rollback, retention, and restore-drill transactions work. The module is restricted to an authenticated System Administrator. It uses a fixed single-administrator workflow: the same System Administrator creates, runs, verifies, requests, approves, dry-runs, and executes the protected transaction. Destructive or recovery-sensitive actions still require a fresh authenticator-code challenge, confirmation, idempotency protection, integrity checks, and audit logging.

## 1. What is actually backed up?

| Backup type | Contents | Normal recovery use |
|---|---|---|
| `DATABASE` | MySQL/RDS database data and integrity evidence | Database restore |
| `FILES` | Allowlisted uploaded/document files | Recover files into a staged recovery output |
| `CONFIGURATION` | Non-secret, allowlisted application configuration | Recover configuration into a staged output |
| `MODULE_STATE` | Database, files/configuration, and selected module state | Module-level recovery |
| `DEPLOYMENT_VERSION` | Server-owned allowlisted source code, manifest, hashes, and version evidence | Controlled module rollback/code replacement |
| `FULL_BACKUP` | Database, files, configuration, and allowlisted source code | Full recovery or controlled module rollback |

`DEPLOYMENT_VERSION` and `FULL_BACKUP` are the backup types used when a broken module must be restored to verified source code. The system does not copy arbitrary paths supplied by the browser. The server owns the source-code allowlist, validates hashes and syntax, stages the recovered code, and performs transactional cutover/rollback.

Storage providers:

- `LOCAL`: encrypted private local artifact storage for development or a protected server volume.
- `S3`: encrypted artifacts in the configured Amazon S3 bucket/prefix.
- `RDS_SNAPSHOT`: an encrypted RDS snapshot; valid only for `DATABASE` backups.

## 2. Before using the module

1. Sign in as a System Administrator.
2. The administrator account must be active, linked to an employee record, have accepted the current data-privacy agreement, and have TOTP MFA enrolled.
3. Open **System Administration → Backup & Restore**.
4. Check **Settings**. A provider is usable only when its readiness card reports ready.
5. Run the migrations before starting a newly deployed application:

   ```powershell
   npm run migrate
   npm start
   ```

Never place AWS access keys, database passwords, encryption keys, or MFA secrets in the browser or database records. Production should use an EC2 instance role and server-side environment/secret management.

### Single-administrator approval

The same authenticated System Administrator completes the entire backup, restore, or rollback flow. Each verification, approval, dry-run, and execution requests a new MFA challenge. Typed confirmation, idempotency controls, checksum validation, integrity checks, and audit logging remain mandatory. The browser cannot disable these safeguards.

## 3. Manual backup transaction

1. In **Backup Sets**, select the backup type, provider, and covered modules.
2. Submit the backup request. The server validates RBAC and input, records an idempotency key, writes an audit entry, and creates a `PENDING` transaction.
3. Select **Run backup**. The worker moves the transaction through `PENDING → RUNNING → COMPLETED`, generates the artifact, stores it, calculates SHA-256 server-side, and records the protected storage location.
4. Open the **Action Inbox** and select the verification notification.
5. Select **Verify** and enter a fresh authenticator code. The same System Administrator verifies the stored artifact against the server-generated checksum.
6. A successful check moves the transaction to `VERIFIED`. Only now does it count as dashboard coverage or become eligible for restore/drill selection.

Important transaction rules:

- Repeating a request with the same idempotency key returns the original transaction.
- The same System Administrator who created the backup verifies it using a new MFA challenge.
- `COMPLETED` means bytes were created; it is not yet trusted backup coverage.
- `VERIFIED` means the stored bytes match the server-generated checksum and the MFA-protected verification completed.
- A checksum mismatch is recorded as failed integrity evidence and is never accepted as coverage.

## 4. Automated backup schedules

1. Open **Automation**.
2. Enter a schedule name, backup type, provider, modules, frequency, time, and timezone.
3. Supported frequencies are hourly, daily, weekly, and monthly. Weekly days use Monday=1 through Sunday=7. Month-end schedules safely use the last available day when a configured day does not exist.
4. Save and enable the schedule.

At each due time, the background service atomically claims the schedule, advances `next_run_at`, creates a normal auditable backup transaction, and runs the worker. A scheduled backup stops at `COMPLETED`; the System Administrator still completes MFA-protected verification before it becomes `VERIFIED`.

**Run now with MFA** executes the same transaction immediately. It uses a protected idempotency ledger, so a lost/retried network response cannot create a duplicate run.

To stop future jobs, select **Disable**. Disabling a schedule does not delete prior backup evidence.

## 5. Action Inbox

The inbox creates action items for:

- completed backup artifacts awaiting checksum verification;
- restore requests awaiting administrator approval;
- rollback requests awaiting administrator approval;
- failed retention cleanup or restore drills that need review.

The Action Inbox is the signed-in System Administrator's protected work queue. Opening or marking a notification as read never completes the action. The administrator must review the item and use fresh MFA for its verification or approval step. When the underlying action is completed, the notification becomes `RESOLVED` instead of being silently deleted.

## 6. Restore process for data, files, and configuration

1. Select a `VERIFIED` backup and choose **Request restore**.
2. Enter the reason, affected module when applicable, and the confirmation phrase. The transaction becomes `AWAITING_APPROVAL`.
3. The same System Administrator reviews the request in the Action Inbox, enters fresh MFA, and approves it. Status becomes `APPROVED`.
4. Run **Isolated dry-run** with another fresh MFA challenge. The system verifies the artifact and restores into a disposable/staged target, not production.
5. The dry-run must pass checksum, bundle, and post-restore integrity checks. Status becomes `DRY_RUN_PASSED`.
6. Run **Execute restore** with fresh MFA and the required confirmation phrase. Server configuration must explicitly allow and identify the recovery target.
7. The server performs post-restore verification before marking the job `COMPLETED`.

For an RDS snapshot, execution always restores to a new `lgsv-restore-*` RDS instance. It never overwrites the source RDS instance. The job remains in target-verification state until the isolated instance is available and its infrastructure/database integrity checks pass.

## 7. Restoring broken module code

Use the rollback workflow for source-code replacement:

1. Create and verify a `DEPLOYMENT_VERSION` or `FULL_BACKUP` artifact with fresh MFA.
2. Open its published module recovery point and request a rollback with a reason.
3. The same System Administrator approves the rollback request with fresh MFA.
4. Execute with a separate fresh MFA challenge and the rollback confirmation phrase.
5. The runtime validates the source manifest, syntax, and hashes; saves a transaction snapshot; stages the verified code; atomically replaces only allowlisted module paths; and verifies post-cutover hashes.
6. If cutover verification fails, the saved transaction snapshot is restored automatically. Health/audit history records the maintenance and result states.

Directly editing a finalized backup/restore row or copying arbitrary browser-supplied source paths is not allowed.

## 8. Retention and expired-artifact cleanup

1. In **Automation**, create a disabled retention-policy draft.
2. Configure scope, `keep_last`, maximum age, and whether physical artifact deletion is allowed.
3. Save/enable it with fresh MFA.
4. Select **Clean Expired Artifacts** and complete a new MFA challenge to run it immediately. Enabled policies also run automatically after scheduled drills.

An artifact is eligible only when all of these are true:

- it is `VERIFIED` or `RESTORED`;
- it is outside the newest `keep_last` artifacts in the policy scope;
- its verified/completed age exceeds `max_age_days`;
- no active safety condition blocks deletion.

With physical deletion off, the record becomes `EXPIRED` and the stored bytes remain. With deletion on, LOCAL/S3 bytes can be deleted and the database row becomes `DELETED`, but identifiers, checksums, actors, dates, and audit evidence remain. RDS snapshot deletion additionally requires `AWS_RDS_ALLOW_RETENTION_DELETE=true` and managed-snapshot identity checks.

Unverified artifacts never count toward the copies that must be preserved.

## 9. Scheduled restore drills

1. Open **Restore Drills**.
2. Select the backup type, exact artifact provider (LOCAL, S3, or RDS snapshot), optional module, frequency, and timezone.
3. Save/enable the drill or select **Run drill with MFA**.

The drill selects only the latest eligible artifact with `VERIFIED`, checksum `MATCH`, and integrity `PASSED`. LOCAL/S3 artifacts are materialized into an isolated target and checked. A database dump must restore into the dedicated disposable database before it passes.

An RDS drill is a real isolated recovery test:

1. It restores the snapshot to a tagged `lgsv-restore-drill-*` instance.
2. It waits for availability and verifies that the instance is private, encrypted, and linked to the expected source snapshot.
3. It connects with the read-only TLS verification account and compares schema/table/optional row-count integrity with backup-time evidence.
4. It deletes only the matching tagged disposable instance with no final snapshot.

The production/source RDS instance cannot pass the drill-deletion safety checks. A failed integrity check or failed cleanup creates an administrator notification. A drill never calls production cutover.

## 10. Production S3 and RDS configuration

Use server environment variables or AWS secret management; do not add values to source control.

S3 artifact storage requires:

- `AWS_REGION`
- `AWS_S3_BUCKET`
- `AWS_S3_BACKUP_PREFIX`
- optional `AWS_S3_KMS_KEY_ID` for KMS encryption

The EC2 instance role should be limited to the configured bucket/prefix and the required `s3:PutObject`, `s3:GetObject`, `s3:HeadObject`, `s3:ListBucket`, and retention-controlled `s3:DeleteObject` actions. If KMS is used, grant only the required encrypt/decrypt/data-key permissions for that key. Keep the bucket private, block public access, and enforce TLS.

RDS snapshot backup and isolated drills require:

- `AWS_REGION`
- `AWS_RDS_DB_INSTANCE_IDENTIFIER`
- `AWS_RDS_RESTORE_INSTANCE_CLASS`
- `AWS_RDS_RESTORE_SUBNET_GROUP`
- `AWS_RDS_RESTORE_SECURITY_GROUP_IDS`
- `AWS_RDS_RESTORE_WAIT_FOR_AVAILABLE=true`
- `BACKUP_RDS_VERIFY_DB_USER`
- `BACKUP_RDS_VERIFY_DB_PASSWORD`
- `BACKUP_RDS_VERIFY_DB_NAME`
- `BACKUP_RDS_VERIFY_DB_SSL=true`

The instance role needs narrowly scoped RDS snapshot create/describe/delete, restore/describe/delete DB instance, wait/describe, and tag-list/tag-write permissions for managed LGSV resources. Production retention snapshot deletion remains separately disabled unless `AWS_RDS_ALLOW_RETENTION_DELETE=true`.

The verification database account should be read-only and network-restricted to the application/drill security groups. It needs only the metadata and table reads required for integrity checks. It must not have DDL, write, account-management, or production-administration privileges.

## 11. Search and large histories

Backup sets, recovery points, restore jobs, and rollback requests use server-side search and pagination. Search terms and status/type/module filters are bound as SQL parameters. Changing page size retrieves only that page from MySQL; the browser does not download the entire history.

## 12. Status reference

Backup: `PENDING → RUNNING → COMPLETED → VERIFIED` (or `FAILED`/`CANCELLED`; `RESTORED` after successful recovery evidence).

Restore: `AWAITING_APPROVAL → APPROVED → DRY_RUN_IN_PROGRESS → DRY_RUN_PASSED → IN_PROGRESS → VERIFYING → COMPLETED`.

Rollback: `AWAITING_APPROVAL → APPROVED → IN_PROGRESS → VERIFYING → COMPLETED`.

Restore drill: `QUEUED/RUNNING → PASSED`, `FAILED`, or `SKIPPED` when no eligible verified artifact exists.

## 13. Verification commands

### Safe manual UI test for a one-admin client

Use a local/development environment and the `LOCAL` provider. Do not test by executing a live restore against production.

1. Start the server, sign in as the System Administrator, and confirm that TOTP MFA is enrolled.
2. Create a `CONFIGURATION` backup covering a small module such as `reports`, then select **Run backup**.
3. Confirm the backup reaches `COMPLETED`, has a SHA-256 checksum, and does **not** count as verified coverage yet.
4. Open the Action Inbox, select **Verify**, and enter a newly generated authenticator code. Confirm the same backup reaches `VERIFIED`, checksum status is `MATCH`, and integrity is `PASSED`.
5. Select **Request restore**, choose `CONFIGURATION`, enter a clear test reason, and type `RESTORE`.
6. Open the approval action, select **Approve**, and enter a new authenticator code. Confirm the job reaches `APPROVED`.
7. Select **Isolated dry-run**, enter another new authenticator code, and wait for `DRY_RUN_PASSED` with integrity `PASSED`.
8. Select **Cancel**. Confirm the final restore status is `CANCELLED`. Do **not** select **Execute restore** merely to prove that the module works.
9. Check the Audit Logs for backup create/run/complete/verify and restore request/approve/cancel entries. Confirm the backup creator/verifier and restore requester/approver are the same sole administrator, with separate consumed MFA proofs.

This test proves artifact creation, server-side checksum verification, single-admin approval, isolated restore validation, cancellation, idempotency, and audit evidence without changing live application configuration.

### Automated tests

Run the full focused regression suite:

```powershell
npm run test:backup-recovery
```

Run the safe localhost-only single-admin transaction test:

```powershell
$env:ALLOW_CONTROLLED_BACKUP_E2E='true'
node scripts/backup-restore-controlled-e2e.js --single-admin
```

The `--single-admin` test requires a System Administrator with enrolled TOTP MFA, a valid employee link, and an accepted data-privacy agreement. It uses the same account for backup create/run/verify and restore request/approve/dry-run/cancel. It never calls live restore execution and never logs credentials or MFA secrets.

Run the localhost-only controlled automation transaction test:

```powershell
$env:ALLOW_CONTROLLED_BACKUP_E2E='true'
node scripts/backup-restore-controlled-e2e.js --automation
```

All controlled tests refuse production and non-localhost targets. Never enable or execute a live production restore merely as a functional test. Real AWS restore drills should be scheduled only after the readiness card is green, IAM/network controls have been reviewed, and the disposable-instance cost window is understood.

## 14. Troubleshooting

- **Provider not configured**: open Settings and configure only the missing server-side variables shown by readiness diagnostics.
- **Backup remains COMPLETED**: the same System Administrator still needs to select **Verify** and complete the fresh MFA checksum check.
- **Verification or approval is unavailable**: refresh the workspace and confirm that the transaction is in the expected lifecycle status, the artifact is available, and the signed-in account is an active System Administrator with enrolled MFA.
- **Single-admin controlled test cannot start**: confirm localhost, non-production `NODE_ENV`, explicit `ALLOW_CONTROLLED_BACKUP_E2E=true`, a healthy server, current migrations, an employee-linked active System Administrator, accepted data-privacy agreement, and enrolled TOTP MFA.
- **No restore/drill candidate**: verify that type, provider, module, checksum, integrity, retention status, and `VERIFIED` state all match.
- **Policy does not clean anything**: an item must be older than the age limit and outside `keep_last`; disabled policies do not run.
- **Action already in progress**: wait for its worker lease. A stale protected action becomes retryable without duplicating its original occurrence.
- **RDS drill blocked**: require a private subnet/security group, wait-for-available, read-only verification credentials, SSL, matching database name, and the necessary IAM permissions.
- **RDS cleanup alert**: treat it as urgent because a disposable instance may still incur cost. Inspect AWS resource tags and internal audit logs; never delete the source instance.
