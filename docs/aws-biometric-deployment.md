# AWS Biometric Attendance Deployment

This setup hosts the LGSV HR API on AWS and lets the local ZK9500 biometric station post attendance scans over HTTPS.

The scanner hardware and matcher stay on the local Windows station. AWS stores only attendance metadata, encrypted biometric user references, SHA-256 lookup hashes, and audit logs. Do not upload fingerprint templates or fingerprint images to AWS.

## Target Architecture

```text
ZKTeco ZK9500 scanner
  -> LGSV ZK9500 Windows bridge
  -> HTTPS POST /api/biometric/station-attendance
  -> AWS EC2 or managed Node runtime
  -> AWS RDS MySQL with TLS
  -> attendance_log, biometric_scan_event, attendance_summary, system_audit_log
```

## AWS Runtime Requirements

Set these in the AWS runtime environment, Systems Manager Parameter Store, or Secrets Manager:

```text
NODE_ENV=production
APP_PUBLIC_URL=https://your-aws-domain.com
JWT_SECRET=<long random secret>
AES_ENCRYPTION_KEY=<64 hex characters>
DB_HOST=<rds-endpoint>
DB_PORT=3306
DB_USER=<runtime app user>
DB_PASSWORD=<runtime app password>
DB_NAME=lgsv_hr_db
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=true
AWS_TLS_TERMINATED_AT_LOAD_BALANCER=true
ALLOW_INSECURE_BIOMETRIC_API=false
ALLOW_UNAUTHENTICATED_BIOMETRIC_WEBHOOK=false
MFA_ENABLED=true
MFA_REQUIRE_ALL_USERS=false
MFA_TOTP_ISSUER=LGSV HR
```

Use `TLS_CERT_PATH` and `TLS_KEY_PATH` instead of `AWS_TLS_TERMINATED_AT_LOAD_BALANCER=true` only when Node terminates HTTPS directly.

## Database

Run migrations against AWS RDS MySQL with the migration account:

```powershell
npm run migrate
npm run migrate:attendance-biometric
```

RDS must use TLS in transit and encrypted storage. Keep database credentials out of source code and use environment variables or AWS secret storage.

## Register The AWS Biometric Device

Sign in as `system_admin`, then open Attendance Sync or System Administration biometric settings.

Create a device with:

```text
device_reference: ZK9500-AWS-001
device_name: AWS ZK9500 Attendance Station
vendor: ZKTeco
auth_type: API_KEY
auth_header_name: x-biometric-api-key
auth_secret: <32+ byte random secret>
is_active: 1
```

Do not use `NONE` authentication in AWS. The station endpoint rejects unauthenticated biometric devices in production.

Map each biometric reference to an active employee from Attendance Sync. The system stores the reference encrypted and stores a SHA-256 hash for lookup.

## Configure The Windows Bridge

On the biometric station PC, write:

```text
C:\ProgramData\LGSV_HR\ZK9500Bridge\bridge-config.json
```

Use [bridge-config.aws.example.json](../tools/biometric-bridge/bridge-config.aws.example.json) as the template:

```json
{
  "device_reference": "ZK9500-AWS-001",
  "hris_attendance_url": "https://your-aws-domain.com/api/biometric/station-attendance",
  "auth_header_name": "x-biometric-api-key",
  "auth_secret": "replace-with-the-device-api-key-from-system-admin",
  "background_scanner_enabled": true,
  "duplicate_local_cooldown_seconds": 60,
  "scanner_idle_delay_ms": 600,
  "listener_prefix": "http://localhost:8787/"
}
```

The local `listener_prefix` stays on localhost. Only `hris_attendance_url`, `device_reference`, and `auth_secret` need to match AWS.

Install or restart the background service:

```powershell
cd tools\biometric-bridge
.\install-background-service.ps1
```

## Verify Before Deploying

Run the AWS biometric configuration check:

```powershell
npm run security:verify-aws-biometric
```

Then verify the API and bridge:

```powershell
npm run test:attendance-biometric
```

Check the AWS app logs and database tables:

```text
biometric_scan_event
attendance_log
attendance_summary
system_audit_log
```

## Security Rules

- Use HTTPS only for the AWS station URL.
- Keep biometric API keys out of Git.
- Rotate the device API key if the station PC is replaced or compromised.
- Keep `ALLOW_UNAUTHENTICATED_BIOMETRIC_WEBHOOK=false` in AWS.
- Keep `ALLOW_INSECURE_BIOMETRIC_API=false` in AWS.
- Do not store fingerprint templates, fingerprint images, or raw vendor biometric payloads in AWS.
- Keep payroll blockchain anchoring separate from biometric raw data.
