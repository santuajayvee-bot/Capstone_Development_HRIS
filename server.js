/* ============================================================
   server.js — LGSV_HR System — Express + JWT + MySQL
   ============================================================ */

require('dotenv').config();
const express    = require('express');
const https      = require('https');
const os         = require('os');
const path       = require('path');
const multer     = require('multer');
const fs         = require('fs');
const http       = require('http');
const nodeCrypto = require('crypto');

const { me }                                 = require('./server/auth');
const { requireAuth, requireRole, ROLES }    = require('./server/middleware');
const authRoutes                             = require('./routes/authRoutes');
const accountRoutes                          = require('./routes/accountRoutes');
const payrollRoutes                          = require('./server/payroll');
const fileManagementRoutes                   = require('./server/201-file-management');
const attendanceRoutes                       = require('./server/attendance');
const biometricRoutes                        = require('./server/biometric');
const blockchainPayrollRoutes                = require('./server/routes/blockchain-payroll');
const onboardingRoutes                       = require('./server/onboarding');
const adminRbacRoutes                        = require('./server/admin-rbac');
const employeeDashboardRoutes                = require('./server/employee-dashboard');
const { encryptPII }                         = require('./server/crypto');
const dashboardRoutes                        = require('./server/dashboard');
const reportsRoutes                          = require('./server/reports');
const selfServiceRoutes                      = require('./server/self-service');
const { validateRequestBody }                = require('./validators/inputValidation');
const { hashTemporaryPassword }              = require('./services/passwordService');
const {
  auditSecurityEvent,
  multerFileFilter,
  randomSafeFilename,
  rejectForbiddenFields,
  secureUploadedFile,
}                                             = require('./server/security-controls');

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const EMPLOYEE_ID_ADMIN_ROLES = [...ROLES.hr_manager, ...ROLES.admin_any];
const EMPLOYEE_PARAMETER_TAMPER_GUARD = rejectForbiddenFields(new Set([
  'role',
  'role_id',
  'access_level',
  'is_admin',
  'password_hash',
  'gross_pay',
  'net_pay',
  'total_deductions',
  'payroll_status',
]), {
  action: 'blocked_employee_parameter_tampering_attempt',
  module: 'EMPLOYEE_SECURITY',
  targetTable: 'employees',
});
const ADDRESS_DATASET_PATH = path.join(__dirname, 'data', 'philippine_provinces_cities_municipalities_and_barangays.json');
const ADDRESS_DATASET_UNAVAILABLE = 'Philippine address dataset unavailable. Please contact the administrator.';
const EMPLOYEE_TEXT_PATTERN = /^[A-Za-zÀ-ÖØ-öø-ÿÑñ\s'.-]+$/;
const EMPLOYEE_ADDRESS_PATTERN = /^[A-Za-z0-9À-ÖØ-öø-ÿÑñ\s,.'#/-]+$/;
const EMPLOYEE_SAFE_TEXT_PATTERN = /^[A-Za-z0-9À-ÖØ-öø-ÿÑñ\s,.'#()&+/-]+$/;
const EMPLOYEE_FORBIDDEN_PATTERN = /(<|>|<\/|script|javascript:|onerror\s*=|onload\s*=|\b(select|insert|update|delete|drop|alter|union|exec|truncate)\b|--|;)/i;
const EMPLOYEE_ENUMS = {
  gender: new Set(['Male', 'Female', 'Prefer not to say']),
  nationality: new Set(['Filipino', 'American', 'Other']),
  marital_status: new Set(['Single', 'Married', 'Separated', 'Widowed']),
  blood_type: new Set(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown']),
  employment_type: new Set(['Full-time', 'Part-time', 'Contractual', 'Regular']),
  hiring_type: new Set(['Direct Hire', 'Agency-Hired']),
  deployment_status: new Set(['Pending Deployment', 'Deployed', 'On Hold', 'Ended']),
  employee_level: new Set(['Rank and File', 'Supervisor', 'Manager', 'Executive']),
  status: new Set(['Active', 'Inactive']),
  payroll_schedule: new Set(['weekly', 'semi_monthly', 'monthly', 'Weekly', 'Semi-Monthly', 'Monthly']),
  tax_status: new Set(['Single', 'Married', 'Head of Family', 'Exempt']),
};
const EMPLOYEE_PAYROLL_PROTECTED_FIELDS = new Set([
  'wage_type', 'wage_type_id', 'base_rate', 'sewingRates', 'allowances', 'allowance',
  'payroll_schedule', 'salary_grade', 'sss_number', 'philhealth_number',
  'pagibig_number', 'tin', 'tax_status', 'bank_name', 'bank_account'
]);
const EMPLOYEE_WAGE_CONFIG_FIELDS = new Set(['wage_type', 'wage_type_id', 'base_rate', 'sewingRates']);
const EMPLOYEE_GOVERNMENT_ID_FIELDS = new Set(['sss_number', 'philhealth_number', 'pagibig_number', 'tin']);
const EMPLOYEE_PAYROLL_ONLY_FIELDS = new Set(['allowances', 'allowance', 'payroll_schedule', 'salary_grade', 'tax_status', 'bank_name', 'bank_account']);
const EMPLOYEE_HR_PROTECTED_FIELDS = new Set([
  'department_id', 'position', 'employment_type', 'hiring_type', 'deployment_status',
  'date_hired', 'end_of_contract', 'employee_level', 'status', 'supervisor',
  'work_location', 'shift_schedule', 'agency_name', 'agency_contact_person',
  'agency_contact_number', 'contract_start_date', 'contract_end_date'
]);
let philippineAddressCache = null;
let philippineAddressError = null;

app.set('trust proxy', 1);

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

function normalizeLookupKey(value) {
  return String(value || '').trim().toUpperCase();
}

function loadPhilippineAddressDataset() {
  try {
    const raw = fs.readFileSync(ADDRESS_DATASET_PATH, 'utf8');
    const data = JSON.parse(raw);
    const regions = Object.entries(data).map(([code, region]) => ({
      code,
      name: region.region_name,
      provinceList: region.province_list || {}
    })).filter(region => region.name);

    philippineAddressCache = {
      regions: regions.sort((a, b) => a.name.localeCompare(b.name)),
      regionByName: new Map(regions.map(region => [normalizeLookupKey(region.name), region])),
      provinceByName: new Map()
    };

    regions.forEach(region => {
      Object.entries(region.provinceList).forEach(([provinceName, province]) => {
        philippineAddressCache.provinceByName.set(normalizeLookupKey(provinceName), {
          name: provinceName,
          region: region.name,
          municipalityList: province.municipality_list || {}
        });
      });
    });
    console.log(`Loaded Philippine address dataset: ${regions.length} regions`);
  } catch (error) {
    philippineAddressCache = null;
    philippineAddressError = error;
    console.error(`${ADDRESS_DATASET_UNAVAILABLE} ${error.message}`);
  }
}

loadPhilippineAddressDataset();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, randomSafeFilename(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: multerFileFilter
});

function uploadSingle(fieldName) {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (err) => {
      if (!err) return secureUploadedFile(req, res, next);

      const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large. Maximum size is 5MB.'
        : err.message || 'File upload failed.';

      auditSecurityEvent(req, {
        action: 'blocked_file_upload_tampering_attempt',
        module: 'FILE_UPLOAD_SECURITY',
        targetTable: 'documents',
        newValue: { message, path: req.originalUrl },
        result: 'blocked',
      }).catch(() => {});
      return res.status(400).json({ error: message });
    });
  };
}

function normalizeWageTypeInput(value) {
  const name = String(value || '').trim();
  if (/piece/i.test(name)) return 'Per-Piece';
  if (/trip|logistics/i.test(name)) return 'Per-Trip';
  if (/hour/i.test(name)) return 'Hourly';
  if (/day|daily/i.test(name)) return 'Daily';
  if (/base|salary/i.test(name)) return 'Base Salary';
  return name;
}

async function resolveWageTypeId(pool, wageType) {
  const normalized = normalizeWageTypeInput(wageType);
  const [rows] = await pool.execute(
    'SELECT id FROM wage_types WHERE LOWER(name) = LOWER(?) LIMIT 1',
    [normalized]
  );
  return rows[0]?.id || null;
}

app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));
app.use(express.urlencoded({ extended: true }));
// Enforce shared input rules before any API route receives a write request.
// This is the final authority; browser validation is only a usability layer.
app.use(validateRequestBody);
app.use((req, res, next) => {
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/attendance/scan', (_req, res) => {
  res.status(410).type('text/plain').send('QR attendance has been disabled. Please use fingerprint biometric attendance.');
});

app.get('/attendance/station', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'attendance-station.html'));
});

app.get('/health', (_req, res) => {
  res.type('text/plain').send('Server is running');
});

// ── PUBLIC ───────────────────────────────────────────────────
app.use('/api/auth', authRoutes);

// ── PROTECTED ────────────────────────────────────────────────
app.get('/api/auth/me', requireAuth, me);
app.use('/api/account', accountRoutes);

function requirePhilippineAddressCache(res) {
  if (philippineAddressCache) return true;
  console.error('Philippine address dataset load error:', philippineAddressError?.message || 'unknown');
  res.status(503).json({ error: ADDRESS_DATASET_UNAVAILABLE });
  return false;
}

function addressOption(value) {
  return { value, label: value };
}

function localPhilippineAddressSuggestions(query, limit = 8) {
  if (!philippineAddressCache) return [];
  const needle = normalizeLookupKey(query);
  const suggestions = [];

  const pushSuggestion = (fullAddress, details) => {
    if (!fullAddress || suggestions.some(item => normalizeLookupKey(item.full_address) === normalizeLookupKey(fullAddress))) return;
    suggestions.push({
      full_address: fullAddress,
      latitude: null,
      longitude: null,
      place_id: '',
      provider: 'philippine_dataset',
      ...details
    });
  };

  for (const region of philippineAddressCache.regions) {
    if (normalizeLookupKey(region.name).includes(needle)) {
      pushSuggestion(`${region.name}, Philippines`, {
        region: region.name,
        street_address: query
      });
    }

    for (const [provinceName, province] of Object.entries(region.provinceList)) {
      if (normalizeLookupKey(provinceName).includes(needle)) {
        pushSuggestion(`${provinceName}, ${region.name}, Philippines`, {
          region: region.name,
          province: provinceName,
          street_address: query
        });
      }

      for (const [cityName, city] of Object.entries(province.municipality_list || {})) {
        if (normalizeLookupKey(cityName).includes(needle)) {
          pushSuggestion(`${cityName}, ${provinceName}, ${region.name}, Philippines`, {
            region: region.name,
            province: provinceName,
            city_municipality: cityName,
            street_address: query
          });
        }

        for (const barangayName of city.barangay_list || []) {
          if (normalizeLookupKey(barangayName).includes(needle)) {
            pushSuggestion(`${barangayName}, ${cityName}, ${provinceName}, ${region.name}, Philippines`, {
              region: region.name,
              province: provinceName,
              city_municipality: cityName,
              barangay: barangayName,
              street_address: query
            });
          }
          if (suggestions.length >= limit) return suggestions;
        }
        if (suggestions.length >= limit) return suggestions;
      }
      if (suggestions.length >= limit) return suggestions;
    }
  }

  return suggestions;
}

