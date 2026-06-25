const express = require('express');
const multer = require('multer');
const argon2 = require('argon2');

const pool = require('../config/db');
const { requireAuth, requireRole, ROLES } = require('./middleware');
const accountController = require('../controllers/accountController');
const { ALLOWED_UPLOAD_TYPES, auditSecurityEvent } = require('./security-controls');
const { decryptColumnValue, encryptColumnValue } = require('./data-protection');

const router = express.Router();
const HR_REVIEW_ROLES = [...ROLES.hr_manager, ...ROLES.admin_any];
const PHOTO_MAX_SIZE_MB = Number(process.env.PROFILE_PHOTO_MAX_SIZE_MB || 5);

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PHOTO_MAX_SIZE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) return cb(null, true);
    cb(new Error('Profile picture must be JPG or PNG.'));
  }
});

const DIRECT_EDIT_FIELDS = {
  email: 'email',
  work_email: 'work_email',
  contact_number: 'contact_number',
  current_address: 'current_address',
  current_address_region: 'current_address_region',
  current_address_province: 'current_address_province',
  current_address_city_municipality: 'current_address_city_municipality',
  current_address_barangay: 'current_address_barangay',
  current_address_street_address: 'current_address_street_address',
  current_address_full_address: 'current_address_full_address',
  current_address_place_id: 'current_address_place_id',
  current_address_lat: 'current_address_lat',
  current_address_lng: 'current_address_lng',
  current_address_same_as_home: 'current_address_same_as_home',
  mailing_address: 'mailing_address',
  mailing_address_region: 'mailing_address_region',
  mailing_address_province: 'mailing_address_province',
  mailing_address_city_municipality: 'mailing_address_city_municipality',
  mailing_address_barangay: 'mailing_address_barangay',
  mailing_address_street_address: 'mailing_address_street_address',
  mailing_address_full_address: 'mailing_address_full_address',
  mailing_address_place_id: 'mailing_address_place_id',
  mailing_address_lat: 'mailing_address_lat',
  mailing_address_lng: 'mailing_address_lng',
  mailing_address_same_as_home: 'mailing_address_same_as_home',
  emergency_contact_name: 'emergency_contact_name',
  emergency_contact_relationship: 'emergency_contact_relationship',
  emergency_contact_num: 'emergency_contact_num',
  emergency_contact_email: 'emergency_contact_email'
};

const CHANGE_REQUEST_FIELDS = {
  full_legal_name: { label: 'Full legal name correction' },
  civil_status: { column: 'marital_status', label: 'Civil status' },
  permanent_address: { column: 'residential_address', label: 'Permanent/residential address' },
  sss_number: { column: 'sss', label: 'SSS number' },
  philhealth_number: { column: 'philhealth', label: 'PhilHealth number' },
  pagibig_number: { column: 'pagibig', label: 'Pag-IBIG number' },
  tin: { column: 'tin', label: 'TIN' },
  bank_account_number: { column: 'bank_account_number', label: 'Bank account number' },
  bank_name: { column: 'bank_name', label: 'Bank name' }
};

