/* ============================================================
   server.js — LGSV_HR System — Express + JWT + MySQL
   ============================================================ */

require('dotenv').config();
const express    = require('express');
const https      = require('https');
const path       = require('path');
const multer     = require('multer');
const fs         = require('fs');

const { login, me }                          = require('./server/auth');
const { requireAuth, requireRole, ROLES }    = require('./server/middleware');
const payrollRoutes                          = require('./server/payroll');
const fileManagementRoutes                   = require('./server/201-file-management');
const attendanceRoutes                       = require('./server/attendance');
const onboardingRoutes                       = require('./server/onboarding');
const adminRbacRoutes                        = require('./server/admin-rbac');
const employeeDashboardRoutes                = require('./server/employee-dashboard');
const { encryptPII }                         = require('./server/crypto');
const dashboardRoutes                        = require('./server/dashboard');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    // Allowed file types
    const allowedTypes = /pdf|doc|docx|jpg|jpeg|png/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, DOC, DOCX, JPG, JPEG, and PNG are allowed.'));
    }
  }
});

function uploadSingle(fieldName) {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (err) => {
      if (!err) return next();

      const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large. Maximum size is 5MB.'
        : err.message || 'File upload failed.';

      return res.status(400).json({ error: message });
    });
  };
}

app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ── PUBLIC ───────────────────────────────────────────────────
app.post('/api/auth/login', login);

// ── PROTECTED ────────────────────────────────────────────────
app.get('/api/auth/me', requireAuth, me);

app.get('/api/address/search', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 3) return res.json([]);

    const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
    if (apiKey) {
      const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
      url.searchParams.set('input', query);
      url.searchParams.set('key', apiKey);
      url.searchParams.set('components', 'country:ph');
      url.searchParams.set('types', 'geocode');

      const response = await fetch(url);
      const data = await response.json();
      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        return res.status(502).json({ error: data.error_message || `Places autocomplete failed: ${data.status}` });
      }

      const suggestions = (data.predictions || []).slice(0, 6).map(item => ({
        full_address: item.description,
        latitude: null,
        longitude: null,
        place_id: item.place_id,
        provider: 'google_places'
      })).filter(item => item.full_address && item.place_id);

      return res.json(suggestions);
    }

    const fallbackUrl = new URL('https://nominatim.openstreetmap.org/search');
    fallbackUrl.searchParams.set('format', 'jsonv2');
    fallbackUrl.searchParams.set('q', query);
    fallbackUrl.searchParams.set('countrycodes', 'ph');
    fallbackUrl.searchParams.set('limit', '6');

    try {
      const fallbackResponse = await fetch(fallbackUrl, {
        headers: { 'User-Agent': 'Marulas-HRIS/1.0 address autocomplete' }
      });
      const fallbackData = await fallbackResponse.json();
      const suggestions = (fallbackData || []).map(item => ({
        full_address: item.display_name,
        latitude: Number(item.lat),
        longitude: Number(item.lon),
        place_id: String(item.place_id || ''),
        provider: 'nominatim'
      })).filter(item => item.full_address && Number.isFinite(item.latitude) && Number.isFinite(item.longitude));

      if (suggestions.length) return res.json(suggestions);
    } catch (fallbackError) {
      console.warn('Nominatim address fallback failed:', fallbackError.message);
    }

    res.json(localPhilippineAddressSuggestions(query));
  } catch (err) {
    console.error('Address search error:', err.message);
    res.status(500).json({ error: 'Failed to search address.' });
  }
});

app.get('/api/address/details', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const placeId = String(req.query.place_id || '').trim();
    if (!placeId) return res.status(400).json({ error: 'place_id is required.' });

    const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Google Places API key is not configured.' });
    }

    const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
    url.searchParams.set('place_id', placeId);
    url.searchParams.set('fields', 'formatted_address,geometry,place_id');
    url.searchParams.set('key', apiKey);

    const response = await fetch(url);
    const data = await response.json();
    if (data.status !== 'OK') {
      return res.status(502).json({ error: data.error_message || `Place details failed: ${data.status}` });
    }

    const result = data.result || {};
    res.json({
      full_address: result.formatted_address,
      latitude: result.geometry?.location?.lat,
      longitude: result.geometry?.location?.lng,
      place_id: result.place_id || placeId,
      provider: 'google_places'
    });
  } catch (err) {
    console.error('Address details error:', err.message);
    res.status(500).json({ error: 'Failed to fetch address details.' });
  }
});

app.get('/api/form-drafts', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    await pool.execute(
      `UPDATE form_drafts
       SET status = 'Expired'
       WHERE status = 'Active' AND expires_at IS NOT NULL AND expires_at < NOW()`
    );

    const moduleName = String(req.query.module_name || '').trim();
    const formName = String(req.query.form_name || '').trim();
    const recordId = req.query.record_id === undefined || req.query.record_id === ''
      ? '__new__'
      : String(req.query.record_id);

    if (!moduleName || !formName) {
      return res.status(400).json({ error: 'module_name and form_name are required.' });
    }

    const [rows] = await pool.execute(
      `SELECT id, user_id, module_name, form_name, NULLIF(record_id, '__new__') AS record_id,
              draft_data_json, status, last_saved_at, expires_at, created_at, updated_at
       FROM form_drafts
       WHERE user_id = ? AND module_name = ? AND form_name = ? AND record_id = ? AND status = 'Active'
       LIMIT 1`,
      [req.user.id, moduleName, formName, recordId]
    );

    res.json(rows[0] || null);
  } catch (err) {
    console.error('Form draft fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch form draft.' });
  }
});

app.post('/api/form-drafts', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const moduleName = String(req.body.module_name || '').trim();
    const formName = String(req.body.form_name || '').trim();
    const recordId = req.body.record_id === undefined || req.body.record_id === null || req.body.record_id === ''
      ? '__new__'
      : String(req.body.record_id);
    const status = ['Active', 'Submitted', 'Discarded'].includes(req.body.status) ? req.body.status : 'Active';
    const expiryDays = Math.max(parseInt(req.body.expiry_days || process.env.FORM_DRAFT_EXPIRY_DAYS || '14', 10) || 14, 1);
    const draftData = req.body.draft_data || {};

    if (!moduleName || !formName) {
      return res.status(400).json({ error: 'module_name and form_name are required.' });
    }

    await pool.execute(
      `INSERT INTO form_drafts
         (user_id, module_name, form_name, record_id, draft_data_json, status, last_saved_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))
       ON DUPLICATE KEY UPDATE
         draft_data_json = VALUES(draft_data_json),
         status = VALUES(status),
         last_saved_at = NOW(),
         expires_at = VALUES(expires_at)`,
      [req.user.id, moduleName, formName, recordId, JSON.stringify(draftData), status, expiryDays]
    );

    res.json({ message: 'Draft saved.', last_saved_at: new Date().toISOString() });
  } catch (err) {
    console.error('Form draft save error:', err.message);
    res.status(500).json({ error: 'Failed to save form draft.' });
  }
});

app.patch('/api/form-drafts/status', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const moduleName = String(req.body.module_name || '').trim();
    const formName = String(req.body.form_name || '').trim();
    const recordId = req.body.record_id === undefined || req.body.record_id === null || req.body.record_id === ''
      ? '__new__'
      : String(req.body.record_id);
    const status = ['Submitted', 'Discarded', 'Expired'].includes(req.body.status) ? req.body.status : 'Discarded';

    if (!moduleName || !formName) {
      return res.status(400).json({ error: 'module_name and form_name are required.' });
    }

    await pool.execute(
      `UPDATE form_drafts
       SET status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND module_name = ? AND form_name = ? AND record_id = ?`,
      [status, req.user.id, moduleName, formName, recordId]
    );

    res.json({ message: 'Draft status updated.' });
  } catch (err) {
    console.error('Form draft status error:', err.message);
    res.status(500).json({ error: 'Failed to update form draft.' });
  }
});

// Payroll Routes (wages, transactions, payroll generation)
app.use('/api/payroll', payrollRoutes);
app.use('/api/dashboard', dashboardRoutes);

// 201-File Management (Auth required, role-based per endpoint)
app.use('/api/201-files', requireAuth, fileManagementRoutes);

// Attendance Module (QR, Geofence, Device Binding, Audit)
app.use('/api/attendance', attendanceRoutes);

// Onboarding Module (pre-employment lifecycle, secure document vault, transfer)
app.use('/api/onboarding', onboardingRoutes);

// Admin RBAC Module — Account Registration & Role Management (Level 4 only)
app.use('/api/admin', adminRbacRoutes);

// Employee Actor Module — Employee-only dashboard, 201-file, payslips
app.use('/api/employee', employeeDashboardRoutes);

function normalizeAddressPayload(body) {
  const sameCurrent = boolValue(body.current_address_same_as_home);
  const sameMailing = boolValue(body.mailing_address_same_as_home);
  const home = {
    address: String(body.residential_address || '').trim(),
    lat: body.residential_address_lat,
    lng: body.residential_address_lng
  };
  const current = sameCurrent
    ? { ...home }
    : { address: String(body.current_address || '').trim(), lat: body.current_address_lat, lng: body.current_address_lng };
  const mailing = sameMailing
    ? { ...home }
    : { address: String(body.mailing_address || '').trim(), lat: body.mailing_address_lat, lng: body.mailing_address_lng };

  return { home, current, mailing, sameCurrent, sameMailing };
}

function hasCoordinates(address) {
  return address.lat !== undefined && address.lat !== null && address.lat !== ''
    && address.lng !== undefined && address.lng !== null && address.lng !== ''
    && Number.isFinite(Number(address.lat)) && Number.isFinite(Number(address.lng));
}

function validateEmployeeAddresses(body) {
  const addresses = normalizeAddressPayload(body);
  const errors = [];

  if (!addresses.home.address) errors.push('Home Address is required.');
  if (!addresses.sameCurrent && !addresses.current.address) errors.push('Current Address is required unless Same as Home Address is checked.');
  if (!addresses.sameMailing && !addresses.mailing.address) errors.push('Mailing Address is required unless Same as Home Address is checked.');
  if (addresses.home.address && !hasCoordinates(addresses.home)) errors.push('Home Address must be selected from address suggestions.');
  if (addresses.current.address && !hasCoordinates(addresses.current)) errors.push('Current Address must be selected from address suggestions.');
  if (addresses.mailing.address && !hasCoordinates(addresses.mailing)) errors.push('Mailing Address must be selected from address suggestions.');

  return { errors, addresses };
}

function lifecycleTruthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on' || value === 'yes';
}

function normalizeHiringType(value) {
  return String(value || '').trim() === 'Agency-Hired' ? 'Agency-Hired' : 'Direct Hire';
}

function normalizeEmployeeEmploymentType(value, hiringType) {
  if (hiringType === 'Agency-Hired') return 'Contractual';
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized.includes('part')) return 'Part-time';
  if (normalized.includes('contract')) return 'Contractual';
  return 'Full-time';
}

