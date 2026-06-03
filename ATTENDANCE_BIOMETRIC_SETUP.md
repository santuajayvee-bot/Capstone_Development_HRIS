# Attendance Biometric Integration Setup

The attendance module stores biometric reference IDs and attendance metadata only. It does not store fingerprint templates, fingerprint images, or vendor biometric payloads.

## 1. Apply the schema

```powershell
npm run migrate:attendance-biometric
```

The migration is idempotent. Existing QR attendance records are preserved, summarized for payroll, and added to the local integrity chain.

## 2. Configure transport security

Production deployments must use TLS 1.3:

- Set `TLS_CERT_PATH` and `TLS_KEY_PATH` when Node terminates HTTPS directly.
- Alternatively, terminate TLS 1.3 at a trusted reverse proxy and forward only to the private application network.
- Set `DB_SSL=true` and provide the MySQL CA and client certificate paths when the database supports TLS.
- Enable MySQL tablespace, disk, or managed-service encryption at rest using AES-256 for structured employee and attendance data.

Outbound biometric and blockchain API adapters reject non-HTTPS URLs unless the development-only `ALLOW_INSECURE_BIOMETRIC_API=true` flag is set outside production.

## 3. Register a biometric device

Sign in as `system_admin`, open **Attendance Sync**, and register the device. Supported authentication modes are:

- `API_KEY`
- `BEARER`
- `HMAC`
- `OAUTH2`
- `MTLS`

API secrets and tokens are encrypted with AES-256-GCM before storage.

Map each vendor biometric user reference to an active employee. The mapping stores:

- `device_id`
- `employee_id`
- encrypted biometric user reference
- SHA-256 lookup hash

## 4. Webhook contract

Vendor devices or middleware can push attendance events to:

```text
POST /api/attendance/biometric/webhook/:deviceReference
```

Example payload:

```json
{
  "events": [
    {
      "external_event_id": "scan-10001",
      "biometric_user_id": "vendor-user-42",
      "scan_timestamp": "2026-05-31T08:03:00+08:00",
      "attendance_type": "TIME_IN"
    }
  ]
}
```

`attendance_type` accepts `TIME_IN`, `TIME_OUT`, or `AUTO`. Common aliases such as `IN`, `OUT`, `CLOCK_IN`, and `CLOCK_OUT` are normalized.

For `API_KEY`, send the configured header, which defaults to:

```text
x-biometric-api-key: your-secret
```

For `HMAC`, send:

```text
x-biometric-timestamp: Unix timestamp in seconds
x-biometric-signature: sha256=<hex HMAC>
```

The HMAC input is:

```text
<timestamp>.<raw JSON request body>
```

Requests older than five minutes are rejected.

## 5. Pull synchronization

When a vendor API exposes attendance logs, configure its HTTPS base URL and logs endpoint. A system administrator can trigger synchronization from **Attendance Sync** or call:

```text
POST /api/attendance/biometric/sync/:deviceId
```

Failed requests, rejected events, duplicate scans, and synchronization status are recorded for monitoring.

## 6. Payroll and blockchain adapter

Only validated attendance with both a time-in and time-out becomes payroll eligible.

Each attendance version is SHA-256 chained in `attendance_integrity_chain`. To submit queued hashes to the permissioned blockchain adapter, configure `BLOCKCHAIN_API_URL` and trigger:

```text
POST /api/attendance/integrity/anchor-pending
```

The external blockchain adapter is expected to accept attendance anchors at:

```text
POST /api/attendance/anchors
```

The module records the returned `transaction_id`, `reference`, or `id` as its anchor reference.

## 7. Vendor handoff checklist

Before production integration, obtain these details from Marulas Industrial Corporation or its biometric vendor:

- API base URL and logs endpoint
- push webhook support, pull API support, or both
- exact user reference field mapped to employee records
- authentication method and credential rotation procedure
- event timestamp timezone
- punch-type values
- retry behavior and vendor event ID guarantees
- certificate authority and mTLS client certificate requirements

Run the repeatable integration test after setup:

```powershell
npm run test:attendance-biometric
```
