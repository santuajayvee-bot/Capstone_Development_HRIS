/*
 * One-time strict at-rest encryption backfill.
 *
 * Encrypts existing plaintext sensitive DB values into AES-256-GCM columns,
 * creates lookup hashes, then clears nullable plaintext columns where the app
 * no longer needs plaintext storage.
 */

require('dotenv').config();

const pool = require('../config/db');
const {
  encryptColumnValue,
  encryptNullable,
  encryptPII,
  hashNullable,
  isEncryptedValue,
} = require('../server/data-protection');

const FAMILY_PII_FIELDS = [
  'relationship_type', 'extension_name', 'first_name', 'middle_name', 'last_name',
  'date_of_birth', 'telephone_number', 'business_address', 'occupation', 'employer_name', 'deceased'
];
const WORK_EXPERIENCE_PII_FIELDS = [
  'company_name', 'position_title', 'employment_type', 'date_from', 'date_to',
  'supervisor_name', 'company_address', 'reason_for_leaving'
];
const CERTIFICATION_PII_FIELDS = [
  'certification_name', 'issuing_organization', 'issue_date', 'expiry_date'
];
const TRAINING_PII_FIELDS = [
  'training_name', 'provider', 'date_from', 'date_to', 'training_hours', 'remarks'
];
const EMPLOYEE_STRICT_PII_COLUMNS = [
  'first_name', 'middle_name', 'last_name', 'suffix',
  'email', 'contact_number', 'work_email', 'mailing_address',
  'nationality', 'marital_status', 'date_of_birth', 'place_of_birth', 'gender', 'blood_type', 'religion',
  'residential_address', 'current_address',
  'residential_address_region', 'residential_address_province', 'residential_address_city_municipality',
  'residential_address_barangay', 'residential_address_street_address', 'residential_address_full_address', 'residential_address_place_id',
  'current_address_region', 'current_address_province', 'current_address_city_municipality',
  'current_address_barangay', 'current_address_street_address', 'current_address_full_address', 'current_address_place_id',
  'mailing_address_region', 'mailing_address_province', 'mailing_address_city_municipality',
  'mailing_address_barangay', 'mailing_address_street_address', 'mailing_address_full_address', 'mailing_address_place_id',
  'emergency_contact_name', 'emergency_contact_num', 'emergency_contact_relationship',
  'emergency_contact_secondary_num', 'emergency_contact_email', 'emergency_contact_address',
  'education_school', 'education_attainment', 'education_units', 'education_year_graduated',
  'education_jhs_school', 'education_jhs_attainment', 'education_jhs_from', 'education_jhs_to', 'education_jhs_year_graduated',
  'education_shs_school', 'education_shs_attainment', 'education_shs_from', 'education_shs_to', 'education_shs_year_graduated',
  'education_vocational_school', 'education_vocational_attainment', 'education_vocational_units',
  'education_vocational_from', 'education_vocational_to', 'education_vocational_year_graduated',
  'education_college_school', 'education_college_attainment', 'education_college_units',
  'education_college_from', 'education_college_to', 'education_college_year_graduated',
  'sss_number', 'philhealth_number', 'pagibig_number', 'tin', 'tax_status', 'bank_name', 'bank_account',
  'agency_contact_person', 'agency_contact_number', 'separation_reason', 'offboarding_remarks'
];

async function hasColumn(table, column) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [table, column]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function widenEmployeeStrictColumns() {
  const widened = [];
  for (const field of EMPLOYEE_STRICT_PII_COLUMNS) {
    if (!(await hasColumn('employees', field))) continue;
    const definition = field === 'email' ? 'VARCHAR(512) NULL' : 'TEXT NULL';
    await pool.execute(`ALTER TABLE employees MODIFY COLUMN ${field} ${definition}`);
    widened.push(field);
  }
  return { table: 'employees.strict_pii_column_types', updated: widened.length };
}