function optionalLifecycleDate(value, field) {
  if (value == null || value === '') return null;
  const date = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${field} must use YYYY-MM-DD format.`);
  return date;
}

function normalizeLifecycleAction(value) {
  const action = String(value || 'AUTO').trim().toUpperCase();
  const allowed = new Set(['AUTO', 'DIRECT_ACTIVE', 'SCREENING_REQUIRED', 'TRAINING_REQUIRED', 'ON_HOLD']);
  return allowed.has(action) ? action : 'AUTO';
}

function lifecycleNote(value) {
  return String(value || '').trim().replace(/[\x00<>]/g, '').slice(0, 500);
}

function employeeCodeNumber(code) {
  const match = String(code || '').trim().match(/^EMP0*(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

function formatEmployeeCode(number) {
  return `EMP${String(Number(number || 0)).padStart(5, '0')}`;
}

function personLabel(row) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return name ? `${name} (${row.employee_code || row.applicant_code || 'no code'})` : (row.employee_code || row.applicant_code || 'existing record');
}

async function generateNextEmployeeCode(executor) {
  const [rows] = await executor.execute(
    `SELECT employee_code AS code FROM employees WHERE employee_code LIKE 'EMP%'
     UNION ALL
     SELECT intended_employee_code AS code
       FROM onboarding_applicant
      WHERE deleted_at IS NULL
        AND intended_employee_code IS NOT NULL
        AND intended_employee_code LIKE 'EMP%'`
  );
  const maxCode = rows.reduce((max, row) => Math.max(max, employeeCodeNumber(row.code)), 0);
  return formatEmployeeCode(maxCode + 1);
}

async function findEmployeeIntakeDuplicate(executor, employeeCode, email) {
  const [employeeCodeRows] = await executor.execute(
    `SELECT id, employee_code, email, first_name, last_name
       FROM employees
      WHERE employee_code = ?
      LIMIT 1`,
    [employeeCode]
  );
  if (employeeCodeRows.length) {
    return {
      source: 'Employee Directory',
      field: 'employee_code',
      message: `Employee code ${employeeCode} already exists in the Employee Directory for ${personLabel(employeeCodeRows[0])}.`,
      record: employeeCodeRows[0],
    };
  }

  const [employeeEmailRows] = await executor.execute(
    `SELECT id, employee_code, email, first_name, last_name
       FROM employees
      WHERE LOWER(email) = LOWER(?)
      LIMIT 1`,
    [email]
  );
  if (employeeEmailRows.length) {
    return {
      source: 'Employee Directory',
      field: 'email',
      message: `Email ${email} is already used in the Employee Directory by ${personLabel(employeeEmailRows[0])}. Use a different email, or edit the existing employee record instead.`,
      record: employeeEmailRows[0],
    };
  }

  const [onboardingCodeRows] = await executor.execute(
    `SELECT applicant_id, applicant_code, intended_employee_code, first_name, last_name, workflow_status
       FROM onboarding_applicant
      WHERE deleted_at IS NULL
        AND intended_employee_code = ?
      LIMIT 1`,
    [employeeCode]
  );
  if (onboardingCodeRows.length) {
    return {
      source: 'Onboarding',
      field: 'employee_code',
      message: `Employee code ${employeeCode} is already reserved by onboarding record ${personLabel(onboardingCodeRows[0])}.`,
      record: onboardingCodeRows[0],
    };
  }

  const [onboardingEmailRows] = await executor.execute(
    `SELECT applicant_id, applicant_code, intended_employee_code AS employee_code, first_name, last_name, workflow_status
       FROM onboarding_applicant
      WHERE deleted_at IS NULL
        AND email_hash = SHA2(LOWER(?), 256)
      LIMIT 1`,
    [email]
  );
  if (onboardingEmailRows.length) {
    return {
      source: 'Onboarding',
      field: 'email',
      message: `Email ${email} is already active in onboarding as ${personLabel(onboardingEmailRows[0])}. Continue that onboarding record instead of creating a duplicate.`,
      record: onboardingEmailRows[0],
    };
  }

  return null;
}

async function employeeIntakeDuplicatePayload(executor, duplicate) {
  const payload = {
    error: duplicate.message,
    duplicate: {
      source: duplicate.source,
      field: duplicate.field,
      record_code: duplicate.record.employee_code || duplicate.record.intended_employee_code || duplicate.record.applicant_code || null,
      record_id: duplicate.record.id || duplicate.record.applicant_id || null,
      workflow_status: duplicate.record.workflow_status || null,
    },
  };
  if (duplicate.field === 'employee_code') {
    payload.next_employee_code = await generateNextEmployeeCode(executor);
  }
  return payload;
}

async function writeEmployeeLifecycleAudit(executor, req, action, targetEmployeeId, oldValue = null, newValue = null) {
  await executor.execute(
    `INSERT INTO system_audit_log
       (user_id, employee_id, target_employee_id, action_performed, module,
        old_value, new_value, ip_address, user_agent)
     VALUES (?, ?, ?, ?, 'EMPLOYEE_LIFECYCLE', ?, ?, ?, ?)`,
    [
      req.user.id,
      req.user.employeeId || null,
      targetEmployeeId || null,
      action,
      oldValue == null ? null : JSON.stringify(oldValue),
      newValue == null ? null : JSON.stringify(newValue),
      String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 45),
      String(req.headers['user-agent'] || 'unknown').slice(0, 500),
    ]
  );
}

function localPhilippineAddressSuggestions(query) {
  const value = String(query || '').trim();
  const needle = value.toLowerCase();
  const places = [
    ['Marulas, Valenzuela City, Metro Manila, Philippines', 14.6842, 120.9744, ['marulas', 'valenzuela']],
    ['Valenzuela City, Metro Manila, Philippines', 14.7011, 120.9830, ['valenzuela']],
    ['Meycauayan City, Bulacan, Philippines', 14.7369, 120.9603, ['meycauayan', 'bulacan']],
    ['Caloocan City, Metro Manila, Philippines', 14.6507, 120.9676, ['caloocan']],
    ['Malabon City, Metro Manila, Philippines', 14.6680, 120.9563, ['malabon']],
    ['Navotas City, Metro Manila, Philippines', 14.6667, 120.9417, ['navotas']],
    ['Quezon City, Metro Manila, Philippines', 14.6760, 121.0437, ['quezon city', 'qc']],
    ['Manila, Metro Manila, Philippines', 14.5995, 120.9842, ['manila']],
    ['Pasig City, Metro Manila, Philippines', 14.5764, 121.0851, ['pasig']],
    ['Makati City, Metro Manila, Philippines', 14.5547, 121.0244, ['makati']],
    ['Taguig City, Metro Manila, Philippines', 14.5176, 121.0509, ['taguig']],
    ['Pasay City, Metro Manila, Philippines', 14.5378, 121.0014, ['pasay']],
    ['Paranaque City, Metro Manila, Philippines', 14.4793, 121.0198, ['paranaque', 'parañaque']],
    ['Las Pinas City, Metro Manila, Philippines', 14.4445, 120.9939, ['las pinas', 'las piñas']],
    ['Muntinlupa City, Metro Manila, Philippines', 14.4081, 121.0415, ['muntinlupa']],
    ['San Jose del Monte, Bulacan, Philippines', 14.8139, 121.0453, ['san jose del monte', 'sjdm']],
    ['Malolos City, Bulacan, Philippines', 14.8527, 120.8160, ['malolos']],
    ['Santa Maria, Bulacan, Philippines', 14.8188, 120.9563, ['santa maria', 'sta maria']],
    ['Philippines', 12.8797, 121.7740, ['philippines']]
  ];

  const matches = places
    .filter(([label, , , terms]) => label.toLowerCase().includes(needle) || terms.some(term => needle.includes(term) || term.includes(needle)))
    .slice(0, 6)
    .map(([label, latitude, longitude], index) => ({
      full_address: value.toLowerCase().includes('philippines') ? `${value}` : `${value}, ${label}`,
      latitude,
      longitude,
      place_id: `local-${index}`,
      provider: 'local'
    }));

  if (matches.length) return matches;

  return [{
    full_address: value.toLowerCase().includes('philippines') ? value : `${value}, Philippines`,
    latitude: 12.8797,
    longitude: 121.7740,
    place_id: 'local-ph',
    provider: 'local'
  }];
}

// Employees
app.get('/api/employees/next-code', requireAuth, requireRole(ROLES.staff_management), async (_req, res) => {
  try {
    const pool = require('./config/db');
    const employeeCode = await generateNextEmployeeCode(pool);
    res.json({ employee_code: employeeCode });
  } catch (err) {
    console.error('Error generating next employee code:', err);
    res.status(500).json({ error: 'Failed to generate employee code.' });
  }
});

async function ensureEmployeeSetupSchema(pool) {
  const [departmentColumns] = await pool.execute("SHOW COLUMNS FROM departments LIKE 'is_active'");
  if (!departmentColumns.length) {
    await pool.execute('ALTER TABLE departments ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1');
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS positions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      department_id INT NOT NULL,
      name VARCHAR(120) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_positions_department_name (department_id, name),
      CONSTRAINT fk_positions_department
        FOREIGN KEY (department_id) REFERENCES departments(id)
        ON DELETE CASCADE
    )
  `);
}

app.get('/api/employee-setup/lookups', requireAuth, requireRole(ROLES.any), async (_req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeSetupSchema(pool);
    const [departments] = await pool.execute('SELECT id, name, is_active FROM departments WHERE is_active = 1 ORDER BY name');
    const [positions] = await pool.execute(`
      SELECT p.id, p.department_id, p.name, p.is_active, d.name AS department
        FROM positions p
        JOIN departments d ON d.id = p.department_id
       WHERE p.is_active = 1 AND d.is_active = 1
       ORDER BY d.name, p.name
    `);
    res.json({ departments, positions });
  } catch (err) {
    console.error('Error loading employee setup lookups:', err);
    res.status(500).json({ error: 'Failed to load departments and positions.' });
  }
});

app.post('/api/employee-setup/departments', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Department name is required.' });
    if (name.length > 100) return res.status(400).json({ error: 'Department name is too long.' });

    await ensureEmployeeSetupSchema(pool);
    await pool.execute(
      `INSERT INTO departments (name, is_active)
       VALUES (?, 1)
       ON DUPLICATE KEY UPDATE is_active = 1`,
      [name]
    );
    const [[department]] = await pool.execute('SELECT id, name, is_active FROM departments WHERE name = ? LIMIT 1', [name]);
    res.json({ department, message: 'Department saved.' });
  } catch (err) {
    console.error('Error saving department:', err);
    res.status(500).json({ error: 'Failed to save department.' });
  }
});

app.put('/api/employee-setup/departments/:id', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeSetupSchema(pool);
    const id = Number(req.params.id);
    const name = String(req.body.name || '').trim();
    if (!id) return res.status(400).json({ error: 'Department is required.' });
    if (!name) return res.status(400).json({ error: 'Department name is required.' });
    if (name.length > 100) return res.status(400).json({ error: 'Department name is too long.' });

    await pool.execute('UPDATE departments SET name = ?, is_active = 1 WHERE id = ?', [name, id]);
    const [[department]] = await pool.execute('SELECT id, name, is_active FROM departments WHERE id = ? LIMIT 1', [id]);
    res.json({ department, message: 'Department updated.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Department name already exists.' });
    console.error('Error updating department:', err);
    res.status(500).json({ error: 'Failed to update department.' });
  }
});

app.delete('/api/employee-setup/departments/:id', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeSetupSchema(pool);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Department is required.' });

    await pool.execute('UPDATE departments SET is_active = 0 WHERE id = ?', [id]);
    await pool.execute('UPDATE positions SET is_active = 0 WHERE department_id = ?', [id]);
    res.json({ message: 'Department removed from active dropdowns.' });
  } catch (err) {
    console.error('Error deactivating department:', err);
    res.status(500).json({ error: 'Failed to remove department.' });
  }
});

app.post('/api/employee-setup/positions', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeSetupSchema(pool);
    const departmentId = Number(req.body.department_id);
    const name = String(req.body.name || '').trim();
    if (!departmentId) return res.status(400).json({ error: 'Department is required.' });
    if (!name) return res.status(400).json({ error: 'Position / job title is required.' });
    if (name.length > 120) return res.status(400).json({ error: 'Position / job title is too long.' });

    const [[department]] = await pool.execute('SELECT id FROM departments WHERE id = ? LIMIT 1', [departmentId]);
    if (!department) return res.status(404).json({ error: 'Department not found.' });

    await pool.execute(
      `INSERT INTO positions (department_id, name, is_active)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE is_active = 1, updated_at = NOW()`,
      [departmentId, name]
    );
    const [[position]] = await pool.execute(
      `SELECT p.id, p.department_id, p.name, p.is_active, d.name AS department
         FROM positions p
         JOIN departments d ON d.id = p.department_id
        WHERE p.department_id = ? AND p.name = ?
        LIMIT 1`,
      [departmentId, name]
    );
    res.json({ position, message: 'Position saved.' });
  } catch (err) {
    console.error('Error saving position:', err);
    res.status(500).json({ error: 'Failed to save position.' });
  }
});

app.put('/api/employee-setup/positions/:id', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeSetupSchema(pool);
    const id = Number(req.params.id);
    const departmentId = Number(req.body.department_id);
    const name = String(req.body.name || '').trim();
    if (!id) return res.status(400).json({ error: 'Position is required.' });
    if (!departmentId) return res.status(400).json({ error: 'Department is required.' });
    if (!name) return res.status(400).json({ error: 'Position / job title is required.' });
    if (name.length > 120) return res.status(400).json({ error: 'Position / job title is too long.' });

    await pool.execute(
      'UPDATE positions SET department_id = ?, name = ?, is_active = 1 WHERE id = ?',
      [departmentId, name, id]
    );
    const [[position]] = await pool.execute(
      `SELECT p.id, p.department_id, p.name, p.is_active, d.name AS department
         FROM positions p
         JOIN departments d ON d.id = p.department_id
        WHERE p.id = ?
        LIMIT 1`,
      [id]
    );
    res.json({ position, message: 'Position updated.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Position already exists in this department.' });
    console.error('Error updating position:', err);
    res.status(500).json({ error: 'Failed to update position.' });
  }
});