const SELF_SERVICE_FORBIDDEN_FIELDS = new Set([
  'department_id', 'wage_type', 'wage_type_id', 'base_rate', 'allowance', 'allowances',
  'payroll_schedule', 'salary_grade', 'employment_type', 'hiring_type', 'deployment_status',
  'employee_level', 'status', 'position', 'supervisor', 'work_location', 'date_hired',
  'end_of_contract', 'sss_number', 'philhealth_number', 'pagibig_number', 'tin',
  'tax_status', 'bank_name', 'bank_account'
]);
const SELF_TEXT_PATTERN = /^[A-Za-zÀ-ÖØ-öø-ÿÑñ\s'.-]+$/;
const SELF_ADDRESS_PATTERN = /^[A-Za-z0-9À-ÖØ-öø-ÿÑñ\s,.'#/-]+$/;
const SELF_FORBIDDEN_PATTERN = /(<|>|<\/|script|javascript:|onerror\s*=|onload\s*=|\b(select|insert|update|delete|drop|alter|union|exec|truncate)\b|--|;)/i;
const SELF_SERVICE_ENCRYPTED_EMPLOYEE_COLUMNS = new Set([
  'email', 'work_email', 'contact_number', 'current_address',
  'current_address_region', 'current_address_province', 'current_address_city_municipality',
  'current_address_barangay', 'current_address_street_address', 'current_address_full_address',
  'current_address_place_id', 'marital_status', 'residential_address',
  'bank_name', 'first_name', 'middle_name', 'last_name', 'suffix'
]);

let schemaReady;

function cleanText(value, max = 500) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

function selfInvalid(field) {
  const error = new Error(`Invalid input for ${field}.`);
  error.status = 400;
  error.field = field;
  return error;
}

function selfNormalize(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

function selfRejectUnsafe(field, value) {
  const text = selfNormalize(value);
  if (text == null) return null;
  if (SELF_FORBIDDEN_PATTERN.test(text) || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) throw selfInvalid(field);
  return text;
}

function validateSelfProfileValue(field, value) {
  if (field.endsWith('_same_as_home')) return value ? 1 : 0;
  const text = selfRejectUnsafe(field, value);
  if (text == null) return null;

  if (field === 'email' || field === 'work_email' || field === 'emergency_contact_email') {
    const email = text.toLowerCase();
    if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(email)) throw selfInvalid(field);
    return email;
  }
  if (field === 'contact_number' || field === 'emergency_contact_num') {
    const phone = text.replace(/[\s()-]/g, '');
    if (!/^(09\d{9}|\+639\d{9})$/.test(phone)) throw selfInvalid(field);
    return phone;
  }
  if (field.endsWith('_lat') || field.endsWith('_lng')) {
    const number = Number(text);
    const isLat = field.endsWith('_lat');
    if (!Number.isFinite(number) || number < (isLat ? -90 : -180) || number > (isLat ? 90 : 180)) throw selfInvalid(field);
    return String(number);
  }
  if (field === 'emergency_contact_name' || field === 'emergency_contact_relationship') {
    if (text.length > 120 || !SELF_TEXT_PATTERN.test(text)) throw selfInvalid(field);
    return text.replace(/\s+/g, ' ');
  }
  if (field.includes('address')) {
    if (text.length > 700 || !SELF_ADDRESS_PATTERN.test(text)) throw selfInvalid(field);
    return text;
  }
  if (text.length > 255) throw selfInvalid(field);
  return text;
}

async function auditSelfServiceBlocked(req, field, value) {
  await auditSecurityEvent(req, {
    action: 'blocked_self_service_parameter_tampering_attempt',
    module: 'EMPLOYEE_SELF_SERVICE_SECURITY',
    targetTable: 'employees',
    targetRecord: currentEmployeeId(req),
    newValue: { field, value, path: req.originalUrl },
    result: 'blocked',
  });
}

function currentUserId(req) {
  return Number(req.user?.id || req.user?.userId || 0);
}

function currentEmployeeId(req) {
  return Number(req.user?.employeeId || req.user?.employee_id || 0);
}

async function tableExists(connection, tableName) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [tableName]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function columnExists(connection, tableName, columnName) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function ensureColumn(connection, tableName, columnName, definition) {
  if (await columnExists(connection, tableName, columnName)) return;
  await connection.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

async function ensureSelfServiceSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const connection = await pool.getConnection();
    try {
      await connection.query(`
        CREATE TABLE IF NOT EXISTS user_profile_change_requests (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id BIGINT NOT NULL,
          employee_id BIGINT NOT NULL,
          field_name VARCHAR(120) NOT NULL,
          old_value TEXT NULL,
          requested_value TEXT NOT NULL,
          reason TEXT NULL,
          status ENUM('Pending','Approved','Rejected') NOT NULL DEFAULT 'Pending',
          reviewed_by BIGINT NULL,
          reviewed_at DATETIME NULL,
          rejection_reason TEXT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_profile_request_employee (employee_id),
          INDEX idx_profile_request_status (status)
        )
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS user_profile_audit_logs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id BIGINT NOT NULL,
          employee_id BIGINT NOT NULL,
          action VARCHAR(120) NOT NULL,
          field_changed VARCHAR(120) NULL,
          old_value TEXT NULL,
          new_value TEXT NULL,
          ip_address VARCHAR(80) NULL,
          user_agent VARCHAR(255) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_profile_audit_employee (employee_id),
          INDEX idx_profile_audit_user (user_id)
        )
      `);
      if (!(await tableExists(connection, 'employee_photos'))) {
        await connection.query(`
          CREATE TABLE employee_photos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            employee_id INT NOT NULL UNIQUE,
            photo_data LONGBLOB NOT NULL,
            photo_mime_type VARCHAR(50) DEFAULT 'image/jpeg',
            photo_size INT,
            uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_employee_id (employee_id)
          )
        `);
      }
      await ensureColumn(connection, 'employees', 'photo_id', 'INT NULL');
      await ensureColumn(connection, 'employees', 'email', 'VARCHAR(255) NULL');
      await ensureColumn(connection, 'employees', 'work_email', 'VARCHAR(255) NULL');
      await ensureColumn(connection, 'employees', 'contact_number', 'VARCHAR(50) NULL');
      await ensureColumn(connection, 'employees', 'current_address', 'TEXT NULL');
      await ensureColumn(connection, 'employees', 'current_address_region', 'VARCHAR(120) NULL');
      await ensureColumn(connection, 'employees', 'current_address_province', 'VARCHAR(120) NULL');
      await ensureColumn(connection, 'employees', 'current_address_city_municipality', 'VARCHAR(160) NULL');
      await ensureColumn(connection, 'employees', 'current_address_barangay', 'VARCHAR(160) NULL');
      await ensureColumn(connection, 'employees', 'current_address_street_address', 'VARCHAR(255) NULL');
      await ensureColumn(connection, 'employees', 'current_address_full_address', 'TEXT NULL');
      await ensureColumn(connection, 'employees', 'current_address_place_id', 'VARCHAR(255) NULL');
      await ensureColumn(connection, 'employees', 'current_address_lat', 'DECIMAL(10,7) NULL');
      await ensureColumn(connection, 'employees', 'current_address_lng', 'DECIMAL(10,7) NULL');
      await ensureColumn(connection, 'employees', 'current_address_same_as_home', 'TINYINT(1) NOT NULL DEFAULT 0');
      await ensureColumn(connection, 'employees', 'mailing_address', 'TEXT NULL');
      await ensureColumn(connection, 'employees', 'mailing_address_region', 'VARCHAR(120) NULL');
      await ensureColumn(connection, 'employees', 'mailing_address_province', 'VARCHAR(120) NULL');
      await ensureColumn(connection, 'employees', 'mailing_address_city_municipality', 'VARCHAR(160) NULL');
      await ensureColumn(connection, 'employees', 'mailing_address_barangay', 'VARCHAR(160) NULL');
      await ensureColumn(connection, 'employees', 'mailing_address_street_address', 'VARCHAR(255) NULL');
      await ensureColumn(connection, 'employees', 'mailing_address_full_address', 'TEXT NULL');
      await ensureColumn(connection, 'employees', 'mailing_address_place_id', 'VARCHAR(255) NULL');
      await ensureColumn(connection, 'employees', 'mailing_address_lat', 'DECIMAL(10,7) NULL');
      await ensureColumn(connection, 'employees', 'mailing_address_lng', 'DECIMAL(10,7) NULL');
      await ensureColumn(connection, 'employees', 'mailing_address_same_as_home', 'TINYINT(1) NOT NULL DEFAULT 0');
      await ensureColumn(connection, 'employees', 'emergency_contact_name', 'VARCHAR(180) NULL');
      await ensureColumn(connection, 'employees', 'emergency_contact_num', 'VARCHAR(50) NULL');
      await ensureColumn(connection, 'employees', 'emergency_contact_relationship', 'VARCHAR(100) NULL');
      await ensureColumn(connection, 'employees', 'emergency_contact_email', 'VARCHAR(255) NULL');
    } finally {
      connection.release();
    }
  })();
  return schemaReady;
}

