require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const {
  decryptColumnValue,
  encryptColumnValue,
  hashNullable,
  isEncryptedValue,
} = require('../server/data-protection');
const {
  deleteEncryptedFile,
  readEncryptedBuffer,
  storeEncryptedBuffer,
} = require('../server/encrypted-file-vault');

const EMPLOYEE_PII_COLUMNS = [
  'first_name', 'middle_name', 'last_name', 'suffix', 'email', 'contact_number', 'work_email',
  'mailing_address', 'nationality', 'marital_status', 'date_of_birth', 'place_of_birth',
  'gender', 'blood_type', 'religion', 'residential_address', 'current_address',
  'residential_address_region', 'residential_address_province', 'residential_address_city_municipality',
  'residential_address_barangay', 'residential_address_street_address', 'residential_address_full_address',
  'residential_address_place_id', 'current_address_region', 'current_address_province',
  'current_address_city_municipality', 'current_address_barangay', 'current_address_street_address',
  'current_address_full_address', 'current_address_place_id', 'mailing_address_region',
  'mailing_address_province', 'mailing_address_city_municipality', 'mailing_address_barangay',
  'mailing_address_street_address', 'mailing_address_full_address', 'mailing_address_place_id',
  'emergency_contact_name', 'emergency_contact_num', 'emergency_contact_relationship',
  'emergency_contact_secondary_num', 'emergency_contact_email', 'emergency_contact_address',
  'education_school', 'education_attainment', 'education_units', 'education_year_graduated',
  'education_jhs_school', 'education_jhs_attainment', 'education_jhs_from', 'education_jhs_to',
  'education_jhs_year_graduated', 'education_shs_school', 'education_shs_attainment',
  'education_shs_from', 'education_shs_to', 'education_shs_year_graduated',
  'education_vocational_school', 'education_vocational_attainment', 'education_vocational_units',
  'education_vocational_from', 'education_vocational_to', 'education_vocational_year_graduated',
  'education_college_school', 'education_college_attainment', 'education_college_units',
  'education_college_from', 'education_college_to', 'education_college_year_graduated',
  'sss_number', 'philhealth_number', 'pagibig_number', 'tin', 'tax_status', 'bank_name',
  'bank_account', 'agency_contact_person', 'agency_contact_number', 'separation_reason',
  'offboarding_remarks',
];

const EMPLOYEE_PII_COLUMN_DEFINITIONS = EMPLOYEE_PII_COLUMNS.reduce((definitions, column) => {
  definitions[column] = 'TEXT NULL';
  return definitions;
}, {});

// email may still have a legacy UNIQUE index on fresh installs. Keep it indexable
// while giving AES-GCM ciphertext enough room for maximum email-length payloads.
EMPLOYEE_PII_COLUMN_DEFINITIONS.email = 'VARCHAR(768) NULL';

const GPS_COLUMNS = [
  ['residential_address_lat', 'residential_address_lat_encrypted'],
  ['residential_address_lng', 'residential_address_lng_encrypted'],
  ['current_address_lat', 'current_address_lat_encrypted'],
  ['current_address_lng', 'current_address_lng_encrypted'],
  ['mailing_address_lat', 'mailing_address_lat_encrypted'],
  ['mailing_address_lng', 'mailing_address_lng_encrypted'],
];

function readOptionalFile(filePath) {
  return filePath ? fs.readFileSync(filePath) : undefined;
}

function sslConfig() {
  if (process.env.DB_SSL !== 'true') return undefined;
  return {
    minVersion: 'TLSv1.3',
    ca: readOptionalFile(process.env.DB_SSL_CA_PATH),
    cert: readOptionalFile(process.env.DB_SSL_CERT_PATH),
    key: readOptionalFile(process.env.DB_SSL_KEY_PATH),
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
  };
}

async function connect() {
  return mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.MIGRATION_DB_USER || process.env.DB_USER,
    password: process.env.MIGRATION_DB_PASSWORD || process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: sslConfig(),
  });
}

function identifier(value) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error(`Unsafe migration identifier: ${value}`);
  return `\`${value}\``;
}

async function resolveTableName(connection, table) {
  const [rows] = await connection.execute(
    `SELECT TABLE_NAME
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND LOWER(TABLE_NAME) = LOWER(?)
      ORDER BY TABLE_NAME = ? DESC
      LIMIT 2`,
    [table, table]
  );
  if (rows.length > 1 && rows[0].TABLE_NAME.toLowerCase() === rows[1].TABLE_NAME.toLowerCase()) {
    throw new Error(`Ambiguous table casing for ${table}; resolve duplicate case variants before migration.`);
  }
  return rows[0]?.TABLE_NAME || null;
}