app.delete('/api/employee-setup/positions/:id', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeSetupSchema(pool);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Position is required.' });

    await pool.execute('UPDATE positions SET is_active = 0 WHERE id = ?', [id]);
    res.json({ message: 'Position removed from active dropdowns.' });
  } catch (err) {
    console.error('Error deactivating position:', err);
    res.status(500).json({ error: 'Failed to remove position.' });
  }
});

app.get('/api/employees', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const [rows] = await pool.execute(
      `SELECT e.id, e.employee_code, e.first_name, e.middle_name, e.last_name, e.suffix, e.email, e.contact_number, 
              e.work_email, e.mailing_address, e.mailing_address_lat, e.mailing_address_lng, e.mailing_address_same_as_home,
              e.nationality, e.date_of_birth, e.place_of_birth, e.gender, e.marital_status, e.blood_type, e.religion,
              e.residential_address, e.residential_address_lat, e.residential_address_lng,
              e.current_address, e.current_address_lat, e.current_address_lng, e.current_address_same_as_home,
              e.emergency_contact_name, e.emergency_contact_num,
              e.emergency_contact_relationship, e.emergency_contact_secondary_num, e.emergency_contact_email, e.emergency_contact_address,
              e.education_school, e.education_attainment, e.education_units, e.education_year_graduated,
              e.education_jhs_school, e.education_jhs_attainment, e.education_jhs_from, e.education_jhs_to, e.education_jhs_year_graduated,
              e.education_shs_school, e.education_shs_attainment, e.education_shs_from, e.education_shs_to, e.education_shs_year_graduated,
              e.education_vocational_school, e.education_vocational_attainment, e.education_vocational_units, e.education_vocational_from, e.education_vocational_to, e.education_vocational_year_graduated,
              e.education_college_school, e.education_college_attainment, e.education_college_units, e.education_college_from, e.education_college_to, e.education_college_year_graduated,
              e.department_id, e.position, e.employment_type, e.date_hired, e.end_of_contract, e.supervisor, e.work_location,
              e.shift_schedule, e.employee_level, e.employment_history, e.status, e.wage_type_id,
              e.salary_grade, e.allowances, e.payroll_schedule,
              e.sss_number, e.philhealth_number, e.pagibig_number, e.tin, e.tax_status, e.bank_name, e.bank_account,
              e.hiring_type, e.agency_name, e.agency_contact_person, e.agency_contact_number,
              e.deployment_status, e.contract_start_date, e.contract_end_date, e.lifecycle_status,
              d.name AS department, wt.name AS wage_type,
              (
                SELECT ewr.rate
                FROM employee_wage_rates ewr
                WHERE ewr.employee_id = e.id
                ORDER BY ewr.effective_date DESC, ewr.id DESC
                LIMIT 1
              ) AS basic_salary
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
       ORDER BY e.first_name`
    );
    
    console.log('\n=== GET /api/employees ===');
    console.log('Total employees returned:', rows.length);
    if (rows.length > 0) {
      console.log('Sample employee data:', {
        employee_code: rows[0].employee_code,
        name: rows[0].first_name + ' ' + rows[0].last_name,
        employment_type: rows[0].employment_type,
        date_hired: rows[0].date_hired,
        department: rows[0].department,
        position: rows[0].position,
        wage_type: rows[0].wage_type
      });
    }
    
    if (req.user.role === 'employee') return res.json(rows.filter(r => r.id === req.user.employeeId));
    res.json(rows);
  } catch (err) {
    console.error('Error fetching employees:', err);
    res.status(500).json({ error: 'Failed to fetch employees.' }); 
  }
});

