ALTER TABLE device_audit_logs DROP INDEX idx_device_audit_user_risk_time;
ALTER TABLE device_sessions DROP INDEX idx_device_sessions_jwt;

ALTER TABLE device_audit_logs DROP COLUMN risk_level;
ALTER TABLE device_audit_logs DROP COLUMN login_status;
ALTER TABLE device_audit_logs DROP COLUMN location;
ALTER TABLE device_audit_logs DROP COLUMN operating_system;
ALTER TABLE device_audit_logs DROP COLUMN browser;
ALTER TABLE device_audit_logs DROP COLUMN device_name;

ALTER TABLE device_sessions DROP COLUMN risk_level;
ALTER TABLE device_sessions DROP COLUMN last_activity;
ALTER TABLE device_sessions DROP COLUMN jwt_id;
ALTER TABLE device_sessions DROP COLUMN user_session_id;

ALTER TABLE trusted_devices DROP COLUMN last_location;
ALTER TABLE trusted_devices DROP COLUMN first_registered_ip;
ALTER TABLE trusted_devices DROP COLUMN nickname;

DROP TABLE IF EXISTS security_notifications;
DROP TABLE IF EXISTS device_approval_requests;