async function tableExists(connection, table) {
  return Boolean(await resolveTableName(connection, table));
}

async function columnExists(connection, table, column) {
  const actualTable = await resolveTableName(connection, table);
  if (!actualTable) return false;
  const [rows] = await connection.execute(
    'SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [actualTable, column]
  );
  return rows.length > 0;
}

async function ensureColumn(connection, table, column, definition) {
  const actualTable = await resolveTableName(connection, table);
  if (!actualTable || await columnExists(connection, actualTable, column)) return;
  await connection.query(`ALTER TABLE ${identifier(actualTable)} ADD COLUMN ${identifier(column)} ${definition}`);
}

async function modifyColumn(connection, table, column, definition) {
  const actualTable = await resolveTableName(connection, table);
  if (actualTable && await columnExists(connection, actualTable, column)) {
    await connection.query(`ALTER TABLE ${identifier(actualTable)} MODIFY COLUMN ${identifier(column)} ${definition}`);
  }
}

async function dropColumn(connection, table, column) {
  const actualTable = await resolveTableName(connection, table);
  if (actualTable && await columnExists(connection, actualTable, column)) {
    await connection.query(`ALTER TABLE ${identifier(actualTable)} DROP COLUMN ${identifier(column)}`);
  }
}

function plaintextForEncryption(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function encryptColumnsInPlace(connection, table, primaryKey, columns) {
  const actualTable = await resolveTableName(connection, table);
  if (!actualTable) return;
  const existing = [];
  for (const column of columns) if (await columnExists(connection, actualTable, column)) existing.push(column);
  if (!existing.length) return;
  const [rows] = await connection.query(
    `SELECT ${identifier(primaryKey)}, ${existing.map(identifier).join(', ')} FROM ${identifier(actualTable)}`
  );
  for (const row of rows) {
    const updates = [];
    const params = [];
    for (const column of existing) {
      const value = row[column];
      if (value === null || value === undefined || value === '' || isEncryptedValue(String(value))) continue;
      updates.push(`${identifier(column)} = ?`);
      params.push(encryptColumnValue(plaintextForEncryption(value)));
    }
    if (!updates.length) continue;
    params.push(row[primaryKey]);
    await connection.execute(
      `UPDATE ${identifier(actualTable)} SET ${updates.join(', ')} WHERE ${identifier(primaryKey)} = ?`,
      params
    );
  }
}

async function decryptColumnsInPlace(connection, table, primaryKey, columns) {
  const actualTable = await resolveTableName(connection, table);
  if (!actualTable) return;
  const existing = [];
  for (const column of columns) if (await columnExists(connection, actualTable, column)) existing.push(column);
  if (!existing.length) return;
  const [rows] = await connection.query(
    `SELECT ${identifier(primaryKey)}, ${existing.map(identifier).join(', ')} FROM ${identifier(actualTable)}`
  );
  for (const row of rows) {
    const updates = [];
    const params = [];
    for (const column of existing) {
      const value = row[column];
      if (!value || !isEncryptedValue(String(value))) continue;
      updates.push(`${identifier(column)} = ?`);
      params.push(decryptColumnValue(value));
    }
    if (!updates.length) continue;
    params.push(row[primaryKey]);
    await connection.execute(
      `UPDATE ${identifier(actualTable)} SET ${updates.join(', ')} WHERE ${identifier(primaryKey)} = ?`,
      params
    );
  }
}

async function backfillPairedColumns(connection, table, primaryKey, pairs, decrypting = false) {
  const actualTable = await resolveTableName(connection, table);
  if (!actualTable) return;
  const available = [];
  for (const [plain, encrypted] of pairs) {
    if (await columnExists(connection, actualTable, plain) && await columnExists(connection, actualTable, encrypted)) {
      available.push([plain, encrypted]);
    }
  }
  if (!available.length) return;
  const selected = [...new Set(available.flat())];
  const [rows] = await connection.query(
    `SELECT ${identifier(primaryKey)}, ${selected.map(identifier).join(', ')} FROM ${identifier(actualTable)}`
  );
  for (const row of rows) {
    const updates = [];
    const params = [];
    for (const [plain, encrypted] of available) {
      if (!decrypting && row[plain] !== null && row[plain] !== undefined && row[plain] !== '') {
        updates.push(`${identifier(encrypted)} = COALESCE(${identifier(encrypted)}, ?)`);
        params.push(encryptColumnValue(plaintextForEncryption(row[plain])));
        updates.push(`${identifier(plain)} = NULL`);
      } else if (decrypting && row[encrypted]) {
        updates.push(`${identifier(plain)} = COALESCE(${identifier(plain)}, ?)`);
        params.push(decryptColumnValue(row[encrypted]));
      }
    }
    if (!updates.length) continue;
    params.push(row[primaryKey]);
    await connection.execute(
      `UPDATE ${identifier(actualTable)} SET ${updates.join(', ')} WHERE ${identifier(primaryKey)} = ?`,
      params
    );
  }
}

async function encryptPhotoBlobs(connection) {
  if (!(await tableExists(connection, 'employee_photos'))) return;
  const [rows] = await connection.query('SELECT id, photo_data, photo_data_encrypted, photo_encrypted_path FROM employee_photos');
  for (const row of rows) {
    if (row.photo_encrypted_path) continue;
    const buffer = row.photo_data
      ? Buffer.from(row.photo_data)
      : row.photo_data_encrypted
        ? Buffer.from(decryptColumnValue(row.photo_data_encrypted), 'base64')
        : null;
    if (!buffer?.length) continue;
    const encryptedPath = await storeEncryptedBuffer('employee-photos', buffer);
    try {
      await connection.execute(
        'UPDATE employee_photos SET photo_encrypted_path = ?, photo_data_encrypted = NULL, photo_data = NULL WHERE id = ?',
        [encryptedPath, row.id]
      );
    } catch (error) {
      await deleteEncryptedFile(encryptedPath).catch(() => {});
      throw error;
    }
  }
}

async function decryptPhotoBlobs(connection) {
  if (!(await tableExists(connection, 'employee_photos'))) return;
  const [rows] = await connection.query('SELECT id, photo_data, photo_data_encrypted, photo_encrypted_path FROM employee_photos');
  for (const row of rows) {
    if (row.photo_data) continue;
    const buffer = row.photo_encrypted_path
      ? await readEncryptedBuffer(row.photo_encrypted_path)
      : row.photo_data_encrypted
        ? Buffer.from(decryptColumnValue(row.photo_data_encrypted), 'base64')
        : null;
    if (!buffer) continue;
    await connection.execute(
      'UPDATE employee_photos SET photo_data = ? WHERE id = ?',
      [buffer, row.id]
    );
    if (row.photo_encrypted_path) await deleteEncryptedFile(row.photo_encrypted_path);
  }
}

function publicUploadPath(storedPath) {
  const relative = String(storedPath || '').replace(/^[/\\]+/, '').replace(/\\/g, '/');
  if (!relative.startsWith('uploads/')) return null;
  const root = path.resolve(__dirname, '..', 'public', 'uploads');
  const resolved = path.resolve(__dirname, '..', 'public', relative);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function extensionFor(fileName, mimeType) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
  const byMime = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };
  return byMime[mimeType] || '.bin';
}