// Add new employee
app.post('/api/employees', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json');
    
    const pool = require('./config/db');
    const { employee_code, first_name, middle_name, last_name, suffix, email, contact_number, work_email, mailing_address, nationality, marital_status, date_of_birth, place_of_birth, gender, blood_type, religion, residential_address, current_address, emergency_contact_name, emergency_contact_num, emergency_contact_relationship, emergency_contact_secondary_num, emergency_contact_email, emergency_contact_address, education_school, education_attainment, education_units, education_year_graduated, education_jhs_school, education_jhs_attainment, education_jhs_from, education_jhs_to, education_jhs_year_graduated, education_shs_school, education_shs_attainment, education_shs_from, education_shs_to, education_shs_year_graduated, education_vocational_school, education_vocational_attainment, education_vocational_units, education_vocational_from, education_vocational_to, education_vocational_year_graduated, education_college_school, education_college_attainment, education_college_units, education_college_from, education_college_to, education_college_year_graduated, department_id, position, employment_type, date_hired, end_of_contract, supervisor, work_location, shift_schedule, employee_level, employment_history, status, wage_type, base_rate, sewingRates, salary_grade, allowances, payroll_schedule, sss_number, philhealth_number, pagibig_number, tin, tax_status, bank_name, bank_account, hiring_type, agency_name, agency_contact_person, agency_contact_number, deployment_status, contract_start_date, contract_end_date, requires_onboarding, requires_training, lifecycle_action, lifecycle_note } = req.body;
    
    console.log('\n=== POST /api/employees ===');
    console.log('User role:', req.user.role);
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    console.log('Payroll data received:', { wage_type, base_rate, sewingRates });
    
    if (!first_name || !last_name || !email) {
      console.error('❌ Missing required fields');
      return res.status(400).json({ error: 'First name, last name, and email are required.' });
    }
    
    if (!employee_code) {
      console.error('❌ Missing employee_code');
      return res.status(400).json({ error: 'Employee code is required.' });
    }

    const { errors: addressErrors, addresses } = validateEmployeeAddresses(req.body);
    if (addressErrors.length) {
      return res.status(400).json({ error: addressErrors.join(' ') });
    }

    if (!position) {
      return res.status(400).json({ error: 'Position / Job Title is required for lifecycle routing.' });
    }

    const normalizedHiringType = normalizeHiringType(hiring_type);
    const normalizedEmploymentType = normalizeEmployeeEmploymentType(employment_type, normalizedHiringType);
    let normalizedContractStartDate = null;
    let normalizedContractEndDate = null;
    try {
      normalizedContractStartDate = normalizedHiringType === 'Agency-Hired'
        ? optionalLifecycleDate(contract_start_date, 'Contract start date')
        : null;
      normalizedContractEndDate = normalizedHiringType === 'Agency-Hired'
        ? optionalLifecycleDate(contract_end_date || end_of_contract, 'Contract end date')
        : null;
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const normalizedDeploymentStatus = normalizedHiringType === 'Agency-Hired'
      ? (['Pending Deployment', 'Deployed', 'On Hold', 'Ended'].includes(deployment_status) ? deployment_status : 'Pending Deployment')
      : null;
    if (normalizedHiringType === 'Agency-Hired') {
      if (!agency_name || !agency_contact_person || !agency_contact_number) {
        return res.status(400).json({ error: 'Agency name, contact person, and contact number are required for Agency-Hired workers.' });
      }
      if (normalizedContractStartDate && normalizedContractEndDate && normalizedContractEndDate < normalizedContractStartDate) {
        return res.status(400).json({ error: 'Contract end date cannot be earlier than contract start date.' });
      }
    }
    const directoryEndOfContract = normalizedContractEndDate || end_of_contract || null;
    const route = await onboardingRoutes.getPositionRoute(pool, position);
    const normalizedLifecycleAction = normalizeLifecycleAction(lifecycle_action);
    const normalizedLifecycleNote = lifecycleNote(lifecycle_note);
    if (normalizedLifecycleAction === 'ON_HOLD' && normalizedLifecycleNote.length < 8) {
      return res.status(400).json({ error: 'An HR note of at least 8 characters is required when placing a record on hold.' });
    }
    const explicitOnboardingAction = ['SCREENING_REQUIRED', 'TRAINING_REQUIRED', 'ON_HOLD'].includes(normalizedLifecycleAction);
    const explicitDirectAction = normalizedLifecycleAction === 'DIRECT_ACTIVE';
    const shouldRouteToOnboarding = !explicitDirectAction
      && (explicitOnboardingAction || lifecycleTruthy(requires_onboarding) || Number(route.requires_onboarding) === 1);
    const onboardingRequiresTraining = normalizedLifecycleAction === 'TRAINING_REQUIRED'
      || (!explicitDirectAction
        && normalizedLifecycleAction === 'AUTO'
        && (lifecycleTruthy(requires_training) || Number(route.requires_training) === 1));

    if (shouldRouteToOnboarding) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const duplicate = await findEmployeeIntakeDuplicate(connection, employee_code, email);
        if (duplicate) {
          await connection.rollback();
          return res.status(409).json(await employeeIntakeDuplicatePayload(connection, duplicate));
        }

        const onboardingResult = await onboardingRoutes.createOnboardingApplicantRecord(connection, req, {
          ...req.body,
          employee_code,
          hiring_type: normalizedHiringType,
          employment_type: normalizedEmploymentType,
          applied_position: position,
          branch: work_location || 'Marulas Industrial Corporation',
          expected_wage_type_id: req.body.wage_type_id,
          expected_base_rate: base_rate,
          civil_status: marital_status,
          agency_name,
          agency_contact_person,
          agency_contact_number,
          deployment_status: normalizedDeploymentStatus,
          contract_start_date: normalizedContractStartDate,
          contract_end_date: normalizedContractEndDate,
          current_address_same_as_home: addresses.sameCurrent ? 1 : 0,
          mailing_address_same_as_home: addresses.sameMailing ? 1 : 0,
          residential_address: addresses.home.address,
          residential_address_lat: addresses.home.lat,
          residential_address_lng: addresses.home.lng,
          current_address: addresses.current.address,
          current_address_lat: addresses.current.lat,
          current_address_lng: addresses.current.lng,
          mailing_address: addresses.mailing.address,
          mailing_address_lat: addresses.mailing.lat,
          mailing_address_lng: addresses.mailing.lng,
          requires_onboarding: true,
          requires_training: onboardingRequiresTraining,
          initial_workflow_status: normalizedLifecycleAction === 'ON_HOLD' ? 'On Hold' : undefined,
          lifecycle_action: normalizedLifecycleAction,
          lifecycle_note: normalizedLifecycleNote,
        }, {
          sourceModule: 'EMPLOYEE_MANAGEMENT',
          intendedEmployeeCode: employee_code,
        });
        await writeEmployeeLifecycleAudit(connection, req, `EMPLOYEE_RECORD_ROUTED_TO_ONBOARDING [${employee_code}]`, null, null, {
          employee_code,
          applicant_id: onboardingResult.applicant_id,
          position,
          lifecycle_action: normalizedLifecycleAction,
          lifecycle_note: normalizedLifecycleNote || null,
          requires_training: onboardingRequiresTraining,
          route_source: route.source || 'position_route',
          workflow_status: onboardingResult.workflow_status,
        });
        await connection.commit();
        return res.status(201).json({
          ...onboardingResult,
          id: null,
          employee_code,
          routed_to: 'onboarding',
          message: normalizedLifecycleAction === 'ON_HOLD'
            ? `${employee_code} placed on hold in onboarding for HR review.`
            : `${employee_code} routed to onboarding for ${position}.`,
        });
      } catch (error) {
        await connection.rollback();
        return res.status(400).json({ error: error.message });
      } finally {
        connection.release();
      }
    }

    const duplicate = await findEmployeeIntakeDuplicate(pool, employee_code, email);
    if (duplicate) {
      return res.status(409).json(await employeeIntakeDuplicatePayload(pool, duplicate));
    }

    console.log('Executing INSERT for:', { employee_code, first_name, last_name, email });
    
    const [result] = await pool.execute(
      `INSERT INTO employees (employee_code, first_name, middle_name, last_name, suffix, email, contact_number, work_email, mailing_address, nationality, marital_status, date_of_birth, place_of_birth, gender, blood_type, religion, residential_address, current_address, emergency_contact_name, emergency_contact_num, emergency_contact_relationship, emergency_contact_secondary_num, emergency_contact_email, emergency_contact_address, education_school, education_attainment, education_units, education_year_graduated, education_jhs_school, education_jhs_attainment, education_jhs_from, education_jhs_to, education_jhs_year_graduated, education_shs_school, education_shs_attainment, education_shs_from, education_shs_to, education_shs_year_graduated, education_vocational_school, education_vocational_attainment, education_vocational_units, education_vocational_from, education_vocational_to, education_vocational_year_graduated, education_college_school, education_college_attainment, education_college_units, education_college_from, education_college_to, education_college_year_graduated, department_id, position, employment_type, date_hired, end_of_contract, supervisor, work_location, shift_schedule, employee_level, employment_history, status, salary_grade, allowances, payroll_schedule, sss_number, philhealth_number, pagibig_number, tin, tax_status, bank_name, bank_account)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [employee_code, first_name, middle_name || null, last_name, suffix || null, email, contact_number || null, work_email || null, addresses.mailing.address || null, nationality || 'Filipino', marital_status || null, date_of_birth || null, place_of_birth || null, gender || null, blood_type || null, religion || null, addresses.home.address || null, addresses.current.address || null, emergency_contact_name || null, emergency_contact_num || null, emergency_contact_relationship || null, emergency_contact_secondary_num || null, emergency_contact_email || null, emergency_contact_address || null, education_school || null, education_attainment || null, education_units || null, education_year_graduated || null, education_jhs_school || null, education_jhs_attainment || null, education_jhs_from || null, education_jhs_to || null, education_jhs_year_graduated || null, education_shs_school || null, education_shs_attainment || null, education_shs_from || null, education_shs_to || null, education_shs_year_graduated || null, education_vocational_school || null, education_vocational_attainment || null, education_vocational_units || null, education_vocational_from || null, education_vocational_to || null, education_vocational_year_graduated || null, education_college_school || null, education_college_attainment || null, education_college_units || null, education_college_from || null, education_college_to || null, education_college_year_graduated || null, department_id || null, position || null, normalizedEmploymentType, date_hired || null, directoryEndOfContract, supervisor || null, work_location || null, shift_schedule || null, employee_level || null, employment_history || null, status || 'Active', salary_grade || null, allowances || null, payroll_schedule || null, sss_number || null, philhealth_number || null, pagibig_number || null, tin || null, tax_status || null, bank_name || null, bank_account || null]
    );
    
    const employee_id = result.insertId;
    await pool.execute(
      `UPDATE employees SET
         residential_address_lat = ?, residential_address_lng = ?,
         current_address_lat = ?, current_address_lng = ?, current_address_same_as_home = ?,
         mailing_address_lat = ?, mailing_address_lng = ?, mailing_address_same_as_home = ?
       WHERE id = ?`,
      [
        addresses.home.lat, addresses.home.lng,
        addresses.current.lat, addresses.current.lng, addresses.sameCurrent ? 1 : 0,
        addresses.mailing.lat, addresses.mailing.lng, addresses.sameMailing ? 1 : 0,
        employee_id
      ]
    );

    await pool.execute(
      `UPDATE employees SET
         encrypted_pii = ?, hiring_type = ?, agency_name = ?,
         agency_contact_person = ?, agency_contact_number = ?,
         deployment_status = ?, contract_start_date = ?, contract_end_date = ?,
         lifecycle_status = 'Active'
       WHERE id = ?`,
      [
        encryptPII({
          contact_number: contact_number || '',
          work_email: work_email || '',
          residential_address: addresses.home.address || '',
          residential_address_lat: addresses.home.lat == null ? '' : String(addresses.home.lat),
          residential_address_lng: addresses.home.lng == null ? '' : String(addresses.home.lng),
          current_address: addresses.current.address || '',
          current_address_lat: addresses.current.lat == null ? '' : String(addresses.current.lat),
          current_address_lng: addresses.current.lng == null ? '' : String(addresses.current.lng),
          current_address_same_as_home: !!addresses.sameCurrent,
          mailing_address: addresses.mailing.address || '',
          mailing_address_lat: addresses.mailing.lat == null ? '' : String(addresses.mailing.lat),
          mailing_address_lng: addresses.mailing.lng == null ? '' : String(addresses.mailing.lng),
          mailing_address_same_as_home: !!addresses.sameMailing,
          nationality: nationality || 'Filipino',
          date_of_birth: date_of_birth || '',
          place_of_birth: place_of_birth || '',
          gender: gender || '',
          civil_status: marital_status || '',
          blood_type: blood_type || '',
          religion: religion || '',
          emergency_contact_name: emergency_contact_name || '',
          emergency_contact_relationship: emergency_contact_relationship || '',
          emergency_contact_number: emergency_contact_num || '',
          emergency_contact_secondary_number: emergency_contact_secondary_num || '',
          emergency_contact_email: emergency_contact_email || '',
          emergency_contact_address: emergency_contact_address || '',
          sss_number: sss_number || '',
          philhealth_number: philhealth_number || '',
          pagibig_number: pagibig_number || '',
          tin: tin || '',
          tax_status: tax_status || '',
          bank_name: bank_name || '',
          bank_account: bank_account || '',
          hiring_type: normalizedHiringType,
          agency_name: normalizedHiringType === 'Agency-Hired' ? agency_name || '' : '',
          agency_contact_person: normalizedHiringType === 'Agency-Hired' ? agency_contact_person || '' : '',
          agency_contact_number: normalizedHiringType === 'Agency-Hired' ? agency_contact_number || '' : '',
          deployment_status: normalizedDeploymentStatus || '',
          contract_start_date: normalizedContractStartDate || '',
          contract_end_date: normalizedContractEndDate || '',
        }),
        normalizedHiringType,
        normalizedHiringType === 'Agency-Hired' ? agency_name || null : null,
        normalizedHiringType === 'Agency-Hired' ? agency_contact_person || null : null,
        normalizedHiringType === 'Agency-Hired' ? agency_contact_number || null : null,
        normalizedDeploymentStatus,
        normalizedContractStartDate,
        normalizedContractEndDate,
        employee_id
      ]
    );
    await writeEmployeeLifecycleAudit(pool, req, `EMPLOYEE_RECORD_CREATED_DIRECT [${employee_code}]`, employee_id, null, {
      employee_code,
      position,
      route_source: route.source || 'position_route',
      lifecycle_action: normalizedLifecycleAction,
      lifecycle_note: normalizedLifecycleNote || null,
      hiring_type: normalizedHiringType,
      lifecycle_status: 'Active',
    });
    console.log('✅ Employee inserted successfully!');
    console.log('Insert result:', { insertId: employee_id, affectedRows: result.affectedRows });
    console.log('Employee Code:', employee_code);
    
    // Save wage configuration if provided
    if (wage_type) {
      try {
        console.log('💾 Saving wage configuration for new employee...');
        
        // Get wage_type_id from wage type name
        const [wageTypeRows] = await pool.execute(
          'SELECT id FROM wage_types WHERE name = ?',
          [wage_type]
        );
        
        if (wageTypeRows.length > 0) {
          const wage_type_id = wageTypeRows[0].id;
          
          // Update employee wage_type_id
          await pool.execute(
            'UPDATE employees SET wage_type_id = ? WHERE id = ?',
            [wage_type_id, employee_id]
          );
          
          console.log('✅ Updated employee wage_type_id to:', wage_type_id);
          
          // Save base rate for all wage types (or per-piece primary rate)
          if (base_rate !== undefined && base_rate !== null && base_rate !== '') {
            // Insert new base rate with wage_type_id
            await pool.execute(
              'INSERT INTO employee_wage_rates (employee_id, wage_type_id, rate, effective_date) VALUES (?, ?, ?, NOW())',
              [employee_id, wage_type_id, parseFloat(base_rate)]
            );
            
            console.log('✅ Saved base rate:', base_rate, 'for wage_type_id:', wage_type_id);
          }
          
          // Save sewing type specific rates if provided
          if (sewingRates && Array.isArray(sewingRates) && sewingRates.length > 0) {
            for (const sewingRate of sewingRates) {
              if (sewingRate.sewing_id && sewingRate.rate) {
                try {
                  await pool.execute(
                    `INSERT INTO employee_wage_rates 
                     (employee_id, wage_type_id, sewing_type_id, rate, effective_date) 
                     VALUES (?, ?, ?, ?, NOW())`,
                    [employee_id, wage_type_id, sewingRate.sewing_id, parseFloat(sewingRate.rate)]
                  );
                  console.log(`✅ Saved sewing rate for type ${sewingRate.sewing_id}: ${sewingRate.rate}`);
                } catch (err) {
                  console.warn('⚠️ Error saving sewing rate:', err.message);
                }
              }
            }
          }
        } else {
          console.warn('⚠️ Wage type not found:', wage_type);
        }
      } catch (err) {
        console.warn('⚠️ Error saving wage configuration:', err.message);
        // Don't fail the whole request if wage save fails, but return both success and warning
      }
    }
    
    return res.status(201).json({ 
      id: employee_id, 
      employee_code: employee_code, 
      message: 'Employee added successfully with payroll configuration.' 
    });
  } catch (err) { 
    console.error('❌ ERROR adding employee:');
    console.error('Message:', err.message);
    console.error('SQL Error:', err.sqlMessage);
    console.error('SQL State:', err.sqlState);
    console.error('Full error:', err);
    res.setHeader('Content-Type', 'application/json');
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        error: 'Employee code or email was just used by another record. Please refresh the Employee ID and check the email address.',
        next_employee_code: await generateNextEmployeeCode(require('./config/db')),
      });
    }
    return res.status(500).json({ error: 'Failed to add employee: ' + err.message }); 
  }
});

// Update Employee
app.put('/api/employees/:id', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json');
    
    const pool = require('./config/db');
    const { id } = req.params; // numeric employee id
    const { first_name, middle_name, last_name, suffix, email, contact_number, work_email, mailing_address, nationality, marital_status, date_of_birth, place_of_birth, gender, blood_type, religion, residential_address, current_address, emergency_contact_name, emergency_contact_num, emergency_contact_relationship, emergency_contact_secondary_num, emergency_contact_email, emergency_contact_address, education_school, education_attainment, education_units, education_year_graduated, education_jhs_school, education_jhs_attainment, education_jhs_from, education_jhs_to, education_jhs_year_graduated, education_shs_school, education_shs_attainment, education_shs_from, education_shs_to, education_shs_year_graduated, education_vocational_school, education_vocational_attainment, education_vocational_units, education_vocational_from, education_vocational_to, education_vocational_year_graduated, education_college_school, education_college_attainment, education_college_units, education_college_from, education_college_to, education_college_year_graduated, department_id, position, employment_type, date_hired, end_of_contract, supervisor, work_location, shift_schedule, employee_level, employment_history, status, wage_type, base_rate, sewingRates, salary_grade, allowances, payroll_schedule, sss_number, philhealth_number, pagibig_number, tin, tax_status, bank_name, bank_account } = req.body;
    
    console.log('\n=== PUT /api/employees/:id ===');
    console.log('Employee ID:', id);
    console.log('Wage Type:', wage_type);
    console.log('Base Rate:', base_rate);
    console.log('Sewing Rates:', sewingRates);
    
    if (!first_name || !last_name || !email) {
      console.error('❌ Missing required fields');
      return res.status(400).json({ error: 'First name, last name, and email are required.' });
    }

    const { errors: addressErrors, addresses } = validateEmployeeAddresses(req.body);
    if (addressErrors.length) {
      return res.status(400).json({ error: addressErrors.join(' ') });
    }

    console.log('Executing UPDATE for:', { id, first_name, last_name, email, department_id, position, supervisor, work_location });

    const [result] = await pool.execute(
      `UPDATE employees SET 
        first_name=?, middle_name=?, last_name=?, suffix=?, email=?, contact_number=?, work_email=?, mailing_address=?,
        nationality=?, marital_status=?, date_of_birth=?, place_of_birth=?, gender=?, blood_type=?, religion=?, residential_address=?, current_address=?, emergency_contact_name=?,
        emergency_contact_num=?, emergency_contact_relationship=?, emergency_contact_secondary_num=?, emergency_contact_email=?, emergency_contact_address=?,
        education_school=?, education_attainment=?, education_units=?, education_year_graduated=?,
        education_jhs_school=?, education_jhs_attainment=?, education_jhs_year_graduated=?,
        education_shs_school=?, education_shs_attainment=?, education_shs_year_graduated=?,
        education_jhs_from=?, education_jhs_to=?, education_shs_from=?, education_shs_to=?,
        education_vocational_school=?, education_vocational_attainment=?, education_vocational_units=?, education_vocational_from=?, education_vocational_to=?, education_vocational_year_graduated=?,
        education_college_school=?, education_college_attainment=?, education_college_units=?, education_college_from=?, education_college_to=?, education_college_year_graduated=?,
        department_id=?, position=?, employment_type=?, date_hired=?, end_of_contract=?, supervisor=?, work_location=?, shift_schedule=?, employee_level=?, employment_history=?, status=?,
        salary_grade=?, allowances=?, payroll_schedule=?,
        sss_number=?, philhealth_number=?, pagibig_number=?, tin=?, tax_status=?, bank_name=?, bank_account=?
       WHERE id=? OR employee_code=?`,
      [first_name, middle_name || null, last_name, suffix || null, email, contact_number || null, work_email || null, addresses.mailing.address || null,
       nationality || 'Filipino', marital_status || null, date_of_birth || null, place_of_birth || null, gender || null, blood_type || null, religion || null, addresses.home.address || null, addresses.current.address || null,
       emergency_contact_name || null, emergency_contact_num || null, emergency_contact_relationship || null, emergency_contact_secondary_num || null, emergency_contact_email || null, emergency_contact_address || null,
       education_school || null, education_attainment || null, education_units || null, education_year_graduated || null,
       education_jhs_school || null, education_jhs_attainment || null, education_jhs_year_graduated || null,
       education_shs_school || null, education_shs_attainment || null, education_shs_year_graduated || null,
       education_jhs_from || null, education_jhs_to || null, education_shs_from || null, education_shs_to || null,
       education_vocational_school || null, education_vocational_attainment || null, education_vocational_units || null, education_vocational_from || null, education_vocational_to || null, education_vocational_year_graduated || null,
       education_college_school || null, education_college_attainment || null, education_college_units || null, education_college_from || null, education_college_to || null, education_college_year_graduated || null,
       department_id || null, position || null,
       employment_type || 'Regular', date_hired || null, end_of_contract || null, supervisor || null, work_location || null, shift_schedule || null, employee_level || null, employment_history || null, status || 'Active',
       salary_grade || null, allowances || null, payroll_schedule || null,
       sss_number || null, philhealth_number || null, pagibig_number || null, tin || null, tax_status || null, bank_name || null, bank_account || null, id, id]
    );
    
    console.log('✅ UPDATE executed');
    await pool.execute(
      `UPDATE employees SET
         residential_address_lat = ?, residential_address_lng = ?,
         current_address_lat = ?, current_address_lng = ?, current_address_same_as_home = ?,
         mailing_address_lat = ?, mailing_address_lng = ?, mailing_address_same_as_home = ?
       WHERE id = ? OR employee_code = ?`,
      [
        addresses.home.lat, addresses.home.lng,
        addresses.current.lat, addresses.current.lng, addresses.sameCurrent ? 1 : 0,
        addresses.mailing.lat, addresses.mailing.lng, addresses.sameMailing ? 1 : 0,
        id, id
      ]
    );

    console.log('Rows affected:', result.affectedRows);
    console.log('Change count:', result.changedRows);
    
    if (result.affectedRows === 0) {
      console.error('❌ No rows updated! Employee ID might not exist:', id);
      return res.status(404).json({ error: 'Employee not found.' });
    }

    // Save wage configuration if provided
    if (wage_type) {
      try {
        console.log('💾 Saving wage configuration...');
        
        // Get wage_type_id from wage type name
        const [wageTypeRows] = await pool.execute(
          'SELECT id FROM wage_types WHERE name = ?',
          [wage_type]
        );
        
        if (wageTypeRows.length > 0) {
          const wage_type_id = wageTypeRows[0].id;
          
          // Update employee wage_type_id
          await pool.execute(
            'UPDATE employees SET wage_type_id = ? WHERE id = ?',
            [wage_type_id, id]
          );
          
          console.log('✅ Updated employee wage_type_id to:', wage_type_id);
          
          // Save base rate for all wage types (or per-piece primary rate)
          if (base_rate !== undefined && base_rate !== null && base_rate !== '') {
            // Mark previous rates as ended
            await pool.execute(
              'UPDATE employee_wage_rates SET end_date = NOW() WHERE employee_id = ? AND end_date IS NULL',
              [id]
            );
            
            // Insert new base rate with wage_type_id
            await pool.execute(
              'INSERT INTO employee_wage_rates (employee_id, wage_type_id, rate, effective_date) VALUES (?, ?, ?, NOW())',
              [id, wage_type_id, parseFloat(base_rate)]
            );
            
            console.log('✅ Saved base rate:', base_rate, 'for wage_type_id:', wage_type_id);
          }
          
          // Save sewing type specific rates if provided
          if (sewingRates && Array.isArray(sewingRates) && sewingRates.length > 0) {
            for (const sewingRate of sewingRates) {
              if (sewingRate.sewing_id && sewingRate.rate) {
                try {
                  await pool.execute(
                    `INSERT INTO employee_wage_rates 
                     (employee_id, wage_type_id, sewing_type_id, rate, effective_date) 
                     VALUES (?, ?, ?, ?, NOW())`,
                    [id, wage_type_id, sewingRate.sewing_id, parseFloat(sewingRate.rate)]
                  );
                  console.log(`✅ Saved sewing rate for type ${sewingRate.sewing_id}: ${sewingRate.rate}`);
                } catch (err) {
                  console.warn('⚠️ Error saving sewing rate:', err.message);
                }
              }
            }
          }
        } else {
          console.warn('⚠️ Wage type not found:', wage_type);
        }
      } catch (err) {
        console.error('❌ Error saving wage configuration:', err.message);
        // Log error but continue - don't fail entire request
      }
    }
    
    console.log('✅ Employee updated successfully');
    return res.status(200).json({ message: 'Employee updated successfully.' });
  } catch (err) { 
    console.error('Error updating employee:', err.message, err.sqlMessage);
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ error: 'Failed to update employee: ' + err.message }); 
  }
});

// Update Employee Status
app.patch('/api/employees/:id/status', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json');
    const pool = require('./config/db');
    const { id } = req.params; // id = numeric employee id
    const { status } = req.body;

    if (!status || !['Active', 'Inactive'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be Active or Inactive.' });
    }

    console.log('PATCH /api/employees/:id/status - Employee ID:', id, '- New Status:', status);

    const [result] = await pool.execute(
      `UPDATE employees SET status = ? WHERE id = ?`,
      [status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    return res.status(200).json({ message: `Employee status updated to ${status}.` });
  } catch (err) {
    console.error('Error updating employee status:', err.message, err.sqlMessage);
    return res.status(500).json({ error: 'Failed to update employee status.', details: err.message });
  }
});

// Delete Employee
app.delete('/api/employees/:id', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json');
    const pool = require('./config/db');
    const { id } = req.params; // id = numeric employee id

    console.log('DELETE /api/employees/:id - Employee ID:', id);

    const [result] = await pool.execute(
      `DELETE FROM employees WHERE id = ?`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    return res.status(200).json({ message: 'Employee deleted successfully.' });
  } catch (err) {
    console.error('Error deleting employee:', err.message, err.sqlMessage);
    return res.status(500).json({ error: 'Failed to delete employee.', details: err.message });
  }
});

// Upload employee document
app.post('/api/employees/:id/documents', requireAuth, requireRole(ROLES.staff_management), uploadSingle('file'), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params; // id = employee_code
    const allowedDocTypes = new Set(['Resume', 'Government_ID', 'NBI_Clearance', 'Contract', 'Other']);
    const docType = allowedDocTypes.has(req.body.docType) ? req.body.docType : 'Other';
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided.' });
    }
    
    console.log('\n=== POST /api/employees/:id/documents ===');
    console.log('Employee Code:', id);
    console.log('Document Type:', docType);
    console.log('File:', req.file.filename);
    
    // Get employee ID from employee_code
    const [empRows] = await pool.execute('SELECT id FROM employees WHERE employee_code = ?', [id]);
    if (empRows.length === 0) {
      fs.unlinkSync(req.file.path); // Delete uploaded file
      return res.status(404).json({ error: 'Employee not found.' });
    }
    
    const employeeId = empRows[0].id;
    const filePath = `/uploads/${req.file.filename}`;
    
    // Insert or update document record without deleting the existing row.
    const [result] = await pool.execute(
      `INSERT INTO documents (employee_id, document_type, file_name, file_path)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         file_name = VALUES(file_name),
         file_path = VALUES(file_path),
         uploaded_date = CURRENT_TIMESTAMP,
         verification_status = 'Pending',
         verified_by = NULL,
         verified_at = NULL,
         rejection_reason = NULL`,
      [employeeId, docType, req.file.originalname, filePath]
    );
    
    console.log('✅ Document uploaded successfully');
    return res.status(200).json({
      message: 'Document uploaded successfully.',
      file_name: req.file.originalname,
      file_path: filePath
    });
    
  } catch (err) {
    console.error('Error uploading document:', err.message);
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: 'Failed to upload document.', details: err.message });
  }
});

// Get employee documents
app.get('/api/employees/:id/documents', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params; // id = employee_code
    
    // Get employee ID from employee_code
    const [empRows] = await pool.execute('SELECT id FROM employees WHERE employee_code = ?', [id]);
    if (empRows.length === 0) {
      return res.status(404).json({ error: 'Employee not found.' });
    }
    
    const employeeId = empRows[0].id;
    
    // Fetch all documents for this employee
    const [docs] = await pool.execute(
      `SELECT id, document_type, file_name, file_path, uploaded_date FROM documents 
       WHERE employee_id = ? ORDER BY document_type`,
      [employeeId]
    );
    
    console.log(`Fetched ${docs.length} documents for employee ${id}`);
    return res.json(docs);
    
  } catch (err) {
    console.error('Error fetching documents:', err.message);
    return res.status(500).json({ error: 'Failed to fetch documents.', details: err.message });
  }
});

// Delete employee document
app.delete('/api/employees/:id/documents/:docId', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id, docId } = req.params;
    
    // Get document info
    const [docs] = await pool.execute('SELECT file_path FROM documents WHERE id = ?', [docId]);
    if (docs.length === 0) {
      return res.status(404).json({ error: 'Document not found.' });
    }
    
    const filePath = path.join(__dirname, 'public', docs[0].file_path);
    
    // Delete file from disk
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    // Delete database record
    await pool.execute('DELETE FROM documents WHERE id = ?', [docId]);
    
    console.log('✅ Document deleted successfully');
    return res.status(200).json({ message: 'Document deleted successfully.' });
    
  } catch (err) {
    console.error('Error deleting document:', err.message);
    return res.status(500).json({ error: 'Failed to delete document.', details: err.message });
  }
});

// Employee family members
app.get('/api/employees/:id/family', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT id, employee_id, relationship_type, extension_name, first_name, middle_name, last_name,
              date_of_birth, telephone_number, business_address, occupation, employer_name, deceased
       FROM employee_family_members
       WHERE employee_id = ?
       ORDER BY relationship_type, last_name, first_name`,
      [id]
    );

    res.json(rows);
  } catch (err) {
    console.error('Error fetching family members:', err.message);
    res.status(500).json({ error: 'Failed to fetch family members.' });
  }
});

