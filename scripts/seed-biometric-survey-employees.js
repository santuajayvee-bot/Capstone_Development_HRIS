const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const argon2 = require('argon2');
const pool = require('../config/db');
const { encryptAES256 } = require('../server/crypto');
const { sha256 } = require('../server/attendance-service');

const COUNT = Number(process.argv.find(arg => /^--count=\d+$/.test(arg))?.split('=')[1] || 35);
const TEST_MARK = 'BIOMETRIC_SURVEY_TEST_202606';
const DEVICE_REFERENCE = 'ZK9500-LOCAL-001';
const DEVICE_NAME = 'Survey Local ZK9500 Test Station';
const DEPARTMENT_NAME = 'TEST Biometric Survey Employees';
const DEFAULT_PASSWORD = process.env.BIOMETRIC_SURVEY_PASSWORD || 'SurveyTest123!';
const OUTPUT_DIR = path.join(__dirname, '..', 'artifacts', 'biometric-survey');

const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
};

function pad(value, length = 3) {
  return String(value).padStart(length, '0');
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function hasColumn(connection, tableName, columnName) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function ensureBiometricSchema(connection) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS biometric_device (
      device_id INT AUTO_INCREMENT PRIMARY KEY,
      device_reference VARCHAR(120) NOT NULL UNIQUE,
      device_name VARCHAR(160) NOT NULL,
      vendor VARCHAR(120) NULL,
      api_base_url VARCHAR(500) NULL,
      logs_endpoint VARCHAR(255) NOT NULL DEFAULT '/attendance/logs',
      auth_type ENUM('API_KEY','BEARER','HMAC','OAUTH2','MTLS','NONE') NOT NULL DEFAULT 'API_KEY',
      auth_header_name VARCHAR(100) NOT NULL DEFAULT 'x-biometric-api-key',
      auth_secret_encrypted TEXT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      last_sync_at DATETIME NULL,
      last_success_at DATETIME NULL,
      last_error_at DATETIME NULL,
      last_error_message VARCHAR(500) NULL,
      created_by INT NULL,
      updated_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_biometric_device_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS biometric_employee_mapping (
      mapping_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      device_id INT NOT NULL,
      employee_id INT NOT NULL,
      biometric_user_hash CHAR(64) NOT NULL,
      biometric_user_id_encrypted TEXT NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      updated_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES biometric_device(device_id) ON DELETE CASCADE,
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
      UNIQUE KEY unique_biometric_mapping (device_id, biometric_user_hash),
      INDEX idx_biometric_mapping_employee (employee_id, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function ensureDepartment(connection) {
  const [rows] = await connection.execute('SELECT id FROM departments WHERE name = ? LIMIT 1', [DEPARTMENT_NAME]);
  if (rows[0]) {
    await connection.execute('UPDATE departments SET is_active = 1 WHERE id = ?', [rows[0].id]);
    return rows[0].id;
  }
  const [created] = await connection.execute('INSERT INTO departments (name, is_active) VALUES (?, 1)', [DEPARTMENT_NAME]);
  return created.insertId;
}

async function ensureDevice(connection) {
  await connection.execute(`
    INSERT INTO biometric_device
      (device_reference, device_name, vendor, api_base_url, logs_endpoint,
       auth_type, auth_header_name, auth_secret_encrypted, is_active)
    VALUES (?, ?, 'ZKTeco', 'http://127.0.0.1:5055', '/attendance/logs',
       'NONE', 'x-biometric-api-key', NULL, 1)
    ON DUPLICATE KEY UPDATE
      device_name = VALUES(device_name),
      vendor = VALUES(vendor),
      api_base_url = VALUES(api_base_url),
      logs_endpoint = VALUES(logs_endpoint),
      auth_type = 'NONE',
      auth_secret_encrypted = NULL,
      is_active = 1,
      last_error_message = NULL
  `, [DEVICE_REFERENCE, DEVICE_NAME]);
  const [rows] = await connection.execute(
    'SELECT device_id FROM biometric_device WHERE device_reference = ? LIMIT 1',
    [DEVICE_REFERENCE]
  );
  return rows[0].device_id;
}

async function employeeRoleId(connection) {
  const [rows] = await connection.execute("SELECT id FROM roles WHERE name = 'employee' LIMIT 1");
  if (!rows[0]) throw new Error('Employee role is missing. Run role migrations first.');
  return rows[0].id;
}

async function nextEmployeeNumber(connection) {
  const [[row]] = await connection.execute('SELECT COALESCE(MAX(Employee_ID), 990000) + 1 AS next_number FROM employees');
  return Number(row.next_number || 990001);
}

async function upsertEmployee(connection, row, departmentId, employeeNumber, passwordHash) {
  const [existing] = await connection.execute(
    'SELECT id, Employee_ID FROM employees WHERE employee_code = ? LIMIT 1',
    [row.employee_code]
  );

  if (existing[0]) {
    await connection.execute(`
      UPDATE employees
         SET first_name = ?,
             middle_name = NULL,
             last_name = ?,
             email = ?,
             contact_number = ?,
             department_id = ?,
             position = 'Biometric Survey Respondent',
             employment_type = 'Full-time',
             date_hired = '2026-06-01',
             status = 'Active',
             Employee_ID = COALESCE(Employee_ID, ?),
             Password_Hash = ?,
             Password_Changed_At = NOW(),
             Failed_Login_Attempts = 0,
             Locked_Until = NULL,
             force_password_change = 0
       WHERE id = ?
    `, [
      row.first_name,
      row.last_name,
      row.email,
      row.contact_number,
      departmentId,
      existing[0].Employee_ID || employeeNumber,
      passwordHash,
      existing[0].id,
    ]);
    return existing[0].id;
  }

  const [created] = await connection.execute(`
    INSERT INTO employees
      (employee_code, first_name, middle_name, last_name, email, contact_number,
       department_id, position, employment_type, date_hired, status,
       Employee_ID, Password_Hash, Password_Changed_At, Failed_Login_Attempts,
       Locked_Until, force_password_change)
    VALUES (?, ?, NULL, ?, ?, ?, ?, 'Biometric Survey Respondent',
       'Full-time', '2026-06-01', 'Active',
       ?, ?, NOW(), 0, NULL, 0)
  `, [
    row.employee_code,
    row.first_name,
    row.last_name,
    row.email,
    row.contact_number,
    departmentId,
    employeeNumber,
    passwordHash,
  ]);
  return created.insertId;
}

async function upsertUser(connection, row, employeeId, roleId, passwordHash, usersColumns) {
  const columns = ['username'];
  const values = [row.username];
  const updates = [];

  if (usersColumns.email) {
    columns.push('email');
    values.push(row.email);
    updates.push('email = VALUES(email)');
  }

  columns.push('password_hash', 'role_id', 'employee_id', 'is_active');
  values.push(passwordHash, roleId, employeeId, 1);
  updates.push('password_hash = VALUES(password_hash)', 'role_id = VALUES(role_id)', 'employee_id = VALUES(employee_id)', 'is_active = 1');

  if (usersColumns.account_status) {
    columns.push('account_status');
    values.push('Active');
    updates.push("account_status = 'Active'");
  }
  if (usersColumns.password_changed_at) {
    columns.push('password_changed_at');
    values.push(new Date());
    updates.push('password_changed_at = VALUES(password_changed_at)');
  }
  if (usersColumns.force_password_change) {
    columns.push('force_password_change');
    values.push(0);
    updates.push('force_password_change = 0');
  }
  if (usersColumns.failed_login_attempts) {
    columns.push('failed_login_attempts');
    values.push(0);
    updates.push('failed_login_attempts = 0');
  }
  if (usersColumns.account_locked_until) {
    columns.push('account_locked_until');
    values.push(null);
    updates.push('account_locked_until = NULL');
  }

  await connection.execute(
    `INSERT INTO users (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${updates.join(', ')}`,
    values
  );
}

async function upsertMapping(connection, deviceId, employeeId, biometricUserId) {
  const biometricHash = sha256(biometricUserId);
  const encrypted = encryptAES256(biometricUserId);
  await connection.execute(
    `INSERT INTO biometric_employee_mapping
       (device_id, employee_id, biometric_user_hash, biometric_user_id_encrypted, is_active)
     VALUES (?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       employee_id = VALUES(employee_id),
       biometric_user_id_encrypted = VALUES(biometric_user_id_encrypted),
       is_active = 1,
       updated_at = CURRENT_TIMESTAMP`,
    [deviceId, employeeId, biometricHash, encrypted]
  );
}

function buildRows() {
  return Array.from({ length: COUNT }, (_, index) => {
    const number = index + 1;
    const code = `SURV-BIO-${pad(number)}`;
    return {
      employee_code: code,
      username: `survey.employee${pad(number, 2)}`,
      first_name: 'Survey',
      last_name: `Employee ${pad(number)}`,
      email: `${code.toLowerCase()}@survey-test.local`,
      contact_number: `0998${pad(number, 7)}`,
      biometric_user_id: `SURVEY-BIO-REF-${pad(number)}`,
    };
  });
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const connection = await pool.getConnection();
  const rows = buildRows();
  const passwordHash = await argon2.hash(DEFAULT_PASSWORD, ARGON2ID_OPTIONS);

  try {
    await connection.beginTransaction();
    await ensureBiometricSchema(connection);
    const departmentId = await ensureDepartment(connection);
    const deviceId = await ensureDevice(connection);
    const roleId = await employeeRoleId(connection);
    let employeeNumber = await nextEmployeeNumber(connection);
    const usersColumns = {
      email: await hasColumn(connection, 'users', 'email'),
      account_status: await hasColumn(connection, 'users', 'account_status'),
      password_changed_at: await hasColumn(connection, 'users', 'password_changed_at'),
      force_password_change: await hasColumn(connection, 'users', 'force_password_change'),
      failed_login_attempts: await hasColumn(connection, 'users', 'failed_login_attempts'),
      account_locked_until: await hasColumn(connection, 'users', 'account_locked_until'),
    };

    for (const row of rows) {
      const employeeId = await upsertEmployee(connection, row, departmentId, employeeNumber++, passwordHash);
      await upsertUser(connection, row, employeeId, roleId, passwordHash, usersColumns);
      await upsertMapping(connection, deviceId, employeeId, row.biometric_user_id);
      row.employee_id = employeeId;
      row.device_reference = DEVICE_REFERENCE;
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }

  const credentialsPath = path.join(OUTPUT_DIR, 'survey-employee-accounts.csv');
  const headers = ['Employee Code', 'Username', 'Temporary Password', 'Biometric Reference', 'Device Reference'];
  const csvRows = rows.map(row => [
    row.employee_code,
    row.username,
    DEFAULT_PASSWORD,
    row.biometric_user_id,
    row.device_reference,
  ]);
  fs.writeFileSync(credentialsPath, [headers, ...csvRows].map(row => row.map(csvEscape).join(',')).join('\n'));

  const readme = [
    '# Biometric Survey Test Accounts',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Employees: ${rows.length}`,
    `Device: ${DEVICE_REFERENCE} (${DEVICE_NAME})`,
    '',
    'These are test-only employee accounts and fake biometric references for survey/UAT.',
    'Do not use these credentials in production.',
    '',
    '## Usage',
    '',
    '- Use `/attendance-station.html` for the station screen.',
    '- Use the local bridge/scanner if available.',
    '- For manual API tests, post scans using the biometric references listed in the CSV.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'README.md'), readme);

  console.log('BIOMETRIC SURVEY TEST EMPLOYEES SEEDED');
  console.log(`Employees/accounts: ${rows.length}`);
  console.log(`Device reference: ${DEVICE_REFERENCE}`);
  console.log(`Temporary password: ${DEFAULT_PASSWORD}`);
  console.log(`Credentials CSV: ${credentialsPath}`);
}

main().catch(error => {
  console.error('BIOMETRIC SURVEY SEED FAILED:', error.message);
  process.exitCode = 1;
});