async function encryptLegacyFiles(connection, options) {
  const { table, primaryKey, scope, nameColumn, pathColumn, encryptedNameColumn, encryptedPathColumn, encryptedLegacyPathColumn, mimeColumn, sizeColumn } = options;
  const actualTable = await resolveTableName(connection, table);
  if (!actualTable) return;
  const requiredColumns = [primaryKey, nameColumn, pathColumn, encryptedNameColumn, encryptedPathColumn, encryptedLegacyPathColumn];
  for (const column of new Set(requiredColumns)) {
    if (!(await columnExists(connection, actualTable, column))) return;
  }
  const [rows] = await connection.query(
    `SELECT ${identifier(primaryKey)}, ${identifier(nameColumn)}, ${identifier(pathColumn)}, ${identifier(encryptedPathColumn)}, ${identifier(encryptedLegacyPathColumn)} FROM ${identifier(actualTable)}`
  );
  for (const row of rows) {
    const updates = [];
    const params = [];
    const legacyPath = row[pathColumn] || decryptColumnValue(row[encryptedLegacyPathColumn]) || null;
    const originalName = row[nameColumn] || path.basename(String(legacyPath || '')) || null;
    if (originalName) {
      updates.push(`${identifier(encryptedNameColumn)} = COALESCE(${identifier(encryptedNameColumn)}, ?)`);
      params.push(encryptColumnValue(originalName));
    }
    const source = publicUploadPath(legacyPath);
    let sourceToDelete = null;
    let resultingEncryptedPath = row[encryptedPathColumn] || null;
    if (!row[encryptedPathColumn] && source && fs.existsSync(source)) {
      const buffer = await fs.promises.readFile(source);
      const encryptedPath = await storeEncryptedBuffer(scope, buffer);
      updates.push(`${identifier(encryptedPathColumn)} = ?`);
      params.push(encryptedPath);
      resultingEncryptedPath = encryptedPath;
      sourceToDelete = source;
      if (mimeColumn) {
        updates.push(`${identifier(mimeColumn)} = COALESCE(${identifier(mimeColumn)}, ?)`);
        params.push(null);
      }
      if (sizeColumn) {
        updates.push(`${identifier(sizeColumn)} = ?`);
        params.push(buffer.length);
      }
    }
    // Preserve an unresolved legacy reference instead of silently destroying it.
    // A later rerun can migrate the file once it is restored to the expected path.
    if (resultingEncryptedPath) {
      updates.push(`${identifier(encryptedLegacyPathColumn)} = NULL`);
      updates.push(`${identifier(nameColumn)} = NULL`);
      if (pathColumn !== nameColumn) updates.push(`${identifier(pathColumn)} = NULL`);
    } else if (legacyPath) {
      updates.push(`${identifier(encryptedLegacyPathColumn)} = COALESCE(${identifier(encryptedLegacyPathColumn)}, ?)`);
      params.push(encryptColumnValue(legacyPath));
      updates.push(`${identifier(nameColumn)} = NULL`);
      if (pathColumn !== nameColumn) updates.push(`${identifier(pathColumn)} = NULL`);
    }
    if (!updates.length) continue;
    params.push(row[primaryKey]);
    await connection.execute(
      `UPDATE ${identifier(actualTable)} SET ${updates.join(', ')} WHERE ${identifier(primaryKey)} = ?`,
      params
    );
    if (sourceToDelete) await fs.promises.unlink(sourceToDelete);
  }
}