app.get('/api/address/regions', requireAuth, requireRole(ROLES.any), (_req, res) => {
  if (!requirePhilippineAddressCache(res)) return;
  res.json(philippineAddressCache.regions.map(region => ({
    value: region.name,
    label: region.name,
    code: region.code
  })));
});

app.get('/api/address/provinces/:region', requireAuth, requireRole(ROLES.any), (req, res) => {
  if (!requirePhilippineAddressCache(res)) return;
  const region = philippineAddressCache.regionByName.get(normalizeLookupKey(req.params.region));
  if (!region) return res.json([]);
  res.json(Object.keys(region.provinceList).sort((a, b) => a.localeCompare(b)).map(addressOption));
});

app.get('/api/address/cities/:province', requireAuth, requireRole(ROLES.any), (req, res) => {
  if (!requirePhilippineAddressCache(res)) return;
  const province = philippineAddressCache.provinceByName.get(normalizeLookupKey(req.params.province));
  if (!province) return res.json([]);
  res.json(Object.keys(province.municipalityList).sort((a, b) => a.localeCompare(b)).map(addressOption));
});

app.get('/api/address/barangays/:city', requireAuth, requireRole(ROLES.any), (req, res) => {
  if (!requirePhilippineAddressCache(res)) return;
  const cityKey = normalizeLookupKey(req.params.city);
  for (const province of philippineAddressCache.provinceByName.values()) {
    const cityEntry = Object.entries(province.municipalityList)
      .find(([cityName]) => normalizeLookupKey(cityName) === cityKey);
    if (cityEntry) {
      const barangays = cityEntry[1]?.barangay_list || [];
      return res.json([...barangays].sort((a, b) => a.localeCompare(b)).map(addressOption));
    }
  }
  res.json([]);
});

