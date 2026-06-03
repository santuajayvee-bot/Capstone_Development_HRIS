/* ============================================================
   Employee lifecycle routing migration
   Aligns Employee Management -> Onboarding -> Employee Directory.
   ============================================================ */

const pool = require('../config/db');

async function columnExists(connection, tableName, columnName) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return Number(rows[0].count) > 0;
}

async function ensureColumn(connection, tableName, columnName, definition) {
  if (await columnExists(connection, tableName, columnName)) {
    console.log(`Skipped ${tableName}.${columnName}; already exists.`);
    return;
  }
  await connection.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  console.log(`Added ${tableName}.${columnName}.`);
}

async function migrate() {
  const connection = await pool.getConnection();
  try {
    console.log('Running employee lifecycle routing migration...');

    await ensureColumn(connection, 'onboarding_applicant', 'intended_employee_code', 'VARCHAR(20) NULL AFTER applicant_code');
    await ensureColumn(connection, 'onboarding_applicant', 'source_module', "VARCHAR(60) NOT NULL DEFAULT 'ONBOARDING' AFTER intended_employee_code");

    await ensureColumn(connection, 'employees', 'hiring_type', "ENUM('Direct Hire','Agency-Hired') NOT NULL DEFAULT 'Direct Hire' AFTER encrypted_pii");
    await ensureColumn(connection, 'employees', 'agency_name', 'VARCHAR(180) NULL AFTER hiring_type');
    await ensureColumn(connection, 'employees', 'agency_contact_person', 'VARCHAR(180) NULL AFTER agency_name');
    await ensureColumn(connection, 'employees', 'agency_contact_number', 'VARCHAR(80) NULL AFTER agency_contact_person');
    await ensureColumn(connection, 'employees', 'deployment_status', "ENUM('Pending Deployment','Deployed','On Hold','Ended') NULL AFTER agency_contact_number");
    await ensureColumn(connection, 'employees', 'contract_start_date', 'DATE NULL AFTER deployment_status');
    await ensureColumn(connection, 'employees', 'contract_end_date', 'DATE NULL AFTER contract_start_date');
    await ensureColumn(connection, 'employees', 'lifecycle_status', "ENUM('Active','For Onboarding','Under Screening','In Training','Rejected','Transferred') NOT NULL DEFAULT 'Active' AFTER contract_end_date");

    await connection.execute(`
      ALTER TABLE onboarding_applicant
      MODIFY COLUMN workflow_status ENUM(
        'For Onboarding','Under Screening','Pending Screening','Screening','Training',
        'For Approval','Approved','Rejected','For Re-evaluation','On Hold','Transferred'
      ) NOT NULL DEFAULT 'Under Screening'
    `);
    console.log('Ensured onboarding_applicant.workflow_status supports lifecycle routing statuses.');

    const defaultRoutes = [
      ['Manager', 0, 0],
      ['HR Staff', 0, 0],
      ['Admin Staff', 0, 0],
      ['Office Staff', 0, 0],
      ['Supervisor', 0, 0],
      ['Operator', 1, 1],
      ['Production Worker', 1, 1],
      ['Production Staff', 1, 1],
      ['Piece-Rate Worker', 1, 1],
      ['Factory Worker', 1, 1],
      ['Logistics Helper', 1, 1],
      ['Machine Operator', 1, 1],
    ];

    for (const [position, requiresOnboarding, requiresTraining] of defaultRoutes) {
      await connection.execute(
        `INSERT INTO onboarding_position_route
           (position_name, requires_onboarding, requires_training)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           requires_onboarding = VALUES(requires_onboarding),
           requires_training = VALUES(requires_training),
           is_active = 1`,
        [position, requiresOnboarding, requiresTraining]
      );
      console.log(`Route ready: ${position} -> onboarding=${requiresOnboarding}, training=${requiresTraining}`);
    }

    console.log('Employee lifecycle routing migration completed.');
  } catch (error) {
    console.error('Employee lifecycle routing migration failed:', error);
    process.exitCode = 1;
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate();