async function decryptLegacyFiles(connection, options) {
  const { table, primaryKey, nameColumn, pathColumn, encryptedNameColumn, encryptedPathColumn, encryptedLegacyPathColumn, mimeColumn } = options;
  const actualTable = await resolveTableName(connection, table);
  if (!actualTable) return;
  const requiredColumns = [primaryKey, nameColumn, pathColumn, encryptedNameColumn, encryptedPathColumn, encryptedLegacyPathColumn];
  for (const column of new Set(requiredColumns)) {
    if (!(await columnExists(connection, actualTable, column))) return;
  }
  const [rows] = await connection.query(
    `SELECT ${identifier(primaryKey)}, ${identifier(encryptedNameColumn)}, ${identifier(encryptedPathColumn)}, ${identifier(encryptedLegacyPathColumn)}${mimeColumn ? `, ${identifier(mimeColumn)}` : ''} FROM ${identifier(actualTable)}`
  );
  const uploadRoot = path.resolve(__dirname, '..', 'public', 'uploads');
  await fs.promises.mkdir(uploadRoot, { recursive: true });
  for (const row of rows) {
    const originalName = row[encryptedNameColumn] ? decryptColumnValue(row[encryptedNameColumn]) : 'document.bin';
    let restoredPath = decryptColumnValue(row[encryptedLegacyPathColumn]) || null;
    if (row[encryptedPathColumn]) {
      const buffer = await readEncryptedBuffer(row[encryptedPathColumn]);
      const storedName = `${crypto.randomUUID()}${extensionFor(originalName, row[mimeColumn])}`;
      await fs.promises.writeFile(path.join(uploadRoot, storedName), buffer);
      restoredPath = `/uploads/${storedName}`;
    }
    if (nameColumn === pathColumn) {
      await connection.execute(
        `UPDATE ${identifier(actualTable)} SET ${identifier(pathColumn)} = ? WHERE ${identifier(primaryKey)} = ?`,
        [restoredPath, row[primaryKey]]
      );
    } else {
      await connection.execute(
        `UPDATE ${identifier(actualTable)} SET ${identifier(nameColumn)} = ?, ${identifier(pathColumn)} = ? WHERE ${identifier(primaryKey)} = ?`,
        [originalName, restoredPath, row[primaryKey]]
      );
    }
    if (row[encryptedPathColumn]) await deleteEncryptedFile(row[encryptedPathColumn]);
  }
}