app.post('/api/employees/:id/family', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    const {
      relationship_type,
      extension_name,
      first_name,
      middle_name,
      last_name,
      date_of_birth,
      telephone_number,
      business_address,
      occupation,
      employer_name,
      deceased
    } = req.body;

    if (!relationship_type || !first_name || !last_name) {
      return res.status(400).json({ error: 'Relationship type, first name, and last name are required.' });
    }

    const [result] = await pool.execute(
      `INSERT INTO employee_family_members
       (employee_id, relationship_type, extension_name, first_name, middle_name, last_name, date_of_birth,
        telephone_number, business_address, occupation, employer_name, deceased)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        relationship_type,
        extension_name || null,
        first_name,
        middle_name || null,
        last_name,
        date_of_birth || null,
        telephone_number || null,
        business_address || null,
        occupation || null,
        employer_name || null,
        deceased === true || deceased === 'true' || deceased === '1' ? 1 : 0
      ]
    );

    res.status(201).json({ id: result.insertId, message: 'Family member added.' });
  } catch (err) {
    console.error('Error adding family member:', err.message);
    res.status(500).json({ error: 'Failed to add family member.' });
  }
});

app.delete('/api/employees/:id/family/:familyId', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id, familyId } = req.params;

    const [result] = await pool.execute(
      'DELETE FROM employee_family_members WHERE id = ? AND employee_id = ?',
      [familyId, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Family member not found.' });
    }

    res.json({ message: 'Family member deleted.' });
  } catch (err) {
    console.error('Error deleting family member:', err.message);
    res.status(500).json({ error: 'Failed to delete family member.' });
  }
});

// Employee previous work experiences
app.get('/api/employees/:id/work-experiences', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT id, employee_id, company_name, position_title, employment_type, date_from, date_to,
              supervisor_name, company_address, reason_for_leaving
       FROM employee_work_experiences
       WHERE employee_id = ?
       ORDER BY date_from DESC, company_name`,
      [id]
    );

    res.json(rows);
  } catch (err) {
    console.error('Error fetching work experiences:', err.message);
    res.status(500).json({ error: 'Failed to fetch work experiences.' });
  }
});