async function auditProfile(req, connection, action, field, oldValue, newValue, employeeId = currentEmployeeId(req)) {
  await connection.execute(
    `INSERT INTO user_profile_audit_logs
       (user_id, employee_id, action, field_changed, old_value, new_value, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      currentUserId(req),
      employeeId,
      action,
      field || null,
      oldValue == null ? null : String(oldValue),
      newValue == null ? null : String(newValue),
      req.ip || null,
      String(req.headers['user-agent'] || '').slice(0, 255) || null
    ]
  );
}

async function getUserPasswordHash(userId) {
  const [rows] = await pool.execute('SELECT password_hash FROM users WHERE id = ? LIMIT 1', [userId]);
  return rows[0]?.password_hash || null;
}

async function verifyPassword(hash, password) {
  if (!hash || !password) return false;
  if (!hash.startsWith('$argon2')) return false;
  return argon2.verify(hash, password);
}

function maskSensitive(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 4) return '****';
  return `${'*'.repeat(Math.max(text.length - 4, 4))}${text.slice(-4)}`;
}

function employeeFullName(row) {
  return [row.first_name, row.middle_name, row.last_name, row.suffix].filter(Boolean).join(' ');
}

function profilePhotoUrl(employeeId, photoId) {
  return photoId ? `/api/self-service/profile-picture?employee_id=${employeeId}&v=${encodeURIComponent(photoId)}` : '';
}

async function loadOwnProfile(employeeId, userId) {
  const usersHasEmail = await columnExists(pool, 'users', 'email').catch(() => false);
  const employeesHasDepartmentId = await columnExists(pool, 'employees', 'department_id').catch(() => false);
  const employeesHasWageTypeId = await columnExists(pool, 'employees', 'wage_type_id').catch(() => false);
  const employeesHasPositionId = await columnExists(pool, 'employees', 'position_id').catch(() => false);
  const hasDepartmentsTable = await tableExists(pool, 'departments').catch(() => false);
  const hasWageTypesTable = await tableExists(pool, 'wage_types').catch(() => false);
  const hasPositionsTable = await tableExists(pool, 'positions').catch(() => false);

  const accountEmailSelect = usersHasEmail ? 'u.email AS account_email' : 'NULL AS account_email';
  const departmentNameSelect = hasDepartmentsTable && employeesHasDepartmentId
    ? 'd.name AS department_name'
    : 'NULL AS department_name';
  const wageTypeNameSelect = hasWageTypesTable && employeesHasWageTypeId
    ? 'wt.name AS wage_type_name'
    : 'NULL AS wage_type_name';
  const positionNameSelect = hasPositionsTable && employeesHasPositionId
    ? 'COALESCE(p.name, e.position) AS position_name'
    : 'e.position AS position_name';
  const optionalJoins = [
    hasDepartmentsTable && employeesHasDepartmentId ? 'LEFT JOIN departments d ON d.id = e.department_id' : '',
    hasWageTypesTable && employeesHasWageTypeId ? 'LEFT JOIN wage_types wt ON wt.id = e.wage_type_id' : '',
    hasPositionsTable && employeesHasPositionId ? 'LEFT JOIN positions p ON p.id = e.position_id' : ''
  ].filter(Boolean).join('\n       ');

  const [rows] = await pool.execute(
    `SELECT e.*,
            u.username,
            ${accountEmailSelect},
            r.name AS role,
            r.label AS role_label,
            ${departmentNameSelect},
            ${wageTypeNameSelect},
            ${positionNameSelect}
       FROM users u
       JOIN employees e ON e.id = u.employee_id
       LEFT JOIN roles r ON r.id = u.role_id
       ${optionalJoins}
      WHERE u.id = ? AND e.id = ?
      LIMIT 1`,
    [userId, employeeId]
  );
  const profile = rows[0] || null;
  if (!profile) return null;
  for (const column of SELF_SERVICE_ENCRYPTED_EMPLOYEE_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(profile, column)) {
      profile[column] = decryptColumnValue(profile[column]);
    }
  }
  return profile;
}

function safeProfilePayload(row) {
  return {
    readonly: {
      employee_id: row.id,
      employee_code: row.employee_code,
      full_name: employeeFullName(row),
      department: row.department_name || row.department || '',
      position: row.position_name || row.position || '',
      wage_type: row.wage_type_name || row.wage_type || '',
      employment_status: row.status || row.employment_status || '',
      date_hired: row.hire_date || row.date_hired || row.joined_date || '',
      daily_rate: row.daily_rate != null ? row.daily_rate : null,
      hourly_rate: row.hourly_rate != null ? row.hourly_rate : null,
      piece_rate: row.piece_rate != null ? row.piece_rate : null,
      trip_rate: row.trip_rate != null ? row.trip_rate : null
    },
    editable: {
      email: row.email || row.account_email || '',
      work_email: row.work_email || '',
      contact_number: row.contact_number || '',
      current_address: row.current_address || '',
      current_address_region: row.current_address_region || '',
      current_address_province: row.current_address_province || '',
      current_address_city_municipality: row.current_address_city_municipality || '',
      current_address_barangay: row.current_address_barangay || '',
      current_address_street_address: row.current_address_street_address || '',
      current_address_full_address: row.current_address_full_address || '',
      current_address_place_id: row.current_address_place_id || '',
      current_address_lat: row.current_address_lat || '',
      current_address_lng: row.current_address_lng || '',
      current_address_same_as_home: Number(row.current_address_same_as_home || 0) === 1,
      mailing_address: row.mailing_address || '',
      mailing_address_region: row.mailing_address_region || '',
      mailing_address_province: row.mailing_address_province || '',
      mailing_address_city_municipality: row.mailing_address_city_municipality || '',
      mailing_address_barangay: row.mailing_address_barangay || '',
      mailing_address_street_address: row.mailing_address_street_address || '',
      mailing_address_full_address: row.mailing_address_full_address || '',
      mailing_address_place_id: row.mailing_address_place_id || '',
      mailing_address_lat: row.mailing_address_lat || '',
      mailing_address_lng: row.mailing_address_lng || '',
      mailing_address_same_as_home: Number(row.mailing_address_same_as_home || 0) === 1,
      emergency_contact_name: row.emergency_contact_name || '',
      emergency_contact_relationship: row.emergency_contact_relationship || '',
      emergency_contact_num: row.emergency_contact_num || '',
      emergency_contact_email: row.emergency_contact_email || '',
      photo_url: profilePhotoUrl(row.id, row.photo_id)
    },
    restricted: {
      civil_status: row.marital_status || '',
      permanent_address: row.residential_address || '',
      sss_number: maskSensitive(row.sss),
      philhealth_number: maskSensitive(row.philhealth),
      pagibig_number: maskSensitive(row.pagibig),
      tin: maskSensitive(row.tin),
      bank_account_number: maskSensitive(row.bank_account_number),
      bank_name: row.bank_name ? 'On file' : ''
    }
  };
}

router.use(requireAuth, requireRole(ROLES.any), async (_req, res, next) => {
  try {
    await ensureSelfServiceSchema();
    next();
  } catch (error) {
    console.error('[self-service/schema]', error.message);
    res.status(500).json({ error: 'Self-service profile is temporarily unavailable.' });
  }
});

router.get('/self-service/profile', async (req, res) => {
  try {
    const employeeId = currentEmployeeId(req);
    if (!employeeId) return res.status(403).json({ error: 'No linked employee profile found for this account.' });
    const profile = await loadOwnProfile(employeeId, currentUserId(req));
    if (!profile) return res.status(404).json({ error: 'Profile not found.' });
    res.json(safeProfilePayload(profile));
  } catch (error) {
    console.error('[self-service/profile:get]', error.message);
    res.status(500).json({ error: 'Failed to load profile.' });
  }
});

router.put('/self-service/profile', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const employeeId = currentEmployeeId(req);
    const userId = currentUserId(req);
    if (!employeeId) return res.status(403).json({ error: 'No linked employee profile found for this account.' });
    const profile = await loadOwnProfile(employeeId, userId);
    if (!profile) return res.status(404).json({ error: 'Profile not found.' });

    for (const field of Object.keys(req.body || {})) {
      if (field === 'password_confirmation') continue;
      if (!Object.prototype.hasOwnProperty.call(DIRECT_EDIT_FIELDS, field) || SELF_SERVICE_FORBIDDEN_FIELDS.has(field)) {
        await auditSelfServiceBlocked(req, field, req.body[field]);
        return res.status(403).json({ error: 'You are not allowed to modify this field.' });
      }
    }

    const updates = [];
    const params = [];
    const changed = [];
    for (const [inputName, columnName] of Object.entries(DIRECT_EDIT_FIELDS)) {
      if (!Object.prototype.hasOwnProperty.call(req.body, inputName)) continue;
      const oldValue = profile[columnName];
      const newValue = validateSelfProfileValue(inputName, req.body[inputName]);
      if (String(oldValue ?? '') === String(newValue ?? '')) continue;
      updates.push(`${columnName} = ?`);
      params.push(SELF_SERVICE_ENCRYPTED_EMPLOYEE_COLUMNS.has(columnName) ? encryptColumnValue(newValue) : newValue);
      changed.push({ field: inputName, oldValue, newValue });
    }

    const emailChange = changed.find(item => item.field === 'email');
    if (emailChange) {
      const hash = await getUserPasswordHash(userId);
      const confirmed = await verifyPassword(hash, req.body.password_confirmation || '');
      if (!confirmed) {
        return res.status(400).json({ error: 'Password confirmation is required to change email.' });
      }
    }

    if (!updates.length) return res.json({ message: 'No profile changes to save.' });

    await connection.beginTransaction();
    params.push(employeeId);
    await connection.execute(`UPDATE employees SET ${updates.join(', ')} WHERE id = ?`, params);
    if (emailChange) {
      await connection.execute('UPDATE users SET email = ? WHERE id = ?', [emailChange.newValue, userId]);
    }
    for (const item of changed) {
      await auditProfile(req, connection, item.field === 'email' ? 'Email changed' : 'Profile updated', item.field, item.oldValue, item.newValue);
    }
    await connection.commit();
    res.json({ message: 'Profile updated successfully.', changed: changed.map(item => item.field) });
  } catch (error) {
    await connection.rollback();
    console.error('[self-service/profile:put]', error.message);
    if (error.status === 400) {
      await auditSelfServiceBlocked(req, error.field || 'unknown', req.body?.[error.field]);
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to update profile.' });
  } finally {
    connection.release();
  }
});

router.put('/self-service/password', accountController.changeOwnAccountPassword);

router.post('/self-service/profile-picture', (req, res, next) => {
  photoUpload.single('photo')(req, res, err => {
    if (!err) return next();
    const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
      ? `Profile picture must be ${PHOTO_MAX_SIZE_MB}MB or smaller.`
      : err.message || 'Profile picture upload failed.';
    return res.status(400).json({ error: message });
  });
}, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    if (!req.file) return res.status(400).json({ error: 'Profile picture is required.' });
    const employeeId = currentEmployeeId(req);
    if (!employeeId) return res.status(403).json({ error: 'No linked employee profile found for this account.' });
    const contentRule = req.file.mimetype === 'image/png'
      ? ALLOWED_UPLOAD_TYPES['.png']
      : ALLOWED_UPLOAD_TYPES['.jpg'];
    if (!contentRule?.matches(req.file.buffer)) {
      await auditSecurityEvent(req, {
        action: 'blocked_profile_photo_tampering_attempt',
        module: 'SELF_SERVICE_PROFILE',
        targetTable: 'employee_photos',
        targetRecord: employeeId,
        newValue: {
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size
        },
        result: 'blocked'
      });
      return res.status(400).json({ error: 'Profile picture content must be a valid JPG or PNG image.' });
    }

    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO employee_photos (employee_id, photo_data, photo_mime_type, photo_size)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         photo_data = VALUES(photo_data),
         photo_mime_type = VALUES(photo_mime_type),
         photo_size = VALUES(photo_size),
         updated_at = CURRENT_TIMESTAMP`,
      [employeeId, req.file.buffer, req.file.mimetype, req.file.size]
    );
    const [photoRows] = await connection.execute('SELECT id FROM employee_photos WHERE employee_id = ? LIMIT 1', [employeeId]);
    const photoId = photoRows[0]?.id || null;
    if (photoId) await connection.execute('UPDATE employees SET photo_id = ? WHERE id = ?', [photoId, employeeId]);
    await auditProfile(req, connection, 'Profile picture changed', 'profile_picture', null, photoId);
    await connection.commit();
    res.json({ message: 'Profile picture updated.', photo_url: profilePhotoUrl(employeeId, photoId) });
  } catch (error) {
    await connection.rollback();
    console.error('[self-service/profile-picture]', error.message);
    res.status(500).json({ error: 'Failed to update profile picture.' });
  } finally {
    connection.release();
  }
});