async function ensureSchema(connection) {
  await ensureColumn(connection, 'employees', 'email_hash', 'CHAR(64) NULL');
  for (const [column, definition] of Object.entries(EMPLOYEE_PII_COLUMN_DEFINITIONS)) {
    await modifyColumn(connection, 'employees', column, definition);
  }
  for (const [, encrypted] of GPS_COLUMNS) await ensureColumn(connection, 'employees', encrypted, 'TEXT NULL');

  await modifyColumn(connection, 'onboarding_applicant', 'first_name', 'VARCHAR(100) NULL');
  await modifyColumn(connection, 'onboarding_applicant', 'last_name', 'VARCHAR(100) NULL');
  for (const column of ['first_name', 'middle_name', 'last_name', 'suffix']) {
    await ensureColumn(connection, 'onboarding_applicant', `${column}_encrypted`, 'TEXT NULL');
  }

  await ensureColumn(connection, 'MFA_CHALLENGE', 'Phone_Number_Encrypted', 'TEXT NULL');
  await ensureColumn(connection, 'MFA_CHALLENGE', 'Phone_Number_Hash', 'CHAR(64) NULL');
  await modifyColumn(connection, 'MFA_CHALLENGE', 'Phone_Number', 'VARCHAR(32) NULL');

  await ensureColumn(connection, 'users', 'email_hash', 'CHAR(64) NULL');
  await ensureColumn(connection, 'users', 'email_encrypted', 'TEXT NULL');
  await modifyColumn(connection, 'users', 'email', 'VARCHAR(255) NULL');

  await modifyColumn(connection, 'employee_photos', 'photo_data', 'LONGBLOB NULL');
  await ensureColumn(connection, 'employee_photos', 'photo_data_encrypted', 'LONGTEXT NULL');
  await ensureColumn(connection, 'employee_photos', 'photo_encrypted_path', 'VARCHAR(500) NULL');

  for (const [table, columns] of Object.entries({
    attendance: ['time_in_latitude', 'time_in_longitude', 'time_out_latitude', 'time_out_longitude'],
    attendance_log: ['clock_in_lat', 'clock_in_lng', 'clock_out_lat', 'clock_out_lng'],
  })) {
    for (const column of columns) await ensureColumn(connection, table, `${column}_encrypted`, 'TEXT NULL');
  }

  for (const column of ['reason', 'remarks', 'rejection_remarks', 'approval_remarks']) {
    await ensureColumn(connection, 'leave_requests', `${column}_encrypted`, 'TEXT NULL');
    await modifyColumn(connection, 'leave_requests', column, 'TEXT NULL');
  }
  await modifyColumn(connection, 'documents', 'file_name', 'VARCHAR(255) NULL');
  await modifyColumn(connection, 'documents', 'file_path', 'VARCHAR(500) NULL');
  await ensureColumn(connection, 'documents', 'file_name_encrypted', 'TEXT NULL');
  await ensureColumn(connection, 'documents', 'encrypted_file_path', 'VARCHAR(500) NULL');
  await ensureColumn(connection, 'documents', 'legacy_file_path_encrypted', 'TEXT NULL');
  await ensureColumn(connection, 'documents', 'file_mime_type', 'VARCHAR(120) NULL');
  await ensureColumn(connection, 'documents', 'file_size_bytes', 'BIGINT NULL');
  await ensureColumn(connection, 'leave_requests', 'attachment_name_encrypted', 'TEXT NULL');
  await ensureColumn(connection, 'leave_requests', 'attachment_encrypted_path', 'VARCHAR(500) NULL');
  await ensureColumn(connection, 'leave_requests', 'attachment_legacy_path_encrypted', 'TEXT NULL');
  await ensureColumn(connection, 'leave_requests', 'attachment_mime_type', 'VARCHAR(120) NULL');
  await ensureColumn(connection, 'leave_requests', 'attachment_size_bytes', 'BIGINT NULL');

  for (const column of ['old_value', 'new_value']) await ensureColumn(connection, 'user_profile_audit_logs', `${column}_encrypted`, 'TEXT NULL');
  for (const column of ['old_value', 'requested_value', 'reason', 'rejection_reason']) {
    await ensureColumn(connection, 'user_profile_change_requests', `${column}_encrypted`, 'TEXT NULL');
    await modifyColumn(connection, 'user_profile_change_requests', column, 'TEXT NULL');
  }
  for (const column of ['old_value', 'new_value']) await modifyColumn(connection, 'user_profile_audit_logs', column, 'TEXT NULL');
  for (const column of ['remarks', 'metadata']) {
    await ensureColumn(connection, 'leave_audit_trail', `${column}_encrypted`, 'LONGTEXT NULL');
    await modifyColumn(connection, 'leave_audit_trail', column, 'LONGTEXT NULL');
  }
  for (const column of ['reason', 'old_value', 'new_value']) {
    await ensureColumn(connection, 'onboarding_applicant_activity', `${column}_encrypted`, 'LONGTEXT NULL');
    await modifyColumn(connection, 'onboarding_applicant_activity', column, 'LONGTEXT NULL');
  }
  await ensureColumn(connection, 'employee_deductions', 'notes_encrypted', 'TEXT NULL');
  await modifyColumn(connection, 'employee_deductions', 'notes', 'TEXT NULL');
  await ensureColumn(connection, 'employee_deduction_accounts', 'remarks_encrypted', 'TEXT NULL');
  await modifyColumn(connection, 'employee_deduction_accounts', 'remarks', 'TEXT NULL');
}