async function backfillUsers() {
  if (!(await hasColumn('users', 'email')) || !(await hasColumn('users', 'email_encrypted')) || !(await hasColumn('users', 'email_hash'))) {
    return { table: 'users', updated: 0, skipped: true };
  }

  const [rows] = await pool.execute(
    `SELECT id, email, email_encrypted
       FROM users
      WHERE email IS NOT NULL AND email <> ''`
  );

  let updated = 0;
  for (const row of rows) {
    await pool.execute(
      `UPDATE users
          SET email_hash = ?,
              email_encrypted = COALESCE(email_encrypted, ?),
              email = NULL
        WHERE id = ?`,
      [hashNullable(row.email), row.email_encrypted || encryptNullable(row.email), row.id]
    );
    updated += 1;
  }

  return { table: 'users', updated };
}

async function backfillSensitiveEmployeeData() {
  if (!(await hasColumn('sensitive_employee_data', 'ssn_encrypted'))) {
    return { table: 'sensitive_employee_data', updated: 0, skipped: true };
  }

  const [rows] = await pool.execute(
    `SELECT id, ssn, tax_id, bank_account_number, bank_routing_number,
            emergency_contact_phone, other_sensitive_info
       FROM sensitive_employee_data`
  );

  let updated = 0;
  for (const row of rows) {
    const hasPlaintext = [
      row.ssn,
      row.tax_id,
      row.bank_account_number,
      row.bank_routing_number,
      row.emergency_contact_phone,
      row.other_sensitive_info,
    ].some(value => value !== null && value !== undefined && String(value).trim() !== '');

    if (!hasPlaintext) continue;

    await pool.execute(
      `UPDATE sensitive_employee_data
          SET ssn_encrypted = COALESCE(ssn_encrypted, ?),
              ssn_hash = COALESCE(ssn_hash, ?),
              tax_id_encrypted = COALESCE(tax_id_encrypted, ?),
              tax_id_hash = COALESCE(tax_id_hash, ?),
              bank_account_number_encrypted = COALESCE(bank_account_number_encrypted, ?),
              bank_account_number_hash = COALESCE(bank_account_number_hash, ?),
              bank_routing_number_encrypted = COALESCE(bank_routing_number_encrypted, ?),
              bank_routing_number_hash = COALESCE(bank_routing_number_hash, ?),
              emergency_contact_phone_encrypted = COALESCE(emergency_contact_phone_encrypted, ?),
              emergency_contact_phone_hash = COALESCE(emergency_contact_phone_hash, ?),
              other_sensitive_info_encrypted = COALESCE(other_sensitive_info_encrypted, ?),
              ssn = NULL,
              tax_id = NULL,
              bank_account_number = NULL,
              bank_routing_number = NULL,
              emergency_contact_phone = NULL,
              other_sensitive_info = NULL
        WHERE id = ?`,
      [
        encryptNullable(row.ssn),
        hashNullable(row.ssn),
        encryptNullable(row.tax_id),
        hashNullable(row.tax_id),
        encryptNullable(row.bank_account_number),
        hashNullable(row.bank_account_number),
        encryptNullable(row.bank_routing_number),
        hashNullable(row.bank_routing_number),
        encryptNullable(row.emergency_contact_phone),
        hashNullable(row.emergency_contact_phone),
        encryptNullable(row.other_sensitive_info),
        row.id,
      ]
    );
    updated += 1;
  }

  return { table: 'sensitive_employee_data', updated };
}

async function backfillEmployeePii() {
  if (!(await hasColumn('employees', 'encrypted_pii'))) {
    return { table: 'employees.encrypted_pii', updated: 0, skipped: true };
  }

  const [rows] = await pool.execute(
    `SELECT id, email, contact_number, residential_address, emergency_contact_name,
            emergency_contact_num, nationality, date_of_birth, gender
       FROM employees
      WHERE encrypted_pii IS NULL OR encrypted_pii = ''`
  );

  let updated = 0;
  for (const row of rows) {
    const pii = {
      email: row.email || null,
      contact_number: row.contact_number || null,
      residential_address: row.residential_address || null,
      emergency_contact_name: row.emergency_contact_name || null,
      emergency_contact_num: row.emergency_contact_num || null,
      nationality: row.nationality || null,
      date_of_birth: row.date_of_birth || null,
      gender: row.gender || null,
    };

    const hasPii = Object.values(pii).some(value => value !== null && value !== undefined && String(value).trim() !== '');
    if (!hasPii) continue;

    await pool.execute(
      'UPDATE employees SET encrypted_pii = ? WHERE id = ?',
      [encryptPII(pii), row.id]
    );
    updated += 1;
  }

  return { table: 'employees.encrypted_pii', updated };
}