router.get('/self-service/profile-picture', async (req, res) => {
  try {
    const employeeId = currentEmployeeId(req);
    const requestedEmployeeId = Number(req.query.employee_id || employeeId);
    if (requestedEmployeeId !== employeeId && !HR_REVIEW_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'You can only view your own profile picture.' });
    }
    const [rows] = await pool.execute(
      'SELECT photo_data, photo_mime_type FROM employee_photos WHERE employee_id = ? LIMIT 1',
      [requestedEmployeeId]
    );
    if (!rows.length) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', rows[0].photo_mime_type || 'image/jpeg');
    res.send(rows[0].photo_data);
  } catch (error) {
    console.error('[self-service/profile-picture:get]', error.message);
    res.status(500).end();
  }
});

router.get('/self-service/change-requests', async (req, res) => {
  try {
    const employeeId = currentEmployeeId(req);
    const [rows] = await pool.execute(
      `SELECT id, field_name, old_value, requested_value, reason, status, reviewed_at,
              rejection_reason, created_at, updated_at
         FROM user_profile_change_requests
        WHERE employee_id = ?
        ORDER BY created_at DESC`,
      [employeeId]
    );
    res.json(rows);
  } catch (error) {
    console.error('[self-service/change-requests:get]', error.message);
    res.status(500).json({ error: 'Failed to load change requests.' });
  }
});