app.post('/api/employees/:id/work-experiences', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    const {
      company_name,
      position_title,
      employment_type,
      date_from,
      date_to,
      supervisor_name,
      company_address,
      reason_for_leaving
    } = req.body;

    if (!company_name || !position_title) {
      return res.status(400).json({ error: 'Company name and position title are required.' });
    }

    const [result] = await pool.execute(
      `INSERT INTO employee_work_experiences
       (employee_id, company_name, position_title, employment_type, date_from, date_to,
        supervisor_name, company_address, reason_for_leaving)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        company_name,
        position_title,
        employment_type || null,
        date_from || null,
        date_to || null,
        supervisor_name || null,
        company_address || null,
        reason_for_leaving || null
      ]
    );

    res.status(201).json({ id: result.insertId, message: 'Work experience added.' });
  } catch (err) {
    console.error('Error adding work experience:', err.message);
    res.status(500).json({ error: 'Failed to add work experience.' });
  }
});

app.delete('/api/employees/:id/work-experiences/:experienceId', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id, experienceId } = req.params;

    const [result] = await pool.execute(
      'DELETE FROM employee_work_experiences WHERE id = ? AND employee_id = ?',
      [experienceId, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Work experience not found.' });
    }

    res.json({ message: 'Work experience deleted.' });
  } catch (err) {
    console.error('Error deleting work experience:', err.message);
    res.status(500).json({ error: 'Failed to delete work experience.' });
  }
});

// Employee education/training records
app.get('/api/employees/:id/certifications', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT id, employee_id, certification_name, issuing_organization, issue_date, expiry_date,
              certificate_file_name, certificate_file_path
       FROM employee_certifications
       WHERE employee_id = ?
       ORDER BY issue_date DESC, certification_name`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching certifications:', err.message);
    res.status(500).json({ error: 'Failed to fetch certifications.' });
  }
});

app.post('/api/employees/:id/certifications', requireAuth, requireRole(ROLES.staff_management), uploadSingle('certificate'), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    const { certification_name, issuing_organization, issue_date, expiry_date } = req.body;

    if (!certification_name) return res.status(400).json({ error: 'Certification name is required.' });

    const [result] = await pool.execute(
      `INSERT INTO employee_certifications
       (employee_id, certification_name, issuing_organization, issue_date, expiry_date, certificate_file_name, certificate_file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, certification_name, issuing_organization || null, issue_date || null, expiry_date || null, req.file?.originalname || null, req.file ? `/uploads/${req.file.filename}` : null]
    );

    res.status(201).json({ id: result.insertId, message: 'Certification added.' });
  } catch (err) {
    console.error('Error adding certification:', err.message);
    res.status(500).json({ error: 'Failed to add certification.' });
  }
});

app.delete('/api/employees/:id/certifications/:certificationId', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id, certificationId } = req.params;
    const [rows] = await pool.execute('SELECT certificate_file_path FROM employee_certifications WHERE id = ? AND employee_id = ?', [certificationId, id]);

    if (!rows.length) return res.status(404).json({ error: 'Certification not found.' });

    if (rows[0].certificate_file_path) {
      const filePath = path.join(__dirname, 'public', rows[0].certificate_file_path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await pool.execute('DELETE FROM employee_certifications WHERE id = ? AND employee_id = ?', [certificationId, id]);
    res.json({ message: 'Certification deleted.' });
  } catch (err) {
    console.error('Error deleting certification:', err.message);
    res.status(500).json({ error: 'Failed to delete certification.' });
  }
});

app.get('/api/employees/:id/trainings', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT id, employee_id, training_name, provider, date_from, date_to, training_hours, remarks
       FROM employee_trainings
       WHERE employee_id = ?
       ORDER BY date_from DESC, training_name`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching trainings:', err.message);
    res.status(500).json({ error: 'Failed to fetch trainings.' });
  }
});

app.post('/api/employees/:id/trainings', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    const { training_name, provider, date_from, date_to, training_hours, remarks } = req.body;

    if (!training_name) return res.status(400).json({ error: 'Training name is required.' });

    const [result] = await pool.execute(
      `INSERT INTO employee_trainings
       (employee_id, training_name, provider, date_from, date_to, training_hours, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, training_name, provider || null, date_from || null, date_to || null, training_hours || null, remarks || null]
    );

    res.status(201).json({ id: result.insertId, message: 'Training added.' });
  } catch (err) {
    console.error('Error adding training:', err.message);
    res.status(500).json({ error: 'Failed to add training.' });
  }
});

app.delete('/api/employees/:id/trainings/:trainingId', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id, trainingId } = req.params;
    const [result] = await pool.execute('DELETE FROM employee_trainings WHERE id = ? AND employee_id = ?', [trainingId, id]);

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Training not found.' });
    res.json({ message: 'Training deleted.' });
  } catch (err) {
    console.error('Error deleting training:', err.message);
    res.status(500).json({ error: 'Failed to delete training.' });
  }
});

app.get('/api/employees/:id/skills', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT id, employee_id, skill_name, proficiency, remarks
       FROM employee_skills
       WHERE employee_id = ?
       ORDER BY skill_name`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching skills:', err.message);
    res.status(500).json({ error: 'Failed to fetch skills.' });
  }
});

app.post('/api/employees/:id/skills', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    const { skill_name, proficiency, remarks } = req.body;

    if (!skill_name) return res.status(400).json({ error: 'Skill name is required.' });

    const [result] = await pool.execute(
      'INSERT INTO employee_skills (employee_id, skill_name, proficiency, remarks) VALUES (?, ?, ?, ?)',
      [id, skill_name, proficiency || null, remarks || null]
    );

    res.status(201).json({ id: result.insertId, message: 'Skill added.' });
  } catch (err) {
    console.error('Error adding skill:', err.message);
    res.status(500).json({ error: 'Failed to add skill.' });
  }
});

app.delete('/api/employees/:id/skills/:skillId', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id, skillId } = req.params;
    const [result] = await pool.execute('DELETE FROM employee_skills WHERE id = ? AND employee_id = ?', [skillId, id]);

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Skill not found.' });
    res.json({ message: 'Skill deleted.' });
  } catch (err) {
    console.error('Error deleting skill:', err.message);
    res.status(500).json({ error: 'Failed to delete skill.' });
  }
});

// ============================================================
// EMPLOYEE PHOTOS — Upload, retrieve, and delete employee photos
// ============================================================

// Upload employee photo (store as base64 in database)
app.post('/api/employees/:id/photo', requireAuth, requireRole(ROLES.staff_management), upload.single('photo'), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params; // numeric employee ID
    
    if (!req.file) {
      return res.status(400).json({ error: 'No photo provided.' });
    }

    console.log('\n=== POST /api/employees/:id/photo ===');
    console.log('Employee ID:', id);
    console.log('Photo file:', req.file.filename);
    console.log('Photo size:', req.file.size);

    // Read file and convert to base64
    const fileData = fs.readFileSync(req.file.path);
    
    // Insert or replace photo record
    const [result] = await pool.execute(
      `INSERT INTO employee_photos (employee_id, photo_data, photo_mime_type, photo_size)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE 
       photo_data = VALUES(photo_data),
       photo_mime_type = VALUES(photo_mime_type),
       photo_size = VALUES(photo_size),
       updated_at = NOW()`,
      [id, fileData, req.file.mimetype, req.file.size]
    );

    // Delete temporary file
    fs.unlinkSync(req.file.path);

    console.log('✅ Employee photo uploaded successfully');
    return res.status(200).json({
      message: 'Photo uploaded successfully.',
      file_name: req.file.originalname,
      file_size: req.file.size
    });
    
  } catch (err) {
    console.error('Error uploading photo:', err.message);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(500).json({ error: 'Failed to upload photo.', details: err.message });
  }
});

// Get employee photo
app.get('/api/employees/:id/photo', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params; // numeric employee ID
    
    const [photos] = await pool.execute(
      `SELECT photo_data, photo_mime_type FROM employee_photos WHERE employee_id = ?`,
      [id]
    );

    if (photos.length === 0) {
      return res.status(404).json({ error: 'No photo found for this employee.' });
    }

    const { photo_data, photo_mime_type } = photos[0];
    
    // Send binary photo data
    res.set('Content-Type', photo_mime_type);
    res.send(photo_data);
    
  } catch (err) {
    console.error('Error fetching photo:', err.message);
    return res.status(500).json({ error: 'Failed to fetch photo.', details: err.message });
  }
});

// Delete employee photo
app.delete('/api/employees/:id/photo', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params; // numeric employee ID
    
    const [result] = await pool.execute(
      `DELETE FROM employee_photos WHERE employee_id = ?`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'No photo found for this employee.' });
    }

    console.log('✅ Employee photo deleted successfully');
    return res.status(200).json({ message: 'Photo deleted successfully.' });
    
  } catch (err) {
    console.error('Error deleting photo:', err.message);
    return res.status(500).json({ error: 'Failed to delete photo.', details: err.message });
  }
});

const LEAVE_PERMISSION_ROLES = {
  'leave.request.create': ['employee', 'hr_admin', 'admin', 'system_admin'],
  'leave.request.view_own': ['employee', 'hr_admin', 'admin', 'system_admin', 'payroll_manager'],
  'leave.manual.create': ['hr_admin', 'admin', 'system_admin'],
  'leave.request.approve': ['hr_admin', 'admin', 'system_admin'],
  'leave.request.view_all': ['hr_admin', 'admin', 'system_admin', 'payroll_manager'],
  'leave.balance.manage': ['hr_admin', 'admin', 'system_admin'],
  'leave.report.view': ['hr_admin', 'admin', 'system_admin', 'payroll_manager'],
  'leave.audit.view': ['hr_admin', 'admin', 'system_admin', 'payroll_manager']
};

function hasLeavePermission(user, permission) {
  return LEAVE_PERMISSION_ROLES[permission]?.includes(user?.role);
}

function requireLeavePermission(permission) {
  return (req, res, next) => {
    if (!hasLeavePermission(req.user, permission)) {
      return res.status(403).json({ error: `Missing permission: ${permission}` });
    }
    next();
  };
}

function normalizePayType(wageType) {
  const value = String(wageType || '').toLowerCase();
  if (value.includes('hour')) return 'Per Hour';
  if (value.includes('trip')) return 'Per Trip';
  if (value.includes('piece')) return 'Per Piece';
  return 'Per Day';
}

function normalizeLegacyLeaveName(type) {
  const value = String(type || '').toLowerCase();
  if (value.includes('sick')) return 'Sick Leave';
  if (value.includes('emergency')) return 'Emergency Leave';
  if (value.includes('maternity')) return 'Maternity Leave';
  if (value.includes('paternity')) return 'Paternity Leave';
  if (value.includes('solo')) return 'Solo Parent Leave';
  if (value.includes('magna')) return 'Magna Carta for Women Leave';
  if (value.includes('vawc')) return 'VAWC Leave';
  return 'Vacation Leave';
}

function boolValue(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

function decimalValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function monthsBetween(startDate, endDate = new Date()) {
  if (!startDate) return 0;
  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) return 0;
  return (endDate.getFullYear() - start.getFullYear()) * 12 + (endDate.getMonth() - start.getMonth());
}

async function getLeaveType(pool, { id, name, includeInactive = false } = {}) {
  const params = [];
  let where = '';
  if (id) {
    where = 'id = ?';
    params.push(Number(id));
  } else {
    where = '(LOWER(name) = LOWER(?) OR LOWER(name) = LOWER(?))';
    params.push(name || '', normalizeLegacyLeaveName(name));
  }
  if (!includeInactive) where += ' AND is_active = 1';
  const [rows] = await pool.execute(`SELECT * FROM leave_types WHERE ${where} LIMIT 1`, params);
  return rows[0] || null;
}