async function backfill(connection) {
  await encryptColumnsInPlace(connection, 'employees', 'id', EMPLOYEE_PII_COLUMNS);
  if (await columnExists(connection, 'employees', 'email_hash')) {
    const [rows] = await connection.query('SELECT id, email, email_hash FROM employees');
    for (const row of rows) {
      const email = row.email ? decryptColumnValue(row.email) : null;
      if (email && !row.email_hash) await connection.execute('UPDATE employees SET email_hash = ? WHERE id = ?', [hashNullable(email), row.id]);
    }
  }
  await backfillPairedColumns(connection, 'employees', 'id', GPS_COLUMNS);

  // Some deployed schemas intentionally removed the legacy plaintext users.email
  // column after adding email_hash/email_encrypted. Only backfill it when present.
  if (await tableExists(connection, 'users') && await columnExists(connection, 'users', 'email')) {
    const [rows] = await connection.query('SELECT id, email, email_hash, email_encrypted FROM users');
    for (const row of rows) {
      if (!row.email) continue;
      await connection.execute(
        'UPDATE users SET email_hash = COALESCE(email_hash, ?), email_encrypted = COALESCE(email_encrypted, ?), email = NULL WHERE id = ?',
        [hashNullable(row.email), encryptColumnValue(row.email), row.id]
      );
    }
  }

  await backfillPairedColumns(connection, 'onboarding_applicant', 'applicant_id', [
    ['first_name', 'first_name_encrypted'], ['middle_name', 'middle_name_encrypted'],
    ['last_name', 'last_name_encrypted'], ['suffix', 'suffix_encrypted'],
  ]);
  await backfillPairedColumns(connection, 'MFA_CHALLENGE', 'Challenge_ID', [['Phone_Number', 'Phone_Number_Encrypted']]);
  const mfaTable = await resolveTableName(connection, 'MFA_CHALLENGE');
  if (mfaTable) {
    const [rows] = await connection.query(
      `SELECT Challenge_ID, Phone_Number_Encrypted, Phone_Number_Hash FROM ${identifier(mfaTable)}`
    );
    for (const row of rows) {
      if (!row.Phone_Number_Encrypted || row.Phone_Number_Hash) continue;
      await connection.execute(
        `UPDATE ${identifier(mfaTable)} SET Phone_Number_Hash = ? WHERE Challenge_ID = ?`,
        [hashNullable(decryptColumnValue(row.Phone_Number_Encrypted)), row.Challenge_ID]
      );
    }
  }
  await encryptPhotoBlobs(connection);
  await backfillPairedColumns(connection, 'attendance', 'id', [
    ['time_in_latitude', 'time_in_latitude_encrypted'], ['time_in_longitude', 'time_in_longitude_encrypted'],
    ['time_out_latitude', 'time_out_latitude_encrypted'], ['time_out_longitude', 'time_out_longitude_encrypted'],
  ]);
  await backfillPairedColumns(connection, 'attendance_log', 'attendance_id', [
    ['clock_in_lat', 'clock_in_lat_encrypted'], ['clock_in_lng', 'clock_in_lng_encrypted'],
    ['clock_out_lat', 'clock_out_lat_encrypted'], ['clock_out_lng', 'clock_out_lng_encrypted'],
  ]);
  await backfillPairedColumns(connection, 'leave_requests', 'id', [
    ['reason', 'reason_encrypted'], ['remarks', 'remarks_encrypted'],
    ['rejection_remarks', 'rejection_remarks_encrypted'], ['approval_remarks', 'approval_remarks_encrypted'],
  ]);
  await backfillPairedColumns(connection, 'user_profile_audit_logs', 'id', [['old_value', 'old_value_encrypted'], ['new_value', 'new_value_encrypted']]);
  await backfillPairedColumns(connection, 'user_profile_change_requests', 'id', [
    ['old_value', 'old_value_encrypted'], ['requested_value', 'requested_value_encrypted'],
    ['reason', 'reason_encrypted'], ['rejection_reason', 'rejection_reason_encrypted'],
  ]);
  await backfillPairedColumns(connection, 'leave_audit_trail', 'id', [['remarks', 'remarks_encrypted'], ['metadata', 'metadata_encrypted']]);
  await backfillPairedColumns(connection, 'onboarding_applicant_activity', 'activity_id', [
    ['reason', 'reason_encrypted'], ['old_value', 'old_value_encrypted'], ['new_value', 'new_value_encrypted'],
  ]);
  await backfillPairedColumns(connection, 'employee_deductions', 'id', [['notes', 'notes_encrypted']]);
  await backfillPairedColumns(connection, 'employee_deduction_accounts', 'id', [['remarks', 'remarks_encrypted']]);
  await encryptLegacyFiles(connection, {
    table: 'documents', primaryKey: 'id', scope: 'employee-documents', nameColumn: 'file_name', pathColumn: 'file_path',
    encryptedNameColumn: 'file_name_encrypted', encryptedPathColumn: 'encrypted_file_path', mimeColumn: 'file_mime_type', sizeColumn: 'file_size_bytes',
    encryptedLegacyPathColumn: 'legacy_file_path_encrypted',
  });
  await encryptLegacyFiles(connection, {
    table: 'leave_requests', primaryKey: 'id', scope: 'leave-attachments', nameColumn: 'file_path', pathColumn: 'file_path',
    encryptedNameColumn: 'attachment_name_encrypted', encryptedPathColumn: 'attachment_encrypted_path', mimeColumn: 'attachment_mime_type', sizeColumn: 'attachment_size_bytes',
    encryptedLegacyPathColumn: 'attachment_legacy_path_encrypted',
  });
}