router.post('/self-service/change-requests', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const employeeId = currentEmployeeId(req);
    const userId = currentUserId(req);
    const fieldName = String(req.body?.field_name || '').trim();
    const requestedValue = cleanText(req.body?.requested_value, 1000);
    const reason = cleanText(req.body?.reason, 1000);
    if (!CHANGE_REQUEST_FIELDS[fieldName]) return res.status(400).json({ error: 'Invalid change request field.' });
    if (!requestedValue) return res.status(400).json({ error: 'Requested value is required.' });

    const profile = await loadOwnProfile(employeeId, userId);
    if (!profile) return res.status(404).json({ error: 'Profile not found.' });
    const config = CHANGE_REQUEST_FIELDS[fieldName];
    const oldValue = fieldName === 'full_legal_name' ? employeeFullName(profile) : profile[config.column];

    await connection.beginTransaction();
    const [result] = await connection.execute(
      `INSERT INTO user_profile_change_requests
         (user_id, employee_id, field_name, old_value, requested_value, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, employeeId, fieldName, oldValue == null ? null : String(oldValue), requestedValue, reason]
    );
    await auditProfile(req, connection, 'Change request submitted', fieldName, oldValue, requestedValue);
    await connection.commit();
    res.status(201).json({ message: 'Change request submitted.', id: result.insertId });
  } catch (error) {
    await connection.rollback();
    console.error('[self-service/change-requests:post]', error.message);
    res.status(500).json({ error: 'Failed to submit change request.' });
  } finally {
    connection.release();
  }
});

router.get('/self-service/activity-log', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, action, field_changed, created_at
         FROM user_profile_audit_logs
        WHERE user_id = ? AND employee_id = ?
        ORDER BY created_at DESC
        LIMIT 100`,
      [currentUserId(req), currentEmployeeId(req)]
    );
    res.json(rows);
  } catch (error) {
    console.error('[self-service/activity-log]', error.message);
    res.status(500).json({ error: 'Failed to load activity log.' });
  }
});