async function ensureLeaveBalance(pool, employeeId, leaveType, year) {
  await pool.execute(
    `INSERT INTO leave_balances (employee_id, leave_type_id, leave_type, balance, used, year)
     VALUES (?, ?, ?, ?, 0, ?)
     ON DUPLICATE KEY UPDATE
       leave_type_id = COALESCE(VALUES(leave_type_id), leave_type_id),
       leave_type = VALUES(leave_type)`,
    [employeeId, leaveType.id, leaveType.name, decimalValue(leaveType.max_allowed_days), year]
  );
}

async function writeLeaveAudit(pool, leaveId, employeeId, actorUserId, action, remarks = null, oldStatus = null, newStatus = null, metadata = null) {
  await pool.execute(
    `INSERT INTO leave_audit_trail
       (leave_request_id, employee_id, actor_user_id, action, remarks, old_status, new_status, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      leaveId || null,
      employeeId || null,
      actorUserId || null,
      action,
      remarks || null,
      oldStatus || null,
      newStatus || null,
      metadata ? JSON.stringify(metadata) : null
    ]
  );
}

function validateLeaveEligibility(employee, leaveType, hasAttachment) {
  const errors = [];
  const gender = String(employee.gender || '').toLowerCase();
  const civilStatus = String(employee.marital_status || employee.civil_status || '').toLowerCase();

  if (leaveType.female_only && gender !== 'female') errors.push('This leave type is for female employees only.');
  if (leaveType.male_only && gender !== 'male') errors.push('This leave type is for male employees only.');
  if (leaveType.married_only && !civilStatus.includes('married')) errors.push('This leave type requires married civil status.');
  if (leaveType.solo_parent_required && !employee.solo_parent_status) errors.push('This leave type requires solo parent status.');
  if (leaveType.minimum_service_months && monthsBetween(employee.date_hired) < leaveType.minimum_service_months) {
    errors.push(`This leave type requires at least ${leaveType.minimum_service_months} month(s) of service.`);
  }
  if ((leaveType.requires_attachment || leaveType.medical_certificate_required || leaveType.legal_document_required) && !hasAttachment) {
    errors.push('Supporting attachment is required for this leave type.');
  }
  return errors;
}

// Leave
app.get('/api/leave/types', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const includeInactive = req.query.include_inactive === '1';
    if (includeInactive && !hasLeavePermission(req.user, 'leave.balance.manage')) {
      return res.status(403).json({ error: 'Missing permission: leave.balance.manage' });
    }
    const [rows] = await pool.execute(
      `SELECT *
       FROM leave_types
       ${includeInactive ? '' : 'WHERE is_active = 1'}
       ORDER BY FIELD(category, 'Company', 'Statutory'), name`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching leave types:', err.message);
    res.status(500).json({ error: 'Failed to fetch leave types.' });
  }
});

app.post('/api/leave/types', requireAuth, requireLeavePermission('leave.balance.manage'), async (req, res) => {
  try {
    const pool = require('./config/db');
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const category = body.category === 'Statutory' ? 'Statutory' : 'Company';
    if (!name) return res.status(400).json({ error: 'Leave name is required.' });

    const fields = [
      name,
      body.code ? String(body.code).trim() : null,
      category,
      body.description || null,
      decimalValue(body.max_allowed_days),
      boolValue(body.is_paid) ? 1 : 0,
      boolValue(body.is_active) ? 1 : 0,
      boolValue(body.requires_attachment) ? 1 : 0,
      boolValue(body.allow_unpaid_extension) ? 1 : 0,
      decimalValue(body.max_extension_days),
      boolValue(body.female_only) ? 1 : 0,
      boolValue(body.male_only) ? 1 : 0,
      boolValue(body.married_only) ? 1 : 0,
      boolValue(body.solo_parent_required) ? 1 : 0,
      boolValue(body.medical_certificate_required) ? 1 : 0,
      boolValue(body.legal_document_required) ? 1 : 0,
      parseInt(body.minimum_service_months, 10) || 0,
      req.user.id
    ];

    if (body.id) {
      await pool.execute(
        `UPDATE leave_types SET
           name = ?, code = ?, category = ?, description = ?, max_allowed_days = ?,
           is_paid = ?, is_active = ?, requires_attachment = ?,
           allow_unpaid_extension = ?, max_extension_days = ?,
           female_only = ?, male_only = ?, married_only = ?, solo_parent_required = ?,
           medical_certificate_required = ?, legal_document_required = ?,
           minimum_service_months = ?, updated_by = ?
         WHERE id = ?`,
        [...fields, Number(body.id)]
      );
      await writeLeaveAudit(pool, null, null, req.user.id, 'leave_type_updated', name);
      return res.json({ message: 'Leave type updated.' });
    }

    await pool.execute(
      `INSERT INTO leave_types
         (name, code, category, description, max_allowed_days, is_paid, is_active,
          requires_attachment, allow_unpaid_extension, max_extension_days,
          female_only, male_only, married_only, solo_parent_required,
          medical_certificate_required, legal_document_required, minimum_service_months, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fields
    );
    await writeLeaveAudit(pool, null, null, req.user.id, 'leave_type_created', name);
    res.json({ message: 'Leave type saved.' });
  } catch (err) {
    console.error('Error saving leave type:', err.message);
    res.status(500).json({ error: 'Failed to save leave type.' });
  }
});

app.get('/api/leave', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    let q = `SELECT lr.*,
                    COALESCE(lt.name, lr.type) AS type,
                    COALESCE(lt.category, lr.leave_category, 'Company') AS leave_category,
                    CONCAT(e.first_name,' ',e.last_name) AS employee_name,
                    d.name AS department, wt.name AS wage_type,
                    CASE
                      WHEN LOWER(COALESCE(wt.name, '')) LIKE '%hour%' THEN 'Per Hour'
                      WHEN LOWER(COALESCE(wt.name, '')) LIKE '%trip%' THEN 'Per Trip'
                      WHEN LOWER(COALESCE(wt.name, '')) LIKE '%piece%' THEN 'Per Piece'
                      ELSE 'Per Day'
                    END AS pay_type,
                    filed.username AS filed_by_name,
                    encoded.username AS encoded_by_name,
                    reviewer.username AS reviewed_by_name
             FROM leave_requests lr
             JOIN employees e ON e.id = lr.employee_id
             LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
             LEFT JOIN departments d ON d.id = e.department_id
             LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
             LEFT JOIN users filed ON filed.id = lr.filed_by
             LEFT JOIN users encoded ON encoded.id = lr.encoded_by
             LEFT JOIN users reviewer ON reviewer.id = COALESCE(lr.approved_by, lr.rejected_by, lr.reviewed_by)`;
    const p = [];
    if (!hasLeavePermission(req.user, 'leave.request.view_all')) {
      q += ' WHERE lr.employee_id = ?';
      p.push(req.user.employeeId);
    }
    q += ' ORDER BY lr.created_at DESC';
    const [rows] = await pool.execute(q, p);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch leave.' }); }
});

app.get('/api/leave/balances', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const employeeId = hasLeavePermission(req.user, 'leave.request.view_all')
      ? parseInt(req.query.employee_id, 10)
      : req.user.employeeId;

    if (!employeeId) return res.status(400).json({ error: 'employee_id is required.' });

    const [types] = await pool.execute(`SELECT * FROM leave_types WHERE is_active = 1 ORDER BY category, name`);
    for (const type of types) {
      await ensureLeaveBalance(pool, employeeId, type, year);
    }

    const [rows] = await pool.execute(
      `SELECT lb.employee_id, lb.leave_type_id, lb.leave_type, lt.category,
              lb.balance, lb.used, lb.year, (lb.balance - lb.used) AS remaining
       FROM leave_balances lb
       LEFT JOIN leave_types lt ON lt.id = lb.leave_type_id
       WHERE lb.employee_id = ? AND lb.year = ?
       ORDER BY FIELD(COALESCE(lt.category, 'Company'), 'Company', 'Statutory'), lb.leave_type`,
      [employeeId, year]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching leave balances:', err.message);
    res.status(500).json({ error: 'Failed to fetch leave balances.' });
  }
});

app.put('/api/leave/balances', requireAuth, requireLeavePermission('leave.balance.manage'), async (req, res) => {
  try {
    const pool = require('./config/db');
    const employeeId = parseInt(req.body.employee_id, 10);
    const leaveType = await getLeaveType(pool, { id: req.body.leave_type_id, name: req.body.leave_type, includeInactive: true });
    const year = parseInt(req.body.year, 10) || new Date().getFullYear();
    const balance = Number(req.body.balance);

    if (!employeeId || !leaveType || Number.isNaN(balance)) {
      return res.status(400).json({ error: 'employee_id, leave_type, and balance are required.' });
    }

    await pool.execute(
      `INSERT INTO leave_balances (employee_id, leave_type_id, leave_type, balance, used, year)
       VALUES (?, ?, ?, ?, 0, ?)
       ON DUPLICATE KEY UPDATE balance = VALUES(balance)`,
      [employeeId, leaveType.id, leaveType.name, balance, year]
    );
    await writeLeaveAudit(pool, null, employeeId, req.user.id, 'leave_balance_adjusted', `${leaveType.name} balance set to ${balance}`);
    res.json({ message: 'Leave balance updated.' });
  } catch (err) {
    console.error('Error updating leave balance:', err.message);
    res.status(500).json({ error: 'Failed to update leave balance.' });
  }
});

app.post('/api/leave', requireAuth, requireRole(ROLES.any), uploadSingle('attachment'), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { type, leave_type_id, date_from, date_to, days, reason, employee_id, filing_source, remarks } = req.body;
    const source = filing_source === 'Manual' ? 'Manual' : 'Portal';

    if (source === 'Manual' && !hasLeavePermission(req.user, 'leave.manual.create')) {
      return res.status(403).json({ error: 'Missing permission: leave.manual.create' });
    }
    if (source === 'Portal' && !hasLeavePermission(req.user, 'leave.request.create')) {
      return res.status(403).json({ error: 'Missing permission: leave.request.create' });
    }

    let empId = source === 'Manual' ? parseInt(employee_id, 10) : req.user.employeeId;
    if (source === 'Portal' && req.user.role !== 'employee' && employee_id) {
      empId = parseInt(employee_id, 10);
    }

    if (!empId) {
      return res.status(400).json({ error: 'Employee is required.' });
    }

    const [empRows] = await pool.execute(
      `SELECT e.*, wt.name as wage_type
       FROM employees e
       LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
       WHERE e.id = ?`,
      [empId]
    );
    if (!empRows.length) return res.status(404).json({ error: 'Employee not found.' });
    const employee = empRows[0];
    if (String(employee.status || '').toLowerCase() !== 'active') {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Only active employees can file leave.' });
    }

    const leaveType = await getLeaveType(pool, { id: leave_type_id, name: type });
    if (!leaveType) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Active leave type is required.' });
    }

    const payType = normalizePayType(employee.wage_type);
    if (source === 'Portal' && ['Per Trip', 'Per Piece'].includes(payType)) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'Per Trip and Per Piece employees cannot file leave through the portal. HR must manually encode their leave records.' });
    }

    const fromDate = new Date(date_from);
    const toDate = new Date(date_to || date_from);
    const requestedDays = decimalValue(days, Math.floor((toDate - fromDate) / 86400000) + 1);
    if (!date_from || !date_to || Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || toDate < fromDate || requestedDays <= 0) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Valid leave dates and duration are required.' });
    }

    const eligibilityErrors = validateLeaveEligibility(employee, leaveType, Boolean(req.file));
    if (eligibilityErrors.length) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: eligibilityErrors.join(' ') });
    }

    const year = fromDate.getFullYear();
    await ensureLeaveBalance(pool, empId, leaveType, year);
    const [overlaps] = await pool.execute(
      `SELECT id FROM leave_requests
       WHERE employee_id = ?
         AND status IN ('Draft','Pending','Approved')
         AND date_from <= ? AND date_to >= ?
       LIMIT 1`,
      [empId, date_to, date_from]
    );
    if (overlaps.length) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'This employee already has an overlapping leave request.' });
    }

    const [balanceRows] = await pool.execute(
      `SELECT balance, used, (balance - used) AS remaining
       FROM leave_balances
       WHERE employee_id = ? AND leave_type = ? AND year = ?`,
      [empId, leaveType.name, year]
    );
    const remaining = decimalValue(balanceRows[0]?.remaining);
    const extensionDays = leaveType.allow_unpaid_extension ? decimalValue(leaveType.max_extension_days) : 0;
    if (requestedDays > remaining + extensionDays) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Requested duration exceeds the available leave balance and allowed extension.' });
    }

    const [annualRows] = await pool.execute(
      `SELECT COALESCE(SUM(days), 0) AS total_days
       FROM leave_requests
       WHERE employee_id = ?
         AND COALESCE(leave_type_id, 0) = ?
         AND YEAR(date_from) = ?
         AND status IN ('Pending','Approved')`,
      [empId, leaveType.id, year]
    );
    const annualLimit = decimalValue(leaveType.max_allowed_days) + extensionDays;
    if (decimalValue(annualRows[0]?.total_days) + requestedDays > annualLimit) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Requested duration exceeds the configured annual limit for this leave type.' });
    }

    const filePath = req.file ? `/uploads/${req.file.filename}` : null;
    const [result] = await pool.execute(
      `INSERT INTO leave_requests
       (employee_id, leave_type_id, leave_category, type, date_from, date_to, days, reason, file_path,
        filing_source, status, remarks, filed_by, submitted_by, encoded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?, ?)`,
      [empId, leaveType.id, leaveType.category, leaveType.name, date_from, date_to, requestedDays, reason, filePath, source, remarks || null, req.user.id, req.user.id, source === 'Manual' ? req.user.id : null]
    );

    await writeLeaveAudit(pool, result.insertId, empId, req.user.id, source === 'Manual' ? 'leave_manual_encoded' : 'leave_created', remarks || reason || null, null, 'Pending', { leave_type: leaveType.name, filing_source: source });
    res.json({ id: result.insertId, message: 'Leave request submitted.' });
  } catch (err) { 
    console.error('Error saving leave request:', err.message);
    res.status(500).json({ error: 'Failed to submit leave: ' + err.message });
  }
});