app.get('/api/address/search', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 3) return res.json([]);

    const localSuggestions = localPhilippineAddressSuggestions(query);
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

      return res.json([...suggestions, ...localSuggestions].slice(0, 8));
    }

    res.json(localSuggestions);
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
    url.searchParams.set('fields', 'formatted_address,geometry,place_id,address_components');
    url.searchParams.set('key', apiKey);

    const response = await fetch(url);
    const data = await response.json();
    if (data.status !== 'OK') {
      return res.status(502).json({ error: data.error_message || `Place details failed: ${data.status}` });
    }

    const result = data.result || {};
    const components = result.address_components || [];
    const component = (...types) => {
      const match = components.find(item => types.some(type => item.types?.includes(type)));
      return match?.long_name || '';
    };
    res.json({
      full_address: result.formatted_address,
      latitude: result.geometry?.location?.lat,
      longitude: result.geometry?.location?.lng,
      place_id: result.place_id || placeId,
      street_address: [component('street_number'), component('route')].filter(Boolean).join(' ') || result.formatted_address,
      barangay: component('sublocality_level_1', 'sublocality_level_2', 'neighborhood'),
      city_municipality: component('locality', 'administrative_area_level_3', 'postal_town'),
      province: component('administrative_area_level_2'),
      region: component('administrative_area_level_1'),
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
app.use('/api/reports', reportsRoutes);

// 201-File Management (Auth required, role-based per endpoint)
app.use('/api/201-files', requireAuth, fileManagementRoutes);

// Attendance Module (biometric attendance, records, manual correction, audit)
app.use('/api/attendance', attendanceRoutes);

// Local biometric bridge endpoint for ZKTeco ZK9500 attendance scans
app.use('/api/biometric', biometricRoutes);

// Permissioned blockchain payroll audit layer
app.use('/api/blockchain/payroll', blockchainPayrollRoutes);

// Onboarding Module (pre-employment lifecycle, secure document vault, transfer)
app.use('/api/onboarding', onboardingRoutes);

// Admin RBAC Module — Account Registration & Role Management (Level 4 only)
app.use('/api/admin', adminRbacRoutes);

// Employee Actor Module — Employee-only dashboard, 201-file, payslips
app.use('/api/employee', employeeDashboardRoutes);

function normalizeAddressPayload(body) {
  const sameCurrent = boolValue(body.current_address_same_as_home);
  const sameMailing = boolValue(body.mailing_address_same_as_home);
  const structured = section => ({
    region: String(body[`${section}_region`] || '').trim(),
    province: String(body[`${section}_province`] || '').trim(),
    city_municipality: String(body[`${section}_city_municipality`] || '').trim(),
    barangay: String(body[`${section}_barangay`] || '').trim(),
    street_address: String(body[`${section}_street_address`] || '').trim(),
    full_address: String(body[`${section}_full_address`] || '').trim(),
    place_id: String(body[`${section}_place_id`] || '').trim()
  });
  const home = {
    address: String(body.residential_address || '').trim(),
    lat: body.residential_address_lat,
    lng: body.residential_address_lng,
    ...structured('residential_address')
  };
  const current = sameCurrent
    ? { ...home }
    : { address: String(body.current_address || '').trim(), lat: body.current_address_lat, lng: body.current_address_lng, ...structured('current_address') };
  const mailing = sameMailing
    ? { ...home }
    : { address: String(body.mailing_address || '').trim(), lat: body.mailing_address_lat, lng: body.mailing_address_lng, ...structured('mailing_address') };

  return { home, current, mailing, sameCurrent, sameMailing };
}

async function ensurePhilippineAddressColumns(pool) {
  const columns = [
    ['residential_address_region', 'VARCHAR(120) NULL'],
    ['residential_address_province', 'VARCHAR(120) NULL'],
    ['residential_address_city_municipality', 'VARCHAR(160) NULL'],
    ['residential_address_barangay', 'VARCHAR(160) NULL'],
    ['residential_address_street_address', 'VARCHAR(255) NULL'],
    ['residential_address_full_address', 'TEXT NULL'],
    ['residential_address_place_id', 'VARCHAR(255) NULL'],
    ['current_address_region', 'VARCHAR(120) NULL'],
    ['current_address_province', 'VARCHAR(120) NULL'],
    ['current_address_city_municipality', 'VARCHAR(160) NULL'],
    ['current_address_barangay', 'VARCHAR(160) NULL'],
    ['current_address_street_address', 'VARCHAR(255) NULL'],
    ['current_address_full_address', 'TEXT NULL'],
    ['current_address_place_id', 'VARCHAR(255) NULL'],
    ['mailing_address_region', 'VARCHAR(120) NULL'],
    ['mailing_address_province', 'VARCHAR(120) NULL'],
    ['mailing_address_city_municipality', 'VARCHAR(160) NULL'],
    ['mailing_address_barangay', 'VARCHAR(160) NULL'],
    ['mailing_address_street_address', 'VARCHAR(255) NULL'],
    ['mailing_address_full_address', 'TEXT NULL'],
    ['mailing_address_place_id', 'VARCHAR(255) NULL']
  ];

  for (const [column, definition] of columns) {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS count
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'employees'
          AND COLUMN_NAME = ?`,
      [column]
    );
    if (!Number(rows[0]?.count || 0)) {
      await pool.execute(`ALTER TABLE employees ADD COLUMN ${column} ${definition}`);
    }
  }
}

function validateEmployeeAddresses(body) {
  const addresses = normalizeAddressPayload(body);
  const errors = [];

  if (!addresses.home.address) errors.push('Home Address is required.');
  if (!addresses.sameCurrent && !addresses.current.address) errors.push('Current Address is required unless Same as Home Address is checked.');
  if (!addresses.sameMailing && !addresses.mailing.address) errors.push('Mailing Address is required unless Same as Home Address is checked.');

  return { errors, addresses };
}

function employeeHasRole(req, roles) {
  return roles.includes(req.user?.role);
}

function normalizeBlank(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function rejectEmployeeInput(field, reason = null) {
  const error = new Error(`Invalid input for ${field}.`);
  error.status = 400;
  error.field = field;
  error.reason = reason;
  return error;
}

function validateNoDangerousText(field, value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (EMPLOYEE_FORBIDDEN_PATTERN.test(text) || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) {
    throw rejectEmployeeInput(field);
  }
  return text;
}

function validateEmployeeTextField(body, field, { max = 120, pattern = EMPLOYEE_TEXT_PATTERN, allowEmpty = true } = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return;
  const value = normalizeBlank(body[field]);
  if (value == null) {
    if (!allowEmpty) throw rejectEmployeeInput(field);
    body[field] = null;
    return;
  }
  const text = validateNoDangerousText(field, value);
  if (text.length > max || !pattern.test(text)) throw rejectEmployeeInput(field);
  body[field] = text.replace(/\s+/g, ' ');
}

function validateEmployeeEmailField(body, field, { required = false } = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) {
    if (required) throw rejectEmployeeInput(field);
    return;
  }
  const value = normalizeBlank(body[field]);
  if (value == null) {
    if (required) throw rejectEmployeeInput(field);
    body[field] = null;
    return;
  }
  const email = validateNoDangerousText(field, value).toLowerCase();
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(email)) throw rejectEmployeeInput(field);
  body[field] = email;
}

function validateEmployeePhoneField(body, field, { required = false } = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) {
    if (required) throw rejectEmployeeInput(field);
    return;
  }
  const value = normalizeBlank(body[field]);
  if (value == null) {
    if (required) throw rejectEmployeeInput(field);
    body[field] = null;
    return;
  }
  const phone = validateNoDangerousText(field, value).replace(/[\s()-]/g, '');
  if (!/^(09\d{9}|\+639\d{9})$/.test(phone)) throw rejectEmployeeInput(field);
  body[field] = phone;
}

function validateEmployeeDateField(body, field, { required = false, noFuture = false } = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) {
    if (required) throw rejectEmployeeInput(field);
    return;
  }
  const value = normalizeBlank(body[field]);
  if (value == null) {
    if (required) throw rejectEmployeeInput(field);
    body[field] = null;
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw rejectEmployeeInput(field);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || value !== date.toISOString().slice(0, 10)) throw rejectEmployeeInput(field);
  if (noFuture && date > new Date()) throw rejectEmployeeInput(field);
  body[field] = value;
}

function validateEmployeeYearField(body, field) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return;
  const value = normalizeBlank(body[field]);
  if (value == null) {
    body[field] = null;
    return;
  }
  if (!/^\d{4}$/.test(value)) throw rejectEmployeeInput(field);
  const year = Number(value);
  const currentYear = new Date().getFullYear() + 1;
  if (year < 1900 || year > currentYear) throw rejectEmployeeInput(field);
  body[field] = String(year);
}

function validateEmployeeEnumField(body, field, allowed = EMPLOYEE_ENUMS[field]) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return;
  const value = normalizeBlank(body[field]);
  if (value == null) {
    body[field] = null;
    return;
  }
  validateNoDangerousText(field, value);
  if (!allowed || !allowed.has(value)) throw rejectEmployeeInput(field);
  body[field] = value;
}

function normalizePayrollSchedule(value) {
  const text = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (text === 'semi_monthly' || text === 'semimonthly') return 'semi_monthly';
  if (text === 'weekly' || text === 'monthly') return text;
  throw rejectEmployeeInput('payroll_schedule');
}

function validateEmployeeMoneyField(body, field, { max = 1000000 } = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return;
  const value = normalizeBlank(body[field]);
  if (value == null) {
    body[field] = null;
    return;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) throw rejectEmployeeInput(field);
  body[field] = number.toFixed(2);
}

function validateGovernmentIdField(body, field, pattern) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return;
  const value = normalizeBlank(body[field]);
  if (value == null) {
    body[field] = null;
    return;
  }
  const text = validateNoDangerousText(field, value);
  const digits = text.replace(/\D/g, '');
  if (!pattern.test(digits) || !/^[\d-]+$/.test(text)) throw rejectEmployeeInput(field);
  body[field] = text;
}

function validateLatLngField(body, field, min, max) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return;
  const value = normalizeBlank(body[field]);
  if (value == null) {
    body[field] = null;
    return;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw rejectEmployeeInput(field);
  body[field] = String(number);
}

function validateDateOrder(body, startField, endField) {
  if (!body[startField] || !body[endField]) return;
  if (String(body[endField]) < String(body[startField])) throw rejectEmployeeInput(endField);
}

async function auditEmployeeSensitiveField(req, field, targetEmployeeId, oldValue, newValue, result) {
  await auditSecurityEvent(req, {
    action: result === 'blocked' ? 'employee_sensitive_field_tampering_blocked' : 'employee_sensitive_field_updated',
    module: 'EMPLOYEE_SECURITY',
    targetTable: 'employees',
    targetRecord: targetEmployeeId || req.params?.id || null,
    oldValue: { field, value: oldValue ?? null },
    newValue: { field, value: newValue ?? null, path: req.originalUrl },
    result,
  });
}

async function rejectEmployeeFieldTampering(req, res, field, oldValue = null, newValue = null) {
  await auditEmployeeSensitiveField(req, field, req.params?.id || req.body?.id || null, oldValue, newValue, 'blocked');
  return res.status(403).json({ error: 'You are not allowed to modify this field.' });
}

async function validateDepartmentId(pool, body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'department_id')) return;
  const value = normalizeBlank(body.department_id);
  if (value == null) {
    body.department_id = null;
    return;
  }
  const departmentId = Number(value);
  if (!Number.isInteger(departmentId) || departmentId <= 0) throw rejectEmployeeInput('department_id');
  const [rows] = await pool.execute('SELECT id FROM departments WHERE id = ? AND is_active = 1 LIMIT 1', [departmentId]);
  if (!rows.length) throw rejectEmployeeInput('department_id');
  body.department_id = departmentId;
}

async function validateWageType(pool, body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'wage_type')) return;
  const value = normalizeBlank(body.wage_type);
  if (value == null) {
    body.wage_type = null;
    return;
  }
  const normalized = normalizeWageTypeInput(value);
  const [rows] = await pool.execute('SELECT id, name FROM wage_types WHERE LOWER(name) = LOWER(?) LIMIT 1', [normalized]);
  if (!rows.length) throw rejectEmployeeInput('wage_type');
  body.wage_type = rows[0].name;
}

async function validateEmployeeRequestBody(req, res, pool, { mode = 'update' } = {}) {
  const body = req.body || {};
  const role = req.user?.role;
  const isHrOrAdmin = employeeHasRole(req, [...ROLES.hr_manager, ...ROLES.admin_any]);
  const isPayrollOrAdmin = employeeHasRole(req, [...ROLES.payroll_any, ...ROLES.admin_any]);

  for (const field of Object.keys(body)) {
    if (EMPLOYEE_HR_PROTECTED_FIELDS.has(field) && !isHrOrAdmin) {
      return rejectEmployeeFieldTampering(req, res, field, null, body[field]);
    }
    if (EMPLOYEE_WAGE_CONFIG_FIELDS.has(field) && !isPayrollOrAdmin && !isHrOrAdmin) {
      return rejectEmployeeFieldTampering(req, res, field, null, body[field]);
    }
    if (EMPLOYEE_GOVERNMENT_ID_FIELDS.has(field) && !isPayrollOrAdmin && !isHrOrAdmin) {
      return rejectEmployeeFieldTampering(req, res, field, null, body[field]);
    }
    if (EMPLOYEE_PAYROLL_ONLY_FIELDS.has(field) && !isPayrollOrAdmin && !isHrOrAdmin) {
      return rejectEmployeeFieldTampering(req, res, field, null, body[field]);
    }
  }

  if (mode === 'update') {
    const [existingRows] = await pool.execute('SELECT * FROM employees WHERE id = ? OR employee_code = ? LIMIT 1', [req.params.id, req.params.id]);
    const existing = existingRows[0] || null;
    if (existing) {
      for (const field of [...EMPLOYEE_PAYROLL_PROTECTED_FIELDS, ...EMPLOYEE_HR_PROTECTED_FIELDS]) {
        if (Object.prototype.hasOwnProperty.call(body, field)) {
          const oldValue = existing[field] ?? (field === 'allowance' ? existing.allowances : null);
          if (String(oldValue ?? '') !== String(body[field] ?? '')) {
            await auditEmployeeSensitiveField(req, field, existing.id, oldValue, body[field], 'allowed');
          }
        }
      }
    }
  }

  try {
    [
      'first_name', 'middle_name', 'last_name', 'suffix', 'nationality', 'marital_status',
      'place_of_birth', 'religion', 'supervisor', 'work_location',
      'emergency_contact_name', 'emergency_contact_relationship',
      'education_school', 'education_attainment', 'education_jhs_school',
      'education_jhs_attainment', 'education_shs_school', 'education_shs_attainment',
      'education_vocational_school', 'education_vocational_attainment',
      'education_college_school', 'education_college_attainment', 'agency_contact_person'
    ].forEach(field => validateEmployeeTextField(body, field, { max: field.includes('school') ? 180 : 120 }));

    ['position', 'shift_schedule', 'salary_grade', 'bank_name', 'agency_name'].forEach(field => {
      validateEmployeeTextField(body, field, { max: 160, pattern: EMPLOYEE_SAFE_TEXT_PATTERN });
    });

    [
      'residential_address', 'current_address', 'mailing_address', 'emergency_contact_address',
      'residential_address_full_address', 'current_address_full_address', 'mailing_address_full_address',
      'residential_address_street_address', 'current_address_street_address', 'mailing_address_street_address'
    ].forEach(field => validateEmployeeTextField(body, field, { max: 255, pattern: EMPLOYEE_ADDRESS_PATTERN }));

    [
      'residential_address_region', 'residential_address_province', 'residential_address_city_municipality',
      'residential_address_barangay', 'current_address_region', 'current_address_province',
      'current_address_city_municipality', 'current_address_barangay', 'mailing_address_region',
      'mailing_address_province', 'mailing_address_city_municipality', 'mailing_address_barangay'
    ].forEach(field => validateEmployeeTextField(body, field, { max: 160, pattern: EMPLOYEE_SAFE_TEXT_PATTERN }));

    validateEmployeeEmailField(body, 'email', { required: true });
    validateEmployeeEmailField(body, 'work_email');
    validateEmployeeEmailField(body, 'emergency_contact_email');
    validateEmployeePhoneField(body, 'contact_number');
    validateEmployeePhoneField(body, 'emergency_contact_num');
    validateEmployeePhoneField(body, 'emergency_contact_number');
    validateEmployeePhoneField(body, 'emergency_contact_secondary_num');
    validateEmployeePhoneField(body, 'agency_contact_number');

    ['gender', 'nationality', 'marital_status', 'blood_type', 'employment_type', 'hiring_type', 'deployment_status', 'employee_level', 'status', 'tax_status']
      .forEach(field => validateEmployeeEnumField(body, field));

    ['date_of_birth', 'date_hired', 'end_of_contract', 'contract_start_date', 'contract_end_date'].forEach(field => {
      validateEmployeeDateField(body, field, { noFuture: field === 'date_of_birth' });
    });
    validateDateOrder(body, 'date_hired', 'end_of_contract');
    validateDateOrder(body, 'contract_start_date', 'contract_end_date');

    [
      'education_year_graduated', 'education_jhs_from', 'education_jhs_to', 'education_jhs_year_graduated',
      'education_shs_from', 'education_shs_to', 'education_shs_year_graduated',
      'education_vocational_from', 'education_vocational_to', 'education_vocational_year_graduated',
      'education_college_from', 'education_college_to', 'education_college_year_graduated'
    ].forEach(field => validateEmployeeYearField(body, field));
    validateDateOrder(body, 'education_jhs_from', 'education_jhs_to');
    validateDateOrder(body, 'education_shs_from', 'education_shs_to');
    validateDateOrder(body, 'education_vocational_from', 'education_vocational_to');
    validateDateOrder(body, 'education_college_from', 'education_college_to');

    ['residential_address_lat', 'current_address_lat', 'mailing_address_lat'].forEach(field => validateLatLngField(body, field, -90, 90));
    ['residential_address_lng', 'current_address_lng', 'mailing_address_lng'].forEach(field => validateLatLngField(body, field, -180, 180));

    await validateDepartmentId(pool, body);
    await validateWageType(pool, body);

    if (Object.prototype.hasOwnProperty.call(body, 'payroll_schedule') && body.payroll_schedule != null && body.payroll_schedule !== '') {
      body.payroll_schedule = normalizePayrollSchedule(body.payroll_schedule);
    }
    validateEmployeeMoneyField(body, 'allowances');
    validateEmployeeMoneyField(body, 'allowance');
    validateEmployeeMoneyField(body, 'base_rate');
    validateGovernmentIdField(body, 'sss_number', /^\d{10}$/);
    validateGovernmentIdField(body, 'tin', /^\d{9,12}$/);
    validateGovernmentIdField(body, 'philhealth_number', /^\d{12}$/);
    validateGovernmentIdField(body, 'pagibig_number', /^\d{12}$/);

    if (Array.isArray(body.sewingRates)) {
      for (const rate of body.sewingRates) {
        if (!Number.isInteger(Number(rate.sewing_id)) || Number(rate.sewing_id) <= 0) throw rejectEmployeeInput('sewingRates');
        const value = Number(rate.rate);
        if (!Number.isFinite(value) || value < 0 || value > 1000000) throw rejectEmployeeInput('sewingRates');
      }
    } else if (Object.prototype.hasOwnProperty.call(body, 'sewingRates') && body.sewingRates != null) {
      throw rejectEmployeeInput('sewingRates');
    }
  } catch (error) {
    await auditSecurityEvent(req, {
      action: 'blocked_employee_invalid_input',
      module: 'EMPLOYEE_SECURITY',
      targetTable: 'employees',
      targetRecord: req.params?.id || null,
      newValue: { field: error.field || null, reason: error.reason || null, path: req.originalUrl },
      result: 'blocked',
    });
    return res.status(error.status || 400).json({ error: error.message || 'Invalid employee input.' });
  }

  return null;
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

function formatEmployeeCode(number, config = {}) {
  const prefix = String(config.prefix || 'EMP').trim().toUpperCase();
  const padding = Math.min(Math.max(Number(config.number_padding || 6), 1), 12);
  return `${prefix}${String(Number(number || 0)).padStart(padding, '0')}`;
}

function sanitizeEmployeeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function isValidEmployeeCode(value) {
  return /^[A-Z0-9_-]+$/i.test(String(value || '').trim());
}

async function employeeColumnExists(executor, columnName) {
  const [rows] = await executor.execute(
    `SELECT COUNT(*) AS total
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'employees'
        AND COLUMN_NAME = ?`,
    [columnName]
  );
  return Number(rows[0]?.total || 0) > 0;
}

async function ensureEmployeeAuthColumns(executor) {
  if (!(await employeeColumnExists(executor, 'Password_Hash'))) {
    await executor.execute('ALTER TABLE employees ADD COLUMN Password_Hash VARCHAR(255) NULL');
  }
  if (!(await employeeColumnExists(executor, 'Password_Changed_At'))) {
    await executor.execute('ALTER TABLE employees ADD COLUMN Password_Changed_At DATETIME NULL');
  }
  if (!(await employeeColumnExists(executor, 'Failed_Login_Attempts'))) {
    await executor.execute('ALTER TABLE employees ADD COLUMN Failed_Login_Attempts INT NOT NULL DEFAULT 0');
  }
  if (!(await employeeColumnExists(executor, 'force_password_change'))) {
    await executor.execute('ALTER TABLE employees ADD COLUMN force_password_change BOOLEAN NOT NULL DEFAULT FALSE');
  }
}

async function ensureEmployeeIdConfigSchema(executor) {
  const [codeColumn] = await executor.execute("SHOW COLUMNS FROM employees LIKE 'employee_code'");
  if (!codeColumn.length) {
    await executor.execute('ALTER TABLE employees ADD COLUMN employee_code VARCHAR(20) NULL AFTER id');
  }

  const [duplicateRows] = await executor.execute(`
    SELECT employee_code, COUNT(*) AS total
      FROM employees
     WHERE employee_code IS NOT NULL AND employee_code <> ''
     GROUP BY employee_code
    HAVING COUNT(*) > 1
     LIMIT 1
  `);
  if (!duplicateRows.length) {
    const [indexRows] = await executor.execute(`
      SELECT COUNT(*) AS total
        FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'employees'
         AND INDEX_NAME = 'uq_employees_employee_code'
    `);
    if (!Number(indexRows[0]?.total || 0)) {
      try {
        await executor.execute('CREATE UNIQUE INDEX uq_employees_employee_code ON employees (employee_code)');
      } catch (err) {
        if (err.code !== 'ER_DUP_KEYNAME' && err.code !== 'ER_DUP_ENTRY') throw err;
      }
    }
  } else {
    console.warn('Employee code unique index skipped because duplicate employee_code values already exist.');
  }

  await executor.execute(`
    CREATE TABLE IF NOT EXISTS employee_id_config (
      id TINYINT PRIMARY KEY DEFAULT 1,
      prefix VARCHAR(12) NOT NULL DEFAULT 'EMP',
      starting_number INT NOT NULL DEFAULT 1,
      number_padding TINYINT NOT NULL DEFAULT 6,
      current_sequence INT NOT NULL DEFAULT 0,
      auto_generate_enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  const [rows] = await executor.execute('SELECT COUNT(*) AS total FROM employee_id_config WHERE id = 1');
  if (!Number(rows[0]?.total || 0)) {
    const [onboardingTables] = await executor.execute("SHOW TABLES LIKE 'onboarding_applicant'");
    const [maxRows] = onboardingTables.length
      ? await executor.execute(
          `SELECT employee_code AS code FROM employees WHERE employee_code LIKE 'EMP%'
           UNION ALL
           SELECT intended_employee_code AS code
             FROM onboarding_applicant
            WHERE deleted_at IS NULL
              AND intended_employee_code IS NOT NULL
              AND intended_employee_code LIKE 'EMP%'`
        )
      : await executor.execute("SELECT employee_code AS code FROM employees WHERE employee_code LIKE 'EMP%'");
    const maxSequence = maxRows.reduce((max, row) => Math.max(max, employeeCodeNumber(row.code)), 0);
    await executor.execute(
      `INSERT INTO employee_id_config
         (id, prefix, starting_number, number_padding, current_sequence, auto_generate_enabled)
       VALUES (1, 'EMP', 1, 6, ?, 1)`,
      [maxSequence]
    );
  }
}

async function getEmployeeIdConfig(executor) {
  await ensureEmployeeIdConfigSchema(executor);
  const [[config]] = await executor.execute('SELECT * FROM employee_id_config WHERE id = 1');
  return config || {
    prefix: 'EMP',
    starting_number: 1,
    number_padding: 6,
    current_sequence: 0,
    auto_generate_enabled: 1,
  };
}

async function generateNextEmployeeCode(executor, reserve = false) {
  await ensureEmployeeIdConfigSchema(executor);

  if (reserve) {
    const [[config]] = await executor.execute('SELECT * FROM employee_id_config WHERE id = 1 FOR UPDATE');
    const nextSequence = Math.max(Number(config.current_sequence || 0) + 1, Number(config.starting_number || 1));
    await executor.execute('UPDATE employee_id_config SET current_sequence = ? WHERE id = 1', [nextSequence]);
    return formatEmployeeCode(nextSequence, config);
  }

  const config = await getEmployeeIdConfig(executor);
  const nextSequence = Math.max(Number(config.current_sequence || 0) + 1, Number(config.starting_number || 1));
  return formatEmployeeCode(nextSequence, config);
}

function personLabel(row) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return name ? `${name} (${row.employee_code || row.applicant_code || 'no code'})` : (row.employee_code || row.applicant_code || 'existing record');
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

// Employees
app.get('/api/employees/next-code', requireAuth, requireRole([...ROLES.staff_management, ...ROLES.admin_any]), async (_req, res) => {
  try {
    const pool = require('./config/db');
    const config = await getEmployeeIdConfig(pool);
    const employeeCode = await generateNextEmployeeCode(pool);
    res.json({ employee_code: employeeCode, config });
  } catch (err) {
    console.error('Error generating next employee code:', err);
    res.status(500).json({ error: 'Failed to generate employee code.' });
  }
});

app.get('/api/employees/id-config', requireAuth, requireRole(EMPLOYEE_ID_ADMIN_ROLES), async (_req, res) => {
  try {
    const pool = require('./config/db');
    const config = await getEmployeeIdConfig(pool);
    res.json(config);
  } catch (err) {
    console.error('Error loading employee ID config:', err);
    res.status(500).json({ error: 'Failed to load employee ID configuration.' });
  }
});

app.put('/api/employees/id-config', requireAuth, requireRole(EMPLOYEE_ID_ADMIN_ROLES), async (req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeIdConfigSchema(pool);

    const prefix = sanitizeEmployeeCode(req.body.prefix || 'EMP');
    const startingNumber = Number(req.body.starting_number || 1);
    const numberPadding = Number(req.body.number_padding || 6);
    const currentSequence = Number(req.body.current_sequence || 0);
    const autoGenerateEnabled = req.body.auto_generate_enabled === false || req.body.auto_generate_enabled === '0' ? 0 : 1;

    if (!prefix || !/^[A-Z0-9_-]+$/i.test(prefix)) {
      return res.status(400).json({ error: 'Prefix can only contain letters, numbers, hyphens, and underscores.' });
    }
    if (prefix.length > 12) return res.status(400).json({ error: 'Prefix is too long.' });
    if (!Number.isInteger(startingNumber) || startingNumber < 1) return res.status(400).json({ error: 'Starting number must be greater than zero.' });
    if (!Number.isInteger(numberPadding) || numberPadding < 1 || numberPadding > 12) return res.status(400).json({ error: 'Number padding must be between 1 and 12.' });
    if (!Number.isInteger(currentSequence) || currentSequence < 0) return res.status(400).json({ error: 'Current sequence must be zero or greater.' });

    if (autoGenerateEnabled) {
      await ensureOnboardingLifecycleSchema(pool);
      const nextSequence = Math.max(currentSequence + 1, startingNumber);
      const nextEmployeeCode = formatEmployeeCode(nextSequence, {
        prefix,
        number_padding: numberPadding,
      });
      const duplicate = await findEmployeeIntakeDuplicate(pool, nextEmployeeCode, 'employee-id-config-check@example.invalid');
      if (duplicate?.field === 'employee_code') {
        return res.status(400).json({
          error: `Employee ID configuration would generate duplicate ID ${nextEmployeeCode}. Increase the current sequence or use a different prefix.`,
          next_employee_code: nextEmployeeCode,
        });
      }
    }

    const [[oldConfig]] = await pool.execute('SELECT * FROM employee_id_config WHERE id = 1');
    await pool.execute(
      `UPDATE employee_id_config
          SET prefix = ?, starting_number = ?, number_padding = ?, current_sequence = ?, auto_generate_enabled = ?
        WHERE id = 1`,
      [prefix, startingNumber, numberPadding, currentSequence, autoGenerateEnabled]
    );
    const config = await getEmployeeIdConfig(pool);
    await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_ID_CONFIGURATION_UPDATED', null, oldConfig, config);
    res.json({ message: 'Employee ID configuration saved.', config });
  } catch (err) {
    console.error('Error saving employee ID config:', err);
    res.status(500).json({ error: 'Failed to save employee ID configuration.' });
  }
});

app.get('/api/employees/code-available/:code', requireAuth, requireRole(EMPLOYEE_ID_ADMIN_ROLES), async (req, res) => {
  try {
    const pool = require('./config/db');
    const code = sanitizeEmployeeCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Employee ID is required.' });
    if (!isValidEmployeeCode(code)) return res.status(400).json({ error: 'Employee ID can only contain letters, numbers, hyphens, and underscores.' });
    await ensureOnboardingLifecycleSchema(pool);
    const duplicate = await findEmployeeIntakeDuplicate(pool, code, 'employee-code-check-placeholder@example.invalid');
    res.json({ available: !duplicate || duplicate.field !== 'employee_code' });
  } catch (err) {
    console.error('Error checking employee code:', err);
    res.status(500).json({ error: 'Failed to check employee ID.' });
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

async function ensureEmployeeLifecycleColumns(pool) {
  const columns = [
    ['hiring_type', "ENUM('Direct Hire','Agency-Hired') NULL DEFAULT 'Direct Hire'"],
    ['agency_name', 'VARCHAR(180) NULL'],
    ['agency_contact_person', 'VARCHAR(180) NULL'],
    ['agency_contact_number', 'VARCHAR(80) NULL'],
    ['deployment_status', "ENUM('Pending Deployment','Deployed','On Hold','Ended') NULL DEFAULT 'Pending Deployment'"],
    ['contract_start_date', 'DATE NULL'],
    ['contract_end_date', 'DATE NULL'],
    ['lifecycle_status', "ENUM('Active','Pending Onboarding','Pending Training','On Hold') NULL DEFAULT 'Active'"],
  ];

  for (const [name, definition] of columns) {
    const [existing] = await pool.execute(`SHOW COLUMNS FROM employees LIKE '${name}'`);
    if (!existing.length) {
      await pool.execute(`ALTER TABLE employees ADD COLUMN ${name} ${definition}`);
    }
  }

  const [wageRateActive] = await pool.execute("SHOW COLUMNS FROM employee_wage_rates LIKE 'is_active'");
  if (!wageRateActive.length) {
    await pool.execute('ALTER TABLE employee_wage_rates ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1');
  }
}

async function ensureOnboardingLifecycleSchema(pool) {
  await ensureEmployeeLifecycleColumns(pool);

  await pool.execute(`
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

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS onboarding_applicant (
      applicant_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      applicant_code VARCHAR(24) NOT NULL UNIQUE,
      intended_employee_code VARCHAR(20) NULL,
      source_module VARCHAR(60) NOT NULL DEFAULT 'ONBOARDING',
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
        'For Onboarding','Under Screening','Pending Screening','Screening','Training',
        'For Approval','Approved','Rejected','For Re-evaluation','On Hold','Transferred'
      ) NOT NULL DEFAULT 'Under Screening',
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
      FOREIGN KEY (converted_employee_id) REFERENCES employees(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
      INDEX idx_onboarding_workflow (workflow_status, created_at),
      INDEX idx_onboarding_screening (screening_status, training_status),
      INDEX idx_onboarding_email_hash (email_hash),
      INDEX idx_onboarding_deleted (deleted_at)
    )
  `);

  await pool.execute(`
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

  await pool.execute(`
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

  await pool.execute(`
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
    await pool.execute(
      `INSERT INTO onboarding_position_route
         (position_name, requires_onboarding, requires_training)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         position_name = VALUES(position_name)`,
      [position, requiresOnboarding, requiresTraining]
    );
  }
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

app.post('/api/employee-setup/departments', requireAuth, requireRole([...ROLES.staff_management, ...ROLES.admin_any]), async (req, res) => {
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

app.put('/api/employee-setup/departments/:id', requireAuth, requireRole([...ROLES.staff_management, ...ROLES.admin_any]), async (req, res) => {
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

app.delete('/api/employee-setup/departments/:id', requireAuth, requireRole([...ROLES.staff_management, ...ROLES.admin_any]), async (req, res) => {
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

app.post('/api/employee-setup/positions', requireAuth, requireRole([...ROLES.staff_management, ...ROLES.admin_any]), async (req, res) => {
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

app.put('/api/employee-setup/positions/:id', requireAuth, requireRole([...ROLES.staff_management, ...ROLES.admin_any]), async (req, res) => {
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

app.delete('/api/employee-setup/positions/:id', requireAuth, requireRole([...ROLES.staff_management, ...ROLES.admin_any]), async (req, res) => {
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
    await ensureEmployeeLifecycleColumns(pool);
    await ensurePhilippineAddressColumns(pool);
    const [rows] = await pool.execute(
      `SELECT e.id, e.employee_code, e.first_name, e.middle_name, e.last_name, e.suffix, e.email, e.contact_number, 
              e.work_email, e.mailing_address, e.mailing_address_lat, e.mailing_address_lng, e.mailing_address_same_as_home,
              e.mailing_address_region, e.mailing_address_province, e.mailing_address_city_municipality, e.mailing_address_barangay,
              e.mailing_address_street_address, e.mailing_address_full_address, e.mailing_address_place_id,
              e.nationality, e.date_of_birth, e.place_of_birth, e.gender, e.marital_status, e.blood_type, e.religion,
              e.residential_address, e.residential_address_lat, e.residential_address_lng,
              e.residential_address_region, e.residential_address_province, e.residential_address_city_municipality, e.residential_address_barangay,
              e.residential_address_street_address, e.residential_address_full_address, e.residential_address_place_id,
              e.current_address, e.current_address_lat, e.current_address_lng, e.current_address_same_as_home,
              e.current_address_region, e.current_address_province, e.current_address_city_municipality, e.current_address_barangay,
              e.current_address_street_address, e.current_address_full_address, e.current_address_place_id,
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
app.post('/api/employees', requireAuth, requireRole([...ROLES.staff_management, ...ROLES.admin_any]), EMPLOYEE_PARAMETER_TAMPER_GUARD, async (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json');
    
    const pool = require('./config/db');
    await ensureOnboardingLifecycleSchema(pool);
    await ensurePhilippineAddressColumns(pool);
    await ensureEmployeeAuthColumns(pool);
    const validationResponse = await validateEmployeeRequestBody(req, res, pool, { mode: 'create' });
    if (validationResponse) return validationResponse;
    const { employee_id_mode, employee_code, first_name, middle_name, last_name, suffix, email, contact_number, work_email, mailing_address, nationality, marital_status, date_of_birth, place_of_birth, gender, blood_type, religion, residential_address, current_address, emergency_contact_name, emergency_contact_num, emergency_contact_relationship, emergency_contact_secondary_num, emergency_contact_email, emergency_contact_address, education_school, education_attainment, education_units, education_year_graduated, education_jhs_school, education_jhs_attainment, education_jhs_from, education_jhs_to, education_jhs_year_graduated, education_shs_school, education_shs_attainment, education_shs_from, education_shs_to, education_shs_year_graduated, education_vocational_school, education_vocational_attainment, education_vocational_units, education_vocational_from, education_vocational_to, education_vocational_year_graduated, education_college_school, education_college_attainment, education_college_units, education_college_from, education_college_to, education_college_year_graduated, department_id, position, employment_type, date_hired, end_of_contract, supervisor, work_location, shift_schedule, employee_level, employment_history, status, wage_type, base_rate, sewingRates, salary_grade, allowances, payroll_schedule, sss_number, philhealth_number, pagibig_number, tin, tax_status, bank_name, bank_account, hiring_type, agency_name, agency_contact_person, agency_contact_number, deployment_status, contract_start_date, contract_end_date, requires_onboarding, requires_training, lifecycle_action, lifecycle_note } = req.body;
    
    console.log('\n=== POST /api/employees ===');
    console.log('User role:', req.user.role);
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    console.log('Payroll data received:', { wage_type, base_rate, sewingRates });
    
    if (!first_name || !last_name || !email) {
      console.error('❌ Missing required fields');
      return res.status(400).json({ error: 'First name, last name, and email are required.' });
    }
    
    const employeeIdMode = employee_id_mode === 'manual' ? 'manual' : 'auto';
    let finalEmployeeCode = sanitizeEmployeeCode(employee_code);
    if (employeeIdMode === 'manual') {
      if (!finalEmployeeCode) {
        console.error('❌ Missing employee_code');
        return res.status(400).json({ error: 'Employee ID is required when using an existing employee ID.' });
      }
      if (!isValidEmployeeCode(finalEmployeeCode)) {
        return res.status(400).json({ error: 'Employee ID can only contain letters, numbers, hyphens, and underscores.' });
      }
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

    if (employeeIdMode === 'auto') {
      const codeConnection = await pool.getConnection();
      try {
        await codeConnection.beginTransaction();
        finalEmployeeCode = await generateNextEmployeeCode(codeConnection, true);
        await codeConnection.commit();
      } catch (error) {
        await codeConnection.rollback();
        throw error;
      } finally {
        codeConnection.release();
      }
    }

    if (shouldRouteToOnboarding) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const duplicate = await findEmployeeIntakeDuplicate(connection, finalEmployeeCode, email);
        if (duplicate) {
          await connection.rollback();
          if (duplicate.field === 'employee_code') {
            await writeEmployeeLifecycleAudit(pool, req, `DUPLICATE_EMPLOYEE_ID_ATTEMPT [${finalEmployeeCode}]`, null, null, {
              employee_code: finalEmployeeCode,
              mode: employeeIdMode,
              source: duplicate.source,
            });
            return res.status(409).json({ error: 'Employee ID already exists.', duplicate: { field: 'employee_code' } });
          }
          return res.status(409).json(await employeeIntakeDuplicatePayload(connection, duplicate));
        }

        const onboardingResult = await onboardingRoutes.createOnboardingApplicantRecord(connection, req, {
          ...req.body,
          employee_code: finalEmployeeCode,
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
          intendedEmployeeCode: finalEmployeeCode,
        });
        await writeEmployeeLifecycleAudit(connection, req, `EMPLOYEE_RECORD_ROUTED_TO_ONBOARDING [${finalEmployeeCode}]`, null, null, {
          employee_code: finalEmployeeCode,
          applicant_id: onboardingResult.applicant_id,
          position,
          lifecycle_action: normalizedLifecycleAction,
          lifecycle_note: normalizedLifecycleNote || null,
          requires_training: onboardingRequiresTraining,
          route_source: route.source || 'position_route',
          workflow_status: onboardingResult.workflow_status,
        });
        await writeEmployeeLifecycleAudit(connection, req, employeeIdMode === 'manual' ? 'EXISTING_EMPLOYEE_ID_ENTERED' : 'EMPLOYEE_ID_AUTO_GENERATED', null, null, {
          employee_code: finalEmployeeCode,
          mode: employeeIdMode,
        });
        await connection.commit();
        return res.status(201).json({
          ...onboardingResult,
          id: null,
          employee_code: finalEmployeeCode,
          routed_to: 'onboarding',
          message: normalizedLifecycleAction === 'ON_HOLD'
            ? `${finalEmployeeCode} placed on hold in onboarding for HR review.`
            : `${finalEmployeeCode} routed to onboarding for ${position}.`,
        });
      } catch (error) {
        await connection.rollback();
        return res.status(400).json({ error: error.message });
      } finally {
        connection.release();
      }
    }

    const duplicate = await findEmployeeIntakeDuplicate(pool, finalEmployeeCode, email);
    if (duplicate) {
      if (duplicate.field === 'employee_code') {
        await writeEmployeeLifecycleAudit(pool, req, `DUPLICATE_EMPLOYEE_ID_ATTEMPT [${finalEmployeeCode}]`, null, null, {
          employee_code: finalEmployeeCode,
          mode: employeeIdMode,
          source: duplicate.source,
        });
        return res.status(409).json({ error: 'Employee ID already exists.', duplicate: { field: 'employee_code' } });
      }
      return res.status(409).json(await employeeIntakeDuplicatePayload(pool, duplicate));
    }

    console.log('Executing INSERT for:', { employee_code: finalEmployeeCode, first_name, last_name, email });
    const generatedTemporaryPassword = nodeCrypto.randomBytes(24).toString('base64');
    const employeePasswordHash = await hashTemporaryPassword(generatedTemporaryPassword);
    
    const [result] = await pool.execute(
      `INSERT INTO employees (employee_code, first_name, middle_name, last_name, suffix, email, contact_number, work_email, mailing_address, nationality, marital_status, date_of_birth, place_of_birth, gender, blood_type, religion, residential_address, current_address, emergency_contact_name, emergency_contact_num, emergency_contact_relationship, emergency_contact_secondary_num, emergency_contact_email, emergency_contact_address, education_school, education_attainment, education_units, education_year_graduated, education_jhs_school, education_jhs_attainment, education_jhs_from, education_jhs_to, education_jhs_year_graduated, education_shs_school, education_shs_attainment, education_shs_from, education_shs_to, education_shs_year_graduated, education_vocational_school, education_vocational_attainment, education_vocational_units, education_vocational_from, education_vocational_to, education_vocational_year_graduated, education_college_school, education_college_attainment, education_college_units, education_college_from, education_college_to, education_college_year_graduated, department_id, position, employment_type, date_hired, end_of_contract, supervisor, work_location, shift_schedule, employee_level, employment_history, status, salary_grade, allowances, payroll_schedule, sss_number, philhealth_number, pagibig_number, tin, tax_status, bank_name, bank_account, Password_Hash, Password_Changed_At, Failed_Login_Attempts, force_password_change)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 0, 1)`,
      [finalEmployeeCode, first_name, middle_name || null, last_name, suffix || null, email, contact_number || null, work_email || null, addresses.mailing.address || null, nationality || 'Filipino', marital_status || null, date_of_birth || null, place_of_birth || null, gender || null, blood_type || null, religion || null, addresses.home.address || null, addresses.current.address || null, emergency_contact_name || null, emergency_contact_num || null, emergency_contact_relationship || null, emergency_contact_secondary_num || null, emergency_contact_email || null, emergency_contact_address || null, education_school || null, education_attainment || null, education_units || null, education_year_graduated || null, education_jhs_school || null, education_jhs_attainment || null, education_jhs_from || null, education_jhs_to || null, education_jhs_year_graduated || null, education_shs_school || null, education_shs_attainment || null, education_shs_from || null, education_shs_to || null, education_shs_year_graduated || null, education_vocational_school || null, education_vocational_attainment || null, education_vocational_units || null, education_vocational_from || null, education_vocational_to || null, education_vocational_year_graduated || null, education_college_school || null, education_college_attainment || null, education_college_units || null, education_college_from || null, education_college_to || null, education_college_year_graduated || null, department_id || null, position || null, normalizedEmploymentType, date_hired || null, directoryEndOfContract, supervisor || null, work_location || null, shift_schedule || null, employee_level || null, employment_history || null, status || 'Active', salary_grade || null, allowances || null, payroll_schedule || null, sss_number || null, philhealth_number || null, pagibig_number || null, tin || null, tax_status || null, bank_name || null, bank_account || null, employeePasswordHash]
    );
    
    const employee_id = result.insertId;
    await pool.execute(
      `UPDATE employees SET
         residential_address_lat = ?, residential_address_lng = ?,
         residential_address_region = ?, residential_address_province = ?, residential_address_city_municipality = ?,
         residential_address_barangay = ?, residential_address_street_address = ?, residential_address_full_address = ?, residential_address_place_id = ?,
         current_address_lat = ?, current_address_lng = ?, current_address_same_as_home = ?,
         current_address_region = ?, current_address_province = ?, current_address_city_municipality = ?,
         current_address_barangay = ?, current_address_street_address = ?, current_address_full_address = ?, current_address_place_id = ?,
         mailing_address_lat = ?, mailing_address_lng = ?, mailing_address_same_as_home = ?
         , mailing_address_region = ?, mailing_address_province = ?, mailing_address_city_municipality = ?,
         mailing_address_barangay = ?, mailing_address_street_address = ?, mailing_address_full_address = ?, mailing_address_place_id = ?
       WHERE id = ?`,
      [
        addresses.home.lat, addresses.home.lng,
        addresses.home.region, addresses.home.province, addresses.home.city_municipality,
        addresses.home.barangay, addresses.home.street_address, addresses.home.full_address || addresses.home.address, addresses.home.place_id || null,
        addresses.current.lat, addresses.current.lng, addresses.sameCurrent ? 1 : 0,
        addresses.current.region, addresses.current.province, addresses.current.city_municipality,
        addresses.current.barangay, addresses.current.street_address, addresses.current.full_address || addresses.current.address, addresses.current.place_id || null,
        addresses.mailing.lat, addresses.mailing.lng, addresses.sameMailing ? 1 : 0,
        addresses.mailing.region, addresses.mailing.province, addresses.mailing.city_municipality,
        addresses.mailing.barangay, addresses.mailing.street_address, addresses.mailing.full_address || addresses.mailing.address, addresses.mailing.place_id || null,
        employee_id
      ]
    );

    const piiUpdateFields = [
      'hiring_type = ?',
      'agency_name = ?',
      'agency_contact_person = ?',
      'agency_contact_number = ?',
      'deployment_status = ?',
      'contract_start_date = ?',
      'contract_end_date = ?',
      "lifecycle_status = 'Active'"
    ];
    const piiUpdateValues = [
      normalizedHiringType,
      normalizedHiringType === 'Agency-Hired' ? agency_name || null : null,
      normalizedHiringType === 'Agency-Hired' ? agency_contact_person || null : null,
      normalizedHiringType === 'Agency-Hired' ? agency_contact_number || null : null,
      normalizedDeploymentStatus,
      normalizedContractStartDate,
      normalizedContractEndDate
    ];
    if (await employeeColumnExists(pool, 'encrypted_pii')) {
      piiUpdateFields.unshift('encrypted_pii = ?');
      piiUpdateValues.unshift(encryptPII({
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
      }));
    }
    await pool.execute(
      `UPDATE employees SET ${piiUpdateFields.join(', ')} WHERE id = ?`,
      [...piiUpdateValues, employee_id]
    );
    await writeEmployeeLifecycleAudit(pool, req, `EMPLOYEE_RECORD_CREATED_DIRECT [${finalEmployeeCode}]`, employee_id, null, {
      employee_code: finalEmployeeCode,
      position,
      route_source: route.source || 'position_route',
      lifecycle_action: normalizedLifecycleAction,
      lifecycle_note: normalizedLifecycleNote || null,
      hiring_type: normalizedHiringType,
      lifecycle_status: 'Active',
    });
    await writeEmployeeLifecycleAudit(pool, req, employeeIdMode === 'manual' ? 'EXISTING_EMPLOYEE_ID_ENTERED' : 'EMPLOYEE_ID_AUTO_GENERATED', employee_id, null, {
      employee_code: finalEmployeeCode,
      mode: employeeIdMode,
    });
    console.log('✅ Employee inserted successfully!');
    console.log('Insert result:', { insertId: employee_id, affectedRows: result.affectedRows });
    console.log('Employee Code:', finalEmployeeCode);
    
    // Save wage configuration if provided
    if (wage_type) {
      try {
        console.log('💾 Saving wage configuration for new employee...');
        
        const wage_type_id = await resolveWageTypeId(pool, wage_type);
        
        if (wage_type_id) {
          
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
      employee_code: finalEmployeeCode, 
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
      if (err.sqlMessage && err.sqlMessage.includes('employee_code')) {
        return res.status(409).json({ error: 'Employee ID already exists.' });
      }
      let nextEmployeeCode = null;
      try {
        nextEmployeeCode = await generateNextEmployeeCode(require('./config/db'));
      } catch (codeError) {
        console.warn('Unable to include next employee code in duplicate response:', codeError.message);
      }
      return res.status(409).json({
        error: 'Employee code or email was just used by another record. Please refresh the Employee ID and check the email address.',
        next_employee_code: nextEmployeeCode,
      });
    }
    return res.status(500).json({ error: 'Failed to add employee.' }); 
  }
});

// Update Employee
app.put('/api/employees/:id', requireAuth, requireRole([...ROLES.staff_management, ...ROLES.admin_any]), EMPLOYEE_PARAMETER_TAMPER_GUARD, async (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json');
    
    const pool = require('./config/db');
    await ensureEmployeeLifecycleColumns(pool);
    await ensurePhilippineAddressColumns(pool);
    const { id } = req.params; // numeric employee id
    const validationResponse = await validateEmployeeRequestBody(req, res, pool, { mode: 'update' });
    if (validationResponse) return validationResponse;
    const { employee_code, first_name, middle_name, last_name, suffix, email, contact_number, work_email, mailing_address, nationality, marital_status, date_of_birth, place_of_birth, gender, blood_type, religion, residential_address, current_address, emergency_contact_name, emergency_contact_num, emergency_contact_relationship, emergency_contact_secondary_num, emergency_contact_email, emergency_contact_address, education_school, education_attainment, education_units, education_year_graduated, education_jhs_school, education_jhs_attainment, education_jhs_from, education_jhs_to, education_jhs_year_graduated, education_shs_school, education_shs_attainment, education_shs_from, education_shs_to, education_shs_year_graduated, education_vocational_school, education_vocational_attainment, education_vocational_units, education_vocational_from, education_vocational_to, education_vocational_year_graduated, education_college_school, education_college_attainment, education_college_units, education_college_from, education_college_to, education_college_year_graduated, department_id, position, employment_type, hiring_type, agency_name, agency_contact_person, agency_contact_number, deployment_status, contract_start_date, contract_end_date, date_hired, end_of_contract, supervisor, work_location, shift_schedule, employee_level, employment_history, status, wage_type, base_rate, sewingRates, salary_grade, allowances, payroll_schedule, sss_number, philhealth_number, pagibig_number, tin, tax_status, bank_name, bank_account } = req.body;
    
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

    const [existingEmployeeRows] = await pool.execute(
      'SELECT id, employee_code FROM employees WHERE id = ? OR employee_code = ? LIMIT 1',
      [id, id]
    );
    const existingEmployee = existingEmployeeRows[0] || null;
    const requestedEmployeeCode = sanitizeEmployeeCode(employee_code);
    const shouldChangeEmployeeCode = requestedEmployeeCode && existingEmployee && requestedEmployeeCode !== existingEmployee.employee_code;
    if (shouldChangeEmployeeCode) {
      if (!isValidEmployeeCode(requestedEmployeeCode)) {
        return res.status(400).json({ error: 'Employee ID can only contain letters, numbers, hyphens, and underscores.' });
      }
      const [codeRows] = await pool.execute(
        'SELECT id FROM employees WHERE employee_code = ? AND id <> ? LIMIT 1',
        [requestedEmployeeCode, existingEmployee.id]
      );
      if (codeRows.length) {
        await writeEmployeeLifecycleAudit(pool, req, `DUPLICATE_EMPLOYEE_ID_ATTEMPT [${requestedEmployeeCode}]`, existingEmployee.id, null, {
          employee_code: requestedEmployeeCode,
          mode: 'manual_update',
        });
        return res.status(409).json({ error: 'Employee ID already exists.', duplicate: { field: 'employee_code' } });
      }
    }

    const hasAgencyDetails = !!(
      String(agency_name || '').trim() ||
      String(agency_contact_person || '').trim() ||
      String(agency_contact_number || '').trim() ||
      contract_start_date ||
      contract_end_date ||
      (deployment_status && deployment_status !== 'Pending Deployment') ||
      employment_type === 'Contractual'
    );
    const normalizedHiringType = hiring_type === 'Agency-Hired' || hasAgencyDetails ? 'Agency-Hired' : 'Direct Hire';
    const agencyNameValue = normalizedHiringType === 'Agency-Hired' ? agency_name || null : null;
    const agencyContactPersonValue = normalizedHiringType === 'Agency-Hired' ? agency_contact_person || null : null;
    const agencyContactNumberValue = normalizedHiringType === 'Agency-Hired' ? agency_contact_number || null : null;
    const deploymentStatusValue = normalizedHiringType === 'Agency-Hired' ? deployment_status || 'Pending Deployment' : null;
    const contractStartValue = normalizedHiringType === 'Agency-Hired' ? contract_start_date || null : null;
    const contractEndValue = normalizedHiringType === 'Agency-Hired' ? contract_end_date || end_of_contract || null : null;
    const directoryEndOfContract = contractEndValue || end_of_contract || null;

    console.log('Executing UPDATE for:', { id, first_name, last_name, email, department_id, position, supervisor, work_location, hiring_type: normalizedHiringType, agency_name: agencyNameValue });

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
        department_id=?, position=?, employment_type=?, hiring_type=?, agency_name=?, agency_contact_person=?, agency_contact_number=?, deployment_status=?, contract_start_date=?, contract_end_date=?,
        date_hired=?, end_of_contract=?, supervisor=?, work_location=?, shift_schedule=?, employee_level=?, employment_history=?, status=?,
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
       employment_type || 'Regular', normalizedHiringType, agencyNameValue, agencyContactPersonValue, agencyContactNumberValue, deploymentStatusValue, contractStartValue, contractEndValue,
       date_hired || null, directoryEndOfContract, supervisor || null, work_location || null, shift_schedule || null, employee_level || null, employment_history || null, status || 'Active',
       salary_grade || null, allowances || null, payroll_schedule || null,
       sss_number || null, philhealth_number || null, pagibig_number || null, tin || null, tax_status || null, bank_name || null, bank_account || null, id, id]
    );
    
    console.log('✅ UPDATE executed');
    await pool.execute(
      `UPDATE employees SET
         residential_address_lat = ?, residential_address_lng = ?,
         residential_address_region = ?, residential_address_province = ?, residential_address_city_municipality = ?,
         residential_address_barangay = ?, residential_address_street_address = ?, residential_address_full_address = ?, residential_address_place_id = ?,
         current_address_lat = ?, current_address_lng = ?, current_address_same_as_home = ?,
         current_address_region = ?, current_address_province = ?, current_address_city_municipality = ?,
         current_address_barangay = ?, current_address_street_address = ?, current_address_full_address = ?, current_address_place_id = ?,
         mailing_address_lat = ?, mailing_address_lng = ?, mailing_address_same_as_home = ?
         , mailing_address_region = ?, mailing_address_province = ?, mailing_address_city_municipality = ?,
         mailing_address_barangay = ?, mailing_address_street_address = ?, mailing_address_full_address = ?, mailing_address_place_id = ?
       WHERE id = ? OR employee_code = ?`,
      [
        addresses.home.lat, addresses.home.lng,
        addresses.home.region, addresses.home.province, addresses.home.city_municipality,
        addresses.home.barangay, addresses.home.street_address, addresses.home.full_address || addresses.home.address, addresses.home.place_id || null,
        addresses.current.lat, addresses.current.lng, addresses.sameCurrent ? 1 : 0,
        addresses.current.region, addresses.current.province, addresses.current.city_municipality,
        addresses.current.barangay, addresses.current.street_address, addresses.current.full_address || addresses.current.address, addresses.current.place_id || null,
        addresses.mailing.lat, addresses.mailing.lng, addresses.sameMailing ? 1 : 0,
        addresses.mailing.region, addresses.mailing.province, addresses.mailing.city_municipality,
        addresses.mailing.barangay, addresses.mailing.street_address, addresses.mailing.full_address || addresses.mailing.address, addresses.mailing.place_id || null,
        id, id
      ]
    );

    console.log('Rows affected:', result.affectedRows);
    console.log('Change count:', result.changedRows);
    
    if (result.affectedRows === 0) {
      console.error('❌ No rows updated! Employee ID might not exist:', id);
      return res.status(404).json({ error: 'Employee not found.' });
    }

    if (shouldChangeEmployeeCode) {
      await pool.execute('UPDATE employees SET employee_code = ? WHERE id = ?', [requestedEmployeeCode, existingEmployee.id]);
      await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_ID_CHANGED', existingEmployee.id, {
        employee_code: existingEmployee.employee_code,
      }, {
        employee_code: requestedEmployeeCode,
      });
    }

    // Save wage configuration if provided
    if (wage_type) {
      try {
        console.log('💾 Saving wage configuration...');
        
        const wage_type_id = await resolveWageTypeId(pool, wage_type);
        
        if (wage_type_id) {
          
          // Update employee wage_type_id
          await pool.execute(
            'UPDATE employees SET wage_type_id = ? WHERE id = ?',
            [wage_type_id, id]
          );
          
          console.log('✅ Updated employee wage_type_id to:', wage_type_id);
          
          const hasBaseRateInput = Object.prototype.hasOwnProperty.call(req.body, 'base_rate');

          // Save base rate for all wage types (or per-piece primary rate). If the user
          // clears the field, end the active wage rate so the old value stops showing.
          if (hasBaseRateInput && (base_rate === null || base_rate === '')) {
            await pool.execute(
              'UPDATE employee_wage_rates SET end_date = NOW() WHERE employee_id = ? AND end_date IS NULL',
              [id]
            );
            console.log('✅ Cleared active base rate for employee:', id);
          } else if (base_rate !== undefined && base_rate !== null && base_rate !== '') {
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
    return res.status(500).json({ error: 'Failed to update employee.' }); 
  }
});

// Update Employee Status
app.patch('/api/employees/:id/status', requireAuth, requireRole(ROLES.staff_management), EMPLOYEE_PARAMETER_TAMPER_GUARD, async (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json');
    const pool = require('./config/db');
    const { id } = req.params; // id = numeric employee id
    const { status } = req.body;

    if (!status || !['Active', 'Inactive'].includes(status)) {
      await auditSecurityEvent(req, {
        action: 'blocked_employee_invalid_status',
        module: 'EMPLOYEE_SECURITY',
        targetTable: 'employees',
        targetRecord: id,
        newValue: { field: 'status', value: status, path: req.originalUrl },
        result: 'blocked',
      });
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
    return res.status(500).json({ error: 'Failed to update employee status.' });
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
    return res.status(500).json({ error: 'Failed to delete employee.' });
  }
});

// Upload employee document
app.post('/api/employees/:id/documents', requireAuth, requireRole(ROLES.staff_management), EMPLOYEE_PARAMETER_TAMPER_GUARD, uploadSingle('file'), async (req, res) => {
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
    return res.status(500).json({ error: 'Failed to upload document.' });
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
    return res.status(500).json({ error: 'Failed to fetch documents.' });
  }
});

// View employee document
app.get('/api/employees/:id/documents/:docId/view', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id, docId } = req.params;

    const [empRows] = await pool.execute('SELECT id FROM employees WHERE employee_code = ?', [id]);
    if (empRows.length === 0) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    const [docs] = await pool.execute(
      `SELECT file_name, file_path
         FROM documents
        WHERE id = ? AND employee_id = ?
        LIMIT 1`,
      [docId, empRows[0].id]
    );

    if (!docs.length || !docs[0].file_path) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    const relativePath = String(docs[0].file_path || '').replace(/^\/+/, '');
    const absolutePath = path.resolve(__dirname, 'public', relativePath);
    const uploadsRoot = path.resolve(__dirname, 'public', 'uploads');

    if (!absolutePath.startsWith(uploadsRoot + path.sep) || !fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'Document file not found.' });
    }

    res.setHeader('Content-Disposition', `inline; filename="${path.basename(docs[0].file_name || absolutePath).replace(/"/g, '')}"`);
    return res.sendFile(absolutePath);
  } catch (err) {
    console.error('Error viewing document:', err.message);
    return res.status(500).json({ error: 'Failed to view document.' });
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
    return res.status(500).json({ error: 'Failed to delete document.' });
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
app.post('/api/employees/:id/photo', requireAuth, requireRole(ROLES.staff_management), EMPLOYEE_PARAMETER_TAMPER_GUARD, uploadSingle('photo'), async (req, res) => {
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
    return res.status(500).json({ error: 'Failed to upload photo.' });
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
    return res.status(500).json({ error: 'Failed to fetch photo.' });
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
    return res.status(500).json({ error: 'Failed to delete photo.' });
  }
});

const LEAVE_PERMISSION_ROLES = {
  'leave.request.create': ['employee', 'hr_admin', 'hr_manager', 'admin', 'system_admin'],
  'leave.request.view_own': ['employee', 'hr_admin', 'hr_manager', 'admin', 'system_admin', 'payroll_officer', 'payroll_manager'],
  'leave.manual.create': ['hr_admin', 'hr_manager', 'admin', 'system_admin'],
  'leave.request.approve': ROLES.hr_final_approval,
  'leave.request.view_all': ['hr_admin', 'hr_manager', 'admin', 'system_admin', 'payroll_officer', 'payroll_manager'],
  'leave.balance.manage': ['hr_admin', 'hr_manager', 'admin', 'system_admin'],
  'leave.report.view': ['hr_admin', 'hr_manager', 'admin', 'system_admin', 'payroll_officer', 'payroll_manager'],
  'leave.audit.view': ['hr_admin', 'hr_manager', 'admin', 'system_admin', 'payroll_officer', 'payroll_manager']
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
  return getConfiguredLeaveBalance(pool, employeeId, leaveType, year);
}

async function getConfiguredLeaveBalance(executor, employeeId, leaveType, year, lock = false) {
  const [rows] = await executor.execute(
    `SELECT *,
            COALESCE(NULLIF(total_days, 0), balance, 0) AS total_days_value,
            COALESCE(NULLIF(used_days, 0), used, 0) AS used_days_value,
            COALESCE(remaining_days, COALESCE(NULLIF(total_days, 0), balance, 0) - COALESCE(NULLIF(used_days, 0), used, 0)) AS remaining_days_value
       FROM leave_balances
      WHERE employee_id = ?
        AND year = ?
        AND (leave_type_id = ? OR leave_type = ?)
      LIMIT 1
      ${lock ? 'FOR UPDATE' : ''}`,
    [employeeId, year, leaveType.id, leaveType.name]
  );
  return rows[0] || null;
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
                    reviewer.username AS reviewed_by_name,
                    COALESCE(NULLIF(lb.total_days, 0), lb.balance, 0) AS balance_total_days,
                    COALESCE(NULLIF(lb.used_days, 0), lb.used, 0) AS balance_used_days,
                    COALESCE(lb.remaining_days, COALESCE(NULLIF(lb.total_days, 0), lb.balance, 0) - COALESCE(NULLIF(lb.used_days, 0), lb.used, 0)) AS balance_remaining_days
             FROM leave_requests lr
             JOIN employees e ON e.id = lr.employee_id
             LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
             LEFT JOIN leave_balances lb
               ON lb.employee_id = lr.employee_id
              AND lb.year = YEAR(lr.date_from)
              AND (lb.leave_type_id = lt.id OR lb.leave_type = COALESCE(lt.name, lr.type))
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

    const [rows] = await pool.execute(
      `SELECT lb.id, lb.employee_id, lb.leave_type_id, lb.leave_type, lt.category,
              COALESCE(NULLIF(lb.total_days, 0), lb.balance, 0) AS total_days,
              COALESCE(NULLIF(lb.used_days, 0), lb.used, 0) AS used_days,
              COALESCE(lb.remaining_days, COALESCE(NULLIF(lb.total_days, 0), lb.balance, 0) - COALESCE(NULLIF(lb.used_days, 0), lb.used, 0)) AS remaining_days,
              COALESCE(NULLIF(lb.total_days, 0), lb.balance, 0) AS balance,
              COALESCE(NULLIF(lb.used_days, 0), lb.used, 0) AS used,
              COALESCE(lb.remaining_days, COALESCE(NULLIF(lb.total_days, 0), lb.balance, 0) - COALESCE(NULLIF(lb.used_days, 0), lb.used, 0)) AS remaining,
              lb.year, lb.updated_at, updater.username AS last_updated_by_name
       FROM leave_balances lb
       LEFT JOIN leave_types lt ON lt.id = lb.leave_type_id
       LEFT JOIN users updater ON updater.id = lb.last_updated_by
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
    const totalDays = Number(req.body.total_days ?? req.body.balance);
    const usedDays = Number(req.body.used_days ?? req.body.used ?? 0);

    if (!employeeId || !leaveType || Number.isNaN(totalDays) || Number.isNaN(usedDays)) {
      return res.status(400).json({ error: 'employee_id, leave_type, total_days, and used_days are required.' });
    }
    if (totalDays < 0 || usedDays < 0 || usedDays > totalDays) {
      return res.status(400).json({ error: 'Used days cannot exceed total days.' });
    }

    const remainingDays = totalDays - usedDays;
    await pool.execute(
      `INSERT INTO leave_balances
         (employee_id, leave_type_id, leave_type, balance, used, total_days, used_days, remaining_days, year, last_updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         leave_type_id = VALUES(leave_type_id),
         leave_type = VALUES(leave_type),
         balance = VALUES(balance),
         used = VALUES(used),
         total_days = VALUES(total_days),
         used_days = VALUES(used_days),
         remaining_days = VALUES(remaining_days),
         last_updated_by = VALUES(last_updated_by)`,
      [employeeId, leaveType.id, leaveType.name, totalDays, usedDays, totalDays, usedDays, remainingDays, year, req.user.id]
    );
    await writeLeaveAudit(pool, null, employeeId, req.user.id, 'leave_balance_adjusted', `${leaveType.name}: ${remainingDays}/${totalDays} day(s) remaining`, null, null, {
      leave_type_id: leaveType.id,
      year,
      total_days: totalDays,
      used_days: usedDays,
      remaining_days: remainingDays
    });
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
    const [overlaps] = await pool.execute(
      `SELECT id FROM leave_requests
       WHERE employee_id = ?
         AND status IN ('Pending','Approved')
         AND date_from <= ? AND date_to >= ?
       LIMIT 1`,
      [empId, date_to, date_from]
    );
    if (overlaps.length) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'This employee already has an overlapping leave request.' });
    }

    const balance = await getConfiguredLeaveBalance(pool, empId, leaveType, year);
    if (source === 'Portal') {
      if (!balance) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'No leave balance is configured for this employee, leave type, and year.' });
      }
      const remaining = decimalValue(balance.remaining_days_value);
      if (requestedDays > remaining) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Requested duration exceeds the available leave balance.' });
      }
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
    const extensionDays = leaveType.allow_unpaid_extension ? decimalValue(leaveType.max_extension_days) : 0;
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
    res.status(500).json({ error: 'Failed to submit leave.' });
  }
});

app.patch('/api/leave/:id/status', requireAuth, requireLeavePermission('leave.request.approve'), async (req, res) => {
  const pool = require('./config/db');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const status = req.body.status === 'Denied' ? 'Rejected' : req.body.status;
    const remarks = req.body.remarks || null;
    if (status === 'Rejected' && !remarks) {
      await connection.rollback();
      return res.status(400).json({ error: 'Remarks are required when rejecting leave.' });
    }
    if (!['Approved', 'Rejected', 'Cancelled', 'Pending'].includes(status)) {
      await connection.rollback();
      return res.status(400).json({ error: 'Invalid leave status.' });
    }

    const [rows] = await connection.execute(
      `SELECT lr.*, COALESCE(lt.name, lr.type) AS leave_type_name, lt.id AS configured_leave_type_id, lt.max_allowed_days
       FROM leave_requests lr
       LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
       WHERE lr.id = ?
       FOR UPDATE`,
      [req.params.id]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Leave request not found.' });
    }
    const leave = rows[0];
    const leaveType = await getLeaveType(connection, { id: leave.configured_leave_type_id, name: leave.leave_type_name, includeInactive: true });
    if (!leaveType) {
      await connection.rollback();
      return res.status(400).json({ error: 'Leave type configuration was not found.' });
    }
    const year = new Date(leave.date_from).getFullYear();

    if (status === 'Approved' && leave.status !== 'Approved') {
      const balance = await getConfiguredLeaveBalance(connection, leave.employee_id, leaveType, year, true);
      if (!balance) {
        await connection.rollback();
        return res.status(400).json({ error: 'No leave balance is configured for this employee, leave type, and year.' });
      }
      const requestedDays = decimalValue(leave.days || 1);
      if (decimalValue(balance.remaining_days_value) < requestedDays) {
        await connection.rollback();
        return res.status(400).json({ error: 'Insufficient leave balance for approval.' });
      }
      const nextUsed = decimalValue(balance.used_days_value) + requestedDays;
      const nextRemaining = decimalValue(balance.total_days_value) - nextUsed;
      await connection.execute(
        `UPDATE leave_balances
            SET used_days = ?, remaining_days = ?, used = ?, last_updated_by = ?
          WHERE id = ?`,
        [nextUsed, nextRemaining, nextUsed, req.user.id, balance.id]
      );
    }

    await connection.execute(
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
    await writeLeaveAudit(connection, req.params.id, leave.employee_id, req.user.id, action, remarks, leave.status, status);
    await connection.commit();
    res.json({ message: 'Leave status updated.' });
  } catch (err) {
    await connection.rollback().catch(() => {});
    console.error('Error updating leave:', err.message);
    res.status(500).json({ error: 'Failed to update leave.' });
  } finally {
    connection.release();
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

const employeeOnlyRequestAccess = (req, res, next) => {
  if (req.user?.role !== 'employee') {
    return res.status(403).json({ error: 'Requests are available only to employee accounts.' });
  }
  next();
};

// General Requests (COE, COS, Exit) — employee self-service only.
app.get('/api/requests', requireAuth, employeeOnlyRequestAccess, async (req, res) => {
  try {
    const pool = require('./config/db');
    let q = `SELECT gr.*, CONCAT(e.first_name,' ',e.last_name) AS employee_name
             FROM general_requests gr JOIN employees e ON e.id = gr.employee_id`;
    const p = [];
    q += ' WHERE gr.employee_id = ?';
    p.push(req.user.employeeId);
    q += ' ORDER BY gr.created_at DESC';
    const [rows] = await pool.execute(q, p);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch requests.' }); }
});

app.post('/api/requests', requireAuth, employeeOnlyRequestAccess, async (req, res) => {
  try {
    const pool = require('./config/db');
    const { type, reason } = req.body;
    const empId = req.user.employeeId;
    if (!empId) return res.status(400).json({ error: 'Your account is not linked to an employee record. Please ask the system administrator to link your account to an employee profile.' });
    if (!['COE','COS','Request Exit'].includes(type)) return res.status(400).json({ error: 'Invalid request type.' });
    const [result] = await pool.execute(
      `INSERT INTO general_requests (employee_id, type, reason) VALUES (?,?,?)`,
      [empId, type, reason || null]
    );
    res.json({ id: result.insertId, message: 'Request submitted.' });
  } catch (err) { res.status(500).json({ error: 'Failed to submit request.' }); }
});

app.patch('/api/requests/:id/status', requireAuth, requireRole(ROLES.hr_final_approval), async (req, res) => {
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
    const [tableRows] = await pool.execute(
      `SELECT COUNT(*) AS exists_count
         FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'BLOCKCHAIN_AUDIT_LOG'`
    );
    if (!tableRows[0]?.exists_count) {
      return res.json({
        message: 'Permissioned payroll blockchain audit log is not initialized. Run database/migrate-permissioned-blockchain-payroll.sql.',
        records: [],
      });
    }

    const [rows] = await pool.execute(
      `SELECT bal.Audit_ID, bal.Payroll_ID, bal.Event_Type, bal.Actor_Role,
              bal.Transaction_Hash, bal.Payload_Hash, bal.Status, bal.Created_At,
              pr.Blockchain_Status, pr.Approval_Status
         FROM BLOCKCHAIN_AUDIT_LOG bal
         LEFT JOIN PAYROLL_RECORD pr ON pr.Payroll_ID = bal.Payroll_ID
        ORDER BY bal.Created_At DESC, bal.Audit_ID DESC
        LIMIT 50`
    );
    res.json({
      message: 'Use /api/blockchain/payroll/finalized for payroll blockchain records.',
      records: rows,
    });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch blockchain audit summary.' }); }
});

// Employee self-service profile and HR change-request review
app.use('/api', selfServiceRoutes);

// Error handling middleware (before SPA fallback)
app.use((err, req, res, next) => {
  console.error('❌ Unhandled Error:', err.message);
  res.status(err.status || 500).json({ 
    error: 'Internal Server Error'
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function getLocalIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  const virtualPattern = /virtual|vmware|vbox|virtualbox|hyper-v|wsl|docker|loopback/i;

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) {
        candidates.push({
          name,
          address: address.address,
          isVirtual: virtualPattern.test(name),
          isWifi: /wi-?fi|wireless|wlan/i.test(name),
        });
      }
    }
  }

  return candidates;
}

function getPreferredLocalIPv4Address() {
  const candidates = getLocalIPv4Addresses();
  return (
    candidates.find(item => item.isWifi && !item.isVirtual)
    || candidates.find(item => !item.isVirtual)
    || candidates[0]
    || { address: 'localhost' }
  ).address;
}

function logServerUrls(protocol) {
  const localIp = getPreferredLocalIPv4Address();
  const candidates = getLocalIPv4Addresses();
  console.log(`Local access: ${protocol}://localhost:${PORT}`);
  console.log(`Network access: ${protocol}://${localIp}:${PORT}`);
  console.log(`Health check: ${protocol}://${localIp}:${PORT}/health`);
  if (candidates.length > 1) {
    console.log('Other local IPv4 URLs:');
    candidates
      .filter(item => item.address !== localIp)
      .forEach(item => console.log(`- ${item.name}: ${protocol}://${item.address}:${PORT}`));
  }
}

if (process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH) {
  const tlsOptions = {
    cert: fs.readFileSync(process.env.TLS_CERT_PATH),
    key: fs.readFileSync(process.env.TLS_KEY_PATH),
    ca: process.env.TLS_CA_PATH ? fs.readFileSync(process.env.TLS_CA_PATH) : undefined,
    minVersion: 'TLSv1.3',
  };
  const server = https.createServer(tlsOptions, app);
  server.listen(PORT, HOST, () => {
    console.log(`LGSV_HR running with TLS 1.3 on ${HOST}:${PORT}`);
    logServerUrls('https');
  });
} else {
  const server = http.createServer(app);
  server.listen(PORT, HOST, () => {
    console.log(`LGSV_HR local development server listening on ${HOST}:${PORT}`);
    logServerUrls('http');
    if (process.env.NODE_ENV === 'production') {
      console.warn('TLS certificate paths are not configured. Terminate TLS 1.3 at the trusted reverse proxy.');
    }
  });
}