async function backfillEmployeeStrictColumns() {
  const availableFields = [];
  for (const field of EMPLOYEE_STRICT_PII_COLUMNS) {
    if (await hasColumn('employees', field)) availableFields.push(field);
  }
  if (!availableFields.length) {
    return { table: 'employees.strict_pii_columns', updated: 0, skipped: true };
  }

  const [rows] = await pool.execute(`SELECT id, ${availableFields.join(', ')} FROM employees`);
  let updated = 0;
  for (const row of rows) {
    const assignments = [];
    const params = [];
    for (const field of availableFields) {
      const value = row[field];
      if (value === null || value === undefined || String(value).trim() === '' || isEncryptedValue(String(value))) continue;
      assignments.push(`${field} = ?`);
      params.push(encryptColumnValue(value));
    }
    if (!assignments.length) continue;
    params.push(row.id);
    await pool.execute(`UPDATE employees SET ${assignments.join(', ')} WHERE id = ?`, params);
    updated += 1;
  }

  return { table: 'employees.strict_pii_columns', updated };
}

function hasPlaintext(row, fields) {
  return fields.some(field => row[field] !== null && row[field] !== undefined && String(row[field]).trim() !== '');
}

function encryptedPayload(row, fields) {
  const payload = {};
  fields.forEach(field => {
    payload[field] = row[field] === undefined || row[field] === '' ? null : row[field];
  });
  return encryptPII(payload);
}

async function backfillEncryptedPayloadTable({ table, fields, clearSql }) {
  if (!(await hasColumn(table, 'pii_encrypted'))) {
    return { table, updated: 0, skipped: true };
  }

  const [rows] = await pool.execute(
    `SELECT id, ${fields.join(', ')}
       FROM ${table}
      WHERE pii_encrypted IS NULL OR pii_encrypted = ''`
  );

  let updated = 0;
  for (const row of rows) {
    if (!hasPlaintext(row, fields)) continue;
    await pool.execute(
      `UPDATE ${table}
          SET pii_encrypted = ?,
              ${clearSql}
        WHERE id = ?`,
      [encryptedPayload(row, fields), row.id]
    );
    updated += 1;
  }

  return { table, updated };
}

async function main() {
  if (!process.env.AES_ENCRYPTION_KEY && !process.env.JWT_SECRET) {
    throw new Error('AES_ENCRYPTION_KEY is required for strict at-rest encryption backfill.');
  }

  const results = [];
  results.push(await widenEmployeeStrictColumns());
  results.push(await backfillUsers());
  results.push(await backfillSensitiveEmployeeData());
  results.push(await backfillEmployeePii());
  results.push(await backfillEmployeeStrictColumns());
  results.push(await backfillEncryptedPayloadTable({
    table: 'employee_family_members',
    fields: FAMILY_PII_FIELDS,
    clearSql: 'relationship_type = NULL, extension_name = NULL, first_name = NULL, middle_name = NULL, last_name = NULL, date_of_birth = NULL, telephone_number = NULL, business_address = NULL, occupation = NULL, employer_name = NULL, deceased = NULL',
  }));
  results.push(await backfillEncryptedPayloadTable({
    table: 'employee_work_experiences',
    fields: WORK_EXPERIENCE_PII_FIELDS,
    clearSql: 'company_name = NULL, position_title = NULL, employment_type = NULL, date_from = NULL, date_to = NULL, supervisor_name = NULL, company_address = NULL, reason_for_leaving = NULL',
  }));
  results.push(await backfillEncryptedPayloadTable({
    table: 'employee_certifications',
    fields: CERTIFICATION_PII_FIELDS,
    clearSql: 'certification_name = NULL, issuing_organization = NULL, issue_date = NULL, expiry_date = NULL',
  }));
  results.push(await backfillEncryptedPayloadTable({
    table: 'employee_trainings',
    fields: TRAINING_PII_FIELDS,
    clearSql: 'training_name = NULL, provider = NULL, date_from = NULL, date_to = NULL, training_hours = NULL, remarks = NULL',
  }));

  console.table(results);
}

main()
  .catch(error => {
    console.error('Strict at-rest encryption backfill failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
