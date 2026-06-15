# LGSV HR Background Biometric Attendance

## Architecture

ZKTeco ZK9500 scanner -> LGSV ZK9500 background bridge -> fingerprint identification -> `POST /api/biometric/station-attendance` -> MySQL attendance record -> HR validation -> payroll-ready attendance summary.

Attendance no longer depends on an employee login, browser session, Attendance Station page, or Time In / Time Out buttons.

## Bridge Config

The bridge reads:

`C:\ProgramData\LGSV_HR\ZK9500Bridge\bridge-config.json`

Default development config:

```json
{
  "device_reference": "ZK9500-LOCAL-001",
  "hris_attendance_url": "http://localhost:3000/api/biometric/station-attendance",
  "auth_header_name": "x-biometric-api-key",
  "auth_secret": "",
  "background_scanner_enabled": true,
  "duplicate_local_cooldown_seconds": 60,
  "scanner_idle_delay_ms": 600,
  "listener_prefix": "http://localhost:8787/"
}
```

For AWS, change `hris_attendance_url`:

```json
"hris_attendance_url": "https://your-aws-domain.com/api/biometric/station-attendance"
```

If the biometric device in System Settings uses API key auth, set the same key in `auth_secret`.

## Windows Startup

Run PowerShell as Administrator:

```powershell
cd tools\biometric-bridge
.\install-background-service.ps1
```

To remove it:

```powershell
cd tools\biometric-bridge
.\uninstall-background-service.ps1
```

## Logs

Bridge service log:

`C:\ProgramData\LGSV_HR\ZK9500Bridge\bridge-service.log`

HRIS logs:

- `biometric_scan_event`
- `attendance_log`
- `attendance_summary`
- `system_audit_log`

## Attendance Rules

Configured in `attendance_policy_settings`:

- `duplicate_scan_window_seconds`
- `hr_validation_required`
- `multiple_scan_handling`
- `missing_timeout_handling`
- `overtime_handling`

Default flow:

1. First fingerprint match of the day records `TIME_IN`.
2. Second fingerprint match records `TIME_OUT`.
3. More scans are rejected by duplicate/multiple scan policy.
4. New biometric attendance starts as `PENDING_VALIDATION`.
5. HR validates/corrects/rejects the record.
6. Completed and approved records become payroll-eligible.

## Optional Monitoring

The Attendance Station page is now optional monitoring only. Attendance still works when no HRIS page is open.