app.patch('/api/leave/:id/status', requireAuth, requireLeavePermission('leave.request.approve'), async (req, res) => {
  try {
    const pool = require('./config/db');
    const status = req.body.status === 'Denied' ? 'Rejected' : req.body.status;
    const remarks = req.body.remarks || null;
    if (status === 'Rejected' && !remarks) {
      return res.status(400).json({ error: 'Remarks are required when rejecting leave.' });
    }

    const [rows] = await pool.execute(
      `SELECT lr.*, COALESCE(lt.name, lr.type) AS leave_type_name, lt.id AS configured_leave_type_id, lt.max_allowed_days
       FROM leave_requests lr
       LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
       WHERE lr.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Leave request not found.' });
    const leave = rows[0];
    const leaveType = await getLeaveType(pool, { id: leave.configured_leave_type_id, name: leave.leave_type_name, includeInactive: true });
    if (!leaveType) return res.status(400).json({ error: 'Leave type configuration was not found.' });
    const year = new Date(leave.date_from).getFullYear();
    await ensureLeaveBalance(pool, leave.employee_id, leaveType, year);

    if (status === 'Approved' && leave.status !== 'Approved') {
      const [balanceRows] = await pool.execute(
        `SELECT (balance - used) AS remaining FROM leave_balances WHERE employee_id = ? AND leave_type = ? AND year = ?`,
        [leave.employee_id, leaveType.name, year]
      );
      if (decimalValue(balanceRows[0]?.remaining) < decimalValue(leave.days || 1)) {
        return res.status(400).json({ error: 'Insufficient leave balance for approval.' });
      }
      await pool.execute(
        `UPDATE leave_balances SET used = used + ? WHERE employee_id = ? AND leave_type = ? AND year = ?`,
        [leave.days || 1, leave.employee_id, leaveType.name, year]
      );
    }
    if (leave.status === 'Approved' && ['Rejected', 'Cancelled'].includes(status)) {
      await pool.execute(
        `UPDATE leave_balances SET used = GREATEST(used - ?, 0) WHERE employee_id = ? AND leave_type = ? AND year = ?`,
        [leave.days || 1, leave.employee_id, leaveType.name, year]
      );
    }

    await pool.execute(
      `UPDATE leave_requests SET
         status = ?,
         reviewed_by = ?,
         reviewed_at = NOW(),
         approved_by = CASE WHEN ? = 'Approved' THEN ? ELSE approved_by END,
         approved_at = CASE WHEN ? = 'Approved' THEN NOW() ELSE approved_at END,
         approval_date = CASE WHEN ? = 'Approved' THEN NOW() ELSE approval_date END,
         approval_remarks = CASE WHEN ? = 'Approved' THEN ? ELSE approval_remarks END,
         rejected_by = CASE WHEN ? = 'Rejected' THEN ? ELSE rejected_by END,
         rejected_at = CASE WHEN ? = 'Rejected' THEN NOW() ELSE rejected_at END,
         rejection_remarks = CASE WHEN ? = 'Rejected' THEN ? ELSE rejection_remarks END,
         remarks = COALESCE(?, remarks)
       WHERE id = ?`,
      [status, req.user.id, status, req.user.id, status, status, status, remarks, status, req.user.id, status, status, remarks, remarks, req.params.id]
    );
    const action = status === 'Approved' ? 'leave_approved' : status === 'Rejected' ? 'leave_rejected' : status === 'Cancelled' ? 'leave_cancelled' : 'leave_updated';
    await writeLeaveAudit(pool, req.params.id, leave.employee_id, req.user.id, action, remarks, leave.status, status);
    res.json({ message: 'Leave status updated.' });
  } catch (err) {
    console.error('Error updating leave:', err.message);
    res.status(500).json({ error: 'Failed to update leave.' });
  }
});

app.get('/api/leave/audit', requireAuth, requireLeavePermission('leave.audit.view'), async (req, res) => {
  try {
    const pool = require('./config/db');
    const [rows] = await pool.execute(
      `SELECT lat.*, CONCAT(e.first_name,' ',e.last_name) AS employee_name, u.username AS actor_name
       FROM leave_audit_trail lat
       LEFT JOIN employees e ON e.id = lat.employee_id
       LEFT JOIN users u ON u.id = lat.actor_user_id
       ORDER BY lat.created_at DESC
       LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leave audit trail.' });
  }
});

app.get('/api/leave/reports/:reportType', requireAuth, requireLeavePermission('leave.report.view'), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { reportType } = req.params;
    const format = ['pdf', 'excel', 'csv'].includes(req.query.format) ? req.query.format : 'csv';
    let rows = [];
    if (reportType === 'balances') {
      [rows] = await pool.execute(
        `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, d.name AS department,
                lb.leave_type, lb.balance, lb.used, (lb.balance - lb.used) AS remaining, lb.year
         FROM leave_balances lb
         JOIN employees e ON e.id = lb.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
         ORDER BY e.last_name, lb.leave_type`
      );
    } else {
      [rows] = await pool.execute(
        `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, d.name AS department,
                lr.type, lr.date_from, lr.date_to, lr.days, lr.filing_source, lr.status, lr.created_at
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
         ORDER BY lr.created_at DESC`
      );
    }
    const keys = Object.keys(rows[0] || { report: 'No data' });
    const csv = [keys.join(','), ...rows.map(row => keys.map(key => `"${String(row[key] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
    const extension = format === 'excel' ? 'xls' : format;
    res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : format === 'excel' ? 'application/vnd.ms-excel' : 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${reportType}-leave-report.${extension}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Failed to export leave report.' });
  }
});

// Attendance — now handled by /api/attendance router (server/attendance.js)

// General Requests (COE, COS, Exit)
app.get('/api/requests', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    let q = `SELECT gr.*, CONCAT(e.first_name,' ',e.last_name) AS employee_name
             FROM general_requests gr JOIN employees e ON e.id = gr.employee_id`;
    const p = [];
    if (req.user.role === 'employee') { q += ' WHERE gr.employee_id = ?'; p.push(req.user.employeeId); }
    q += ' ORDER BY gr.created_at DESC';
    const [rows] = await pool.execute(q, p);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch requests.' }); }
});

app.post('/api/requests', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { type, reason, employee_id } = req.body;
    // For employees, use token ID. For admins, prefer body, fall back to token.
    let empId;
    if (req.user.role === 'employee') {
      empId = req.user.employeeId;
    } else {
      empId = employee_id ? parseInt(employee_id) : req.user.employeeId;
    }
    if (!empId) return res.status(400).json({ error: 'Your admin account is not linked to an employee record. Please ask the system administrator to link your account to an employee profile.' });
    if (!['COE','COS','Request Exit'].includes(type)) return res.status(400).json({ error: 'Invalid request type.' });
    const [result] = await pool.execute(
      `INSERT INTO general_requests (employee_id, type, reason) VALUES (?,?,?)`,
      [empId, type, reason || null]
    );
    res.json({ id: result.insertId, message: 'Request submitted.' });
  } catch (err) { res.status(500).json({ error: 'Failed to submit request.' }); }
});

app.patch('/api/requests/:id/status', requireAuth, requireRole(['hr_admin']), async (req, res) => {
  try {
    const pool = require('./config/db');
    await pool.execute(
      `UPDATE general_requests SET status=?, reviewed_by=?, reviewed_at=NOW() WHERE id=?`,
      [req.body.status, req.user.id, req.params.id]
    );
    res.json({ message: 'Request status updated.' });
  } catch (err) { res.status(500).json({ error: 'Failed to update request.' }); }
});

// Payroll runs — payroll roles + admin only
app.get('/api/payroll/runs', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const [rows] = await pool.execute(`SELECT * FROM payroll_runs ORDER BY created_at DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch payroll runs.' }); }
});

app.post('/api/payroll/runs', requireAuth, requireRole(['payroll_officer']), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { period_start, period_end } = req.body;
    const [result] = await pool.execute(
      `INSERT INTO payroll_runs (period_start,period_end,run_date,status,created_by) VALUES (?,?,CURDATE(),'Draft',?)`,
      [period_start, period_end, req.user.id]
    );
    res.json({ id: result.insertId, message: 'Payroll run created.' });
  } catch (err) { res.status(500).json({ error: 'Failed to create payroll run.' }); }
});

app.patch('/api/payroll/runs/:id/approve', requireAuth, requireRole(['payroll_manager']), async (req, res) => {
  try {
    const pool = require('./config/db');
    await pool.execute(
      `UPDATE payroll_runs SET status=?, approved_by=?, approved_at=NOW() WHERE id=?`,
      [req.body.status, req.user.id, req.params.id]
    );
    res.json({ message: 'Payroll run updated.' });
  } catch (err) { res.status(500).json({ error: 'Failed to update payroll run.' }); }
});

// Payslips
app.get('/api/payroll/payslips', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    let q = `SELECT ps.*, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
             pr.period_start, pr.period_end
             FROM payslips ps JOIN employees e ON e.id=ps.employee_id
             JOIN payroll_runs pr ON pr.id=ps.payroll_run_id`;
    const p = [];
    if (req.user.role === 'employee') { q += ' WHERE ps.employee_id = ?'; p.push(req.user.employeeId); }
    q += ' ORDER BY ps.generated_at DESC';
    const [rows] = await pool.execute(q, p);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch payslips.' }); }
});

// Blockchain — admin only
app.get('/api/blockchain', requireAuth, requireRole([...ROLES.admin_any, ...ROLES.payroll_any]), async (req, res) => {
  try {
    const pool = require('./config/db');
    const [rows] = await pool.execute(
      `SELECT al.*, CONCAT(e.first_name,' ',e.last_name) AS employee_name
       FROM audit_log al LEFT JOIN employees e ON e.id=al.employee_id
       ORDER BY al.created_at DESC LIMIT 50`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch audit log.' }); }
});

// Error handling middleware (before SPA fallback)
app.use((err, req, res, next) => {
  console.error('❌ Unhandled Error:', err.message);
  res.status(err.status || 500).json({ 
    error: 'Internal Server Error',
    message: err.message
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH) {
  const tlsOptions = {
    cert: fs.readFileSync(process.env.TLS_CERT_PATH),
    key: fs.readFileSync(process.env.TLS_KEY_PATH),
    ca: process.env.TLS_CA_PATH ? fs.readFileSync(process.env.TLS_CA_PATH) : undefined,
    minVersion: 'TLSv1.3',
  };
  https.createServer(tlsOptions, app).listen(PORT, () => {
    console.log(`LGSV_HR running with TLS 1.3 -> https://localhost:${PORT}`);
  });
} else {
  app.listen(PORT, () => {
    console.log(`LGSV_HR local development server -> http://localhost:${PORT}`);
    if (process.env.NODE_ENV === 'production') {
      console.warn('TLS certificate paths are not configured. Terminate TLS 1.3 at the trusted reverse proxy.');
    }
  });
}


