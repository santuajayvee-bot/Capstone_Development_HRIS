-- up
ALTER TABLE biometric_bridge_command
  MODIFY command_type ENUM('VERIFY','ENROLL','DELETE') NOT NULL;

-- down
UPDATE biometric_bridge_command
   SET command_status = 'EXPIRED',
       error_message = 'DELETE command type removed by rollback.'
 WHERE command_type = 'DELETE'
   AND command_status IN ('PENDING','IN_PROGRESS');

DELETE FROM biometric_bridge_command
 WHERE command_type = 'DELETE'
   AND command_status IN ('COMPLETED','FAILED','EXPIRED');

ALTER TABLE biometric_bridge_command
  MODIFY command_type ENUM('VERIFY','ENROLL') NOT NULL;