exports.up = async function up() {
  const connection = await connect();
  try {
    await ensureSchema(connection);
    await backfill(connection);
  } finally {
    await connection.end();
  }
};

exports.down = async function down() {
  const connection = await connect();
  try {
    await decryptLegacyFiles(connection, {
      table: 'documents', primaryKey: 'id', nameColumn: 'file_name', pathColumn: 'file_path',
      encryptedNameColumn: 'file_name_encrypted', encryptedPathColumn: 'encrypted_file_path', mimeColumn: 'file_mime_type',
      encryptedLegacyPathColumn: 'legacy_file_path_encrypted',
    });
    await decryptLegacyFiles(connection, {
      table: 'leave_requests', primaryKey: 'id', nameColumn: 'file_path', pathColumn: 'file_path',
      encryptedNameColumn: 'attachment_name_encrypted', encryptedPathColumn: 'attachment_encrypted_path', mimeColumn: 'attachment_mime_type',
      encryptedLegacyPathColumn: 'attachment_legacy_path_encrypted',
    });
    await decryptColumnsInPlace(connection, 'employees', 'id', EMPLOYEE_PII_COLUMNS);
    await backfillPairedColumns(connection, 'employees', 'id', GPS_COLUMNS, true);
    await backfillPairedColumns(connection, 'onboarding_applicant', 'applicant_id', [
      ['first_name', 'first_name_encrypted'], ['middle_name', 'middle_name_encrypted'],
      ['last_name', 'last_name_encrypted'], ['suffix', 'suffix_encrypted'],
    ], true);
    await backfillPairedColumns(connection, 'MFA_CHALLENGE', 'Challenge_ID', [['Phone_Number', 'Phone_Number_Encrypted']], true);
    await decryptPhotoBlobs(connection);
    await backfillPairedColumns(connection, 'attendance', 'id', [
      ['time_in_latitude', 'time_in_latitude_encrypted'], ['time_in_longitude', 'time_in_longitude_encrypted'],
      ['time_out_latitude', 'time_out_latitude_encrypted'], ['time_out_longitude', 'time_out_longitude_encrypted'],
    ], true);
    await backfillPairedColumns(connection, 'attendance_log', 'attendance_id', [
      ['clock_in_lat', 'clock_in_lat_encrypted'], ['clock_in_lng', 'clock_in_lng_encrypted'],
      ['clock_out_lat', 'clock_out_lat_encrypted'], ['clock_out_lng', 'clock_out_lng_encrypted'],
    ], true);
    await backfillPairedColumns(connection, 'leave_requests', 'id', [
      ['reason', 'reason_encrypted'], ['remarks', 'remarks_encrypted'],
      ['rejection_remarks', 'rejection_remarks_encrypted'], ['approval_remarks', 'approval_remarks_encrypted'],
    ], true);
    await backfillPairedColumns(connection, 'user_profile_audit_logs', 'id', [['old_value', 'old_value_encrypted'], ['new_value', 'new_value_encrypted']], true);
    await backfillPairedColumns(connection, 'user_profile_change_requests', 'id', [
      ['old_value', 'old_value_encrypted'], ['requested_value', 'requested_value_encrypted'],
      ['reason', 'reason_encrypted'], ['rejection_reason', 'rejection_reason_encrypted'],
    ], true);
    await backfillPairedColumns(connection, 'leave_audit_trail', 'id', [['remarks', 'remarks_encrypted'], ['metadata', 'metadata_encrypted']], true);
    await backfillPairedColumns(connection, 'onboarding_applicant_activity', 'activity_id', [
      ['reason', 'reason_encrypted'], ['old_value', 'old_value_encrypted'], ['new_value', 'new_value_encrypted'],
    ], true);
    await backfillPairedColumns(connection, 'employee_deductions', 'id', [['notes', 'notes_encrypted']], true);
    await backfillPairedColumns(connection, 'employee_deduction_accounts', 'id', [['remarks', 'remarks_encrypted']], true);

    if (await tableExists(connection, 'users') && await columnExists(connection, 'users', 'email')) {
      const [rows] = await connection.query('SELECT id, email, email_encrypted FROM users');
      for (const row of rows) {
        if (!row.email && row.email_encrypted) await connection.execute('UPDATE users SET email = ? WHERE id = ?', [decryptColumnValue(row.email_encrypted), row.id]);
      }
    }

    const drops = {
      employees: GPS_COLUMNS.map(([, encrypted]) => encrypted),
      onboarding_applicant: ['first_name_encrypted', 'middle_name_encrypted', 'last_name_encrypted', 'suffix_encrypted'],
      MFA_CHALLENGE: ['Phone_Number_Encrypted', 'Phone_Number_Hash'],
      employee_photos: ['photo_data_encrypted', 'photo_encrypted_path'],
      attendance: ['time_in_latitude_encrypted', 'time_in_longitude_encrypted', 'time_out_latitude_encrypted', 'time_out_longitude_encrypted'],
      attendance_log: ['clock_in_lat_encrypted', 'clock_in_lng_encrypted', 'clock_out_lat_encrypted', 'clock_out_lng_encrypted'],
      leave_requests: ['reason_encrypted', 'remarks_encrypted', 'rejection_remarks_encrypted', 'approval_remarks_encrypted', 'attachment_name_encrypted', 'attachment_encrypted_path', 'attachment_legacy_path_encrypted', 'attachment_mime_type', 'attachment_size_bytes'],
      documents: ['file_name_encrypted', 'encrypted_file_path', 'legacy_file_path_encrypted', 'file_mime_type', 'file_size_bytes'],
      user_profile_audit_logs: ['old_value_encrypted', 'new_value_encrypted'],
      user_profile_change_requests: ['old_value_encrypted', 'requested_value_encrypted', 'reason_encrypted', 'rejection_reason_encrypted'],
      leave_audit_trail: ['remarks_encrypted', 'metadata_encrypted'],
      onboarding_applicant_activity: ['reason_encrypted', 'old_value_encrypted', 'new_value_encrypted'],
      employee_deductions: ['notes_encrypted'],
      employee_deduction_accounts: ['remarks_encrypted'],
    };
    for (const [table, columns] of Object.entries(drops)) for (const column of columns) await dropColumn(connection, table, column);
    await modifyColumn(connection, 'onboarding_applicant', 'first_name', 'VARCHAR(100) NOT NULL');
    await modifyColumn(connection, 'onboarding_applicant', 'last_name', 'VARCHAR(100) NOT NULL');
    await modifyColumn(connection, 'employee_photos', 'photo_data', 'LONGBLOB NOT NULL');
  } finally {
    await connection.end();
  }
};