router.get('/hr/profile-change-requests', requireRole(HR_REVIEW_ROLES), async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT cr.*, e.employee_code, e.first_name, e.middle_name, e.last_name, e.suffix, u.username AS requested_by
         FROM user_profile_change_requests cr
         JOIN employees e ON e.id = cr.employee_id
         LEFT JOIN users u ON u.id = cr.user_id
        ORDER BY FIELD(cr.status, 'Pending', 'Approved', 'Rejected'), cr.created_at DESC`
    );
    res.json(rows.map(row => ({ ...row, employee_name: employeeFullName(row) })));
  } catch (error) {
    console.error('[hr/profile-change-requests:get]', error.message);
    res.status(500).json({ error: 'Failed to load profile change requests.' });
  }
});

async function applyApprovedChange(connection, employeeId, fieldName, requestedValue) {
  const config = CHANGE_REQUEST_FIELDS[fieldName];
  if (!config) throw new Error('Invalid change request field.');
  if (fieldName === 'full_legal_name') {
    const parts = String(requestedValue || '').trim().split(/\s+/).filter(Boolean);
    const firstName = parts.shift() || '';
    const lastName = parts.join(' ');
    if (!firstName || !lastName) throw new Error('Full legal name must include first and last name.');
    await connection.execute(
      'UPDATE employees SET first_name = ?, middle_name = NULL, last_name = ?, suffix = NULL WHERE id = ?',
      [encryptColumnValue(firstName), encryptColumnValue(lastName), employeeId]
    );
    return;
  }
  const value = SELF_SERVICE_ENCRYPTED_EMPLOYEE_COLUMNS.has(config.column) ? encryptColumnValue(requestedValue) : requestedValue;
  await connection.execute(`UPDATE employees SET ${config.column} = ? WHERE id = ?`, [value, employeeId]);
}

router.post('/hr/profile-change-requests/:id/approve', requireRole(HR_REVIEW_ROLES), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const requestId = Number(req.params.id);
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM user_profile_change_requests WHERE id = ? FOR UPDATE', [requestId]);
    const request = rows[0];
    if (!request) return res.status(404).json({ error: 'Change request not found.' });
    if (request.status !== 'Pending') return res.status(400).json({ error: 'Only pending requests can be approved.' });

    await applyApprovedChange(connection, request.employee_id, request.field_name, request.requested_value);
    await connection.execute(
      `UPDATE user_profile_change_requests
          SET status = 'Approved', reviewed_by = ?, reviewed_at = NOW(), rejection_reason = NULL
        WHERE id = ?`,
      [currentUserId(req), requestId]
    );
    await auditProfile(req, connection, 'Change request approved', request.field_name, request.old_value, request.requested_value, request.employee_id);
    await connection.commit();
    res.json({ message: 'Change request approved.' });
  } catch (error) {
    await connection.rollback();
    console.error('[hr/profile-change-requests:approve]', error.message);
    res.status(500).json({ error: error.message || 'Failed to approve change request.' });
  } finally {
    connection.release();
  }
});

router.post('/hr/profile-change-requests/:id/reject', requireRole(HR_REVIEW_ROLES), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const requestId = Number(req.params.id);
    const rejectionReason = cleanText(req.body?.rejection_reason, 1000);
    if (!rejectionReason) return res.status(400).json({ error: 'Rejection reason is required.' });
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM user_profile_change_requests WHERE id = ? FOR UPDATE', [requestId]);
    const request = rows[0];
    if (!request) return res.status(404).json({ error: 'Change request not found.' });
    if (request.status !== 'Pending') return res.status(400).json({ error: 'Only pending requests can be rejected.' });
    await connection.execute(
      `UPDATE user_profile_change_requests
          SET status = 'Rejected', reviewed_by = ?, reviewed_at = NOW(), rejection_reason = ?
        WHERE id = ?`,
      [currentUserId(req), rejectionReason, requestId]
    );
    await auditProfile(req, connection, 'Change request rejected', request.field_name, request.requested_value, rejectionReason, request.employee_id);
    await connection.commit();
    res.json({ message: 'Change request rejected.' });
  } catch (error) {
    await connection.rollback();
    console.error('[hr/profile-change-requests:reject]', error.message);
    res.status(500).json({ error: 'Failed to reject change request.' });
  } finally {
    connection.release();
  }
});

module.exports = router;
