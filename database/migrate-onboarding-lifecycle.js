/* ============================================================
   Secure pre-employment onboarding lifecycle migration

   Applicants remain outside the official employees table until
   HR approval and transfer.

   Run:
     node database/migrate-onboarding-lifecycle.js
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

async function migrate() {
  const connection = await pool.getConnection();
  try {
    console.log('Running secure onboarding lifecycle migration...');

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS onboarding_position_route (
        position_route_id INT AUTO_INCREMENT PRIMARY KEY,
        position_name VARCHAR(120) NOT NULL UNIQUE,
        department_id INT NULL,
        requires_onboarding TINYINT(1) NOT NULL DEFAULT 1,
        requires_training TINYINT(1) NOT NULL DEFAULT 1,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        updated_by INT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
        INDEX idx_onboarding_route_active (is_active, position_name)
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS onboarding_applicant (
        applicant_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        applicant_code VARCHAR(24) NOT NULL UNIQUE,
        first_name VARCHAR(100) NOT NULL,
        middle_name VARCHAR(100) NULL,
        last_name VARCHAR(100) NOT NULL,
        suffix VARCHAR(20) NULL,
        email_hash CHAR(64) NOT NULL,
        email_encrypted TEXT NOT NULL,
        pii_encrypted LONGTEXT NOT NULL,
        hiring_type ENUM('Agency-Hired','Direct Hire') NOT NULL,
        agency_name VARCHAR(180) NULL,
        deployment_status ENUM('Pending Deployment','Deployed','On Hold','Ended') NULL,
        contract_start_date DATE NULL,
        contract_end_date DATE NULL,
        applied_position VARCHAR(120) NOT NULL,
        department_id INT NULL,
        branch VARCHAR(120) NOT NULL,
        expected_wage_type_id INT NULL,
        expected_base_rate DECIMAL(12,2) NULL,
        requires_onboarding TINYINT(1) NOT NULL DEFAULT 1,
        requires_training TINYINT(1) NOT NULL DEFAULT 1,
        workflow_status ENUM(
          'Pending Screening','Screening','Training','For Approval','Approved',
          'Rejected','For Re-evaluation','On Hold','Transferred'
        ) NOT NULL DEFAULT 'Pending Screening',
        screening_status ENUM(
          'Pending Screening','For Interview','For Requirements Checking',
          'Passed Screening','Failed Screening','Not Required'
        ) NOT NULL DEFAULT 'Pending Screening',
        training_status ENUM(
          'Not Yet Started','In Training','Completed Training',
          'Failed Training','For Final Evaluation','Not Required'
        ) NOT NULL DEFAULT 'Not Yet Started',
        approval_status ENUM('Pending','Approved','Rejected','For Re-evaluation','On Hold') NOT NULL DEFAULT 'Pending',
        biometric_device_id INT NULL,
        biometric_reference_hash CHAR(64) NULL,
        biometric_reference_encrypted TEXT NULL,
        converted_employee_id INT NULL,
        created_by INT NOT NULL,
        updated_by INT NULL,
        approved_by INT NULL,
        transferred_by INT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        approved_at DATETIME NULL,
        transferred_at DATETIME NULL,
        deleted_at DATETIME NULL,
        deleted_by INT NULL,
        deletion_reason VARCHAR(500) NULL,
        FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
        FOREIGN KEY (expected_wage_type_id) REFERENCES wage_types(id) ON DELETE SET NULL,
        FOREIGN KEY (biometric_device_id) REFERENCES biometric_device(device_id) ON DELETE SET NULL,
        FOREIGN KEY (converted_employee_id) REFERENCES employees(id) ON DELETE SET NULL,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
        INDEX idx_onboarding_workflow (workflow_status, created_at),
        INDEX idx_onboarding_screening (screening_status, training_status),
        INDEX idx_onboarding_email_hash (email_hash),
        INDEX idx_onboarding_deleted (deleted_at)
      )
    `);

    const applicantArchiveColumns = [
      ['deleted_at', 'DATETIME NULL AFTER transferred_at'],
      ['deleted_by', 'INT NULL AFTER deleted_at'],
      ['deletion_reason', 'VARCHAR(500) NULL AFTER deleted_by'],
    ];
    for (const [column, definition] of applicantArchiveColumns) {
      try {
        await connection.execute(`ALTER TABLE onboarding_applicant ADD COLUMN ${column} ${definition}`);
      } catch (error) {
        if (error.code !== 'ER_DUP_FIELDNAME') throw error;
      }
    }
    try {
      await connection.execute('CREATE INDEX idx_onboarding_deleted ON onboarding_applicant (deleted_at)');
    } catch (error) {
      if (error.code !== 'ER_DUP_KEYNAME') throw error;
    }

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS onboarding_applicant_document (
        document_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        applicant_id BIGINT NOT NULL,
        transferred_employee_id INT NULL,
        document_type VARCHAR(80) NOT NULL,
        original_file_name VARCHAR(255) NOT NULL,
        encrypted_file_path VARCHAR(500) NOT NULL,
        mime_type VARCHAR(120) NOT NULL,
        file_size_bytes INT NOT NULL,
        verification_status ENUM('Pending','Verified','Rejected') NOT NULL DEFAULT 'Pending',
        rejection_reason VARCHAR(500) NULL,
        uploaded_by INT NOT NULL,
        verified_by INT NULL,
        uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        verified_at DATETIME NULL,
        FOREIGN KEY (applicant_id) REFERENCES onboarding_applicant(applicant_id) ON DELETE CASCADE,
        FOREIGN KEY (transferred_employee_id) REFERENCES employees(id) ON DELETE SET NULL,
        FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE RESTRICT,
        INDEX idx_onboarding_doc_applicant (applicant_id, uploaded_at),
        INDEX idx_onboarding_doc_employee (transferred_employee_id)
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS onboarding_applicant_activity (
        activity_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        applicant_id BIGINT NOT NULL,
        actor_user_id INT NOT NULL,
        action VARCHAR(100) NOT NULL,
        reason VARCHAR(500) NULL,
        old_value JSON NULL,
        new_value JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (applicant_id) REFERENCES onboarding_applicant(applicant_id) ON DELETE CASCADE,
        FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
        INDEX idx_onboarding_activity_applicant (applicant_id, created_at),
        INDEX idx_onboarding_activity_action (action, created_at)
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS onboarding_integrity_chain (
        chain_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        activity_id BIGINT NOT NULL UNIQUE,
        applicant_id BIGINT NOT NULL,
        previous_hash CHAR(64) NULL,
        chain_hash CHAR(64) NOT NULL,
        anchor_status ENUM('PENDING','ANCHORED','FAILED') NOT NULL DEFAULT 'PENDING',
        blockchain_reference VARCHAR(255) NULL,
        anchor_error VARCHAR(500) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        anchored_at DATETIME NULL,
        FOREIGN KEY (activity_id) REFERENCES onboarding_applicant_activity(activity_id) ON DELETE CASCADE,
        FOREIGN KEY (applicant_id) REFERENCES onboarding_applicant(applicant_id) ON DELETE CASCADE,
        INDEX idx_onboarding_chain_applicant (applicant_id, chain_id),
        INDEX idx_onboarding_chain_anchor (anchor_status, created_at)
      )
    `);

    try {
      await connection.execute(`
        ALTER TABLE onboarding_integrity_chain
        ADD COLUMN anchor_error VARCHAR(500) NULL AFTER blockchain_reference
      `);
    } catch (error) {
      if (error.code !== 'ER_DUP_FIELDNAME') throw error;
    }

    const defaultRoutes = [
      ['Manager', 0, 0],
      ['HR Staff', 0, 0],
      ['Office Staff', 0, 0],
      ['Supervisor', 0, 0],
      ['Operator', 1, 1],
      ['Machine Operator', 1, 1],
      ['Production Worker', 1, 1],
      ['Factory Worker', 1, 1],
      ['Piece-Rate Worker', 1, 1],
      ['Logistics Helper', 1, 1],
      ['Driver', 1, 1],
    ];

    for (const [position, requiresOnboarding, requiresTraining] of defaultRoutes) {
      await connection.execute(
        `INSERT INTO onboarding_position_route
           (position_name, requires_onboarding, requires_training)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           position_name = VALUES(position_name)`,
        [position, requiresOnboarding, requiresTraining]
      );
    }

    console.log('Secure onboarding lifecycle migration completed.');
  } catch (error) {
    console.error('Secure onboarding lifecycle migration failed:', error);
    process.exitCode = 1;
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate();
