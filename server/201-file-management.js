/* ============================================================
   server/201-file-management.js
   201-File Management API endpoints for HR Admin
   ============================================================ */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const pool = require('../config/db');
const { requireRole, ROLES } = require('./middleware');
const {
  decryptColumnValue,
  decryptNullable,
  encryptNullable,
  hashNullable,
} = require('./data-protection');
const {
  auditSecurityEvent,
  multerFileFilter,
  randomSafeFilename,
  rejectForbiddenFields,
  secureUploadedFile,
} = require('./security-controls');

const DOCUMENT_PARAMETER_TAMPER_GUARD = rejectForbiddenFields(new Set([
  'role',
  'role_id',
  'access_level',
  'salary',
  'base_rate',
  'gross_pay',
  'net_pay',
  'payroll_status',
]), {
  action: 'blocked_201_file_parameter_tampering_attempt',
  module: 'DOCUMENT_SECURITY',
  targetTable: 'documents',
});
const HR_DOCUMENT_ROLES = [...ROLES.hr_manager, ...ROLES.admin_any];
const DOCUMENT_TYPE_VALUES = new Set(['Resume', 'Government_ID', 'NBI_Clearance', 'Contract', 'Other']);
const SENSITIVE_DATA_FIELDS = new Set([
  'ssn',
  'tax_id',
  'bank_account_number',
  'bank_routing_number',
  'emergency_contact_phone',
  'other_sensitive_info',
]);

function rejectUnsupportedFields(req, res, allowedFields, module = 'DOCUMENT_SECURITY') {
  const unknownFields = Object.keys(req.body || {}).filter(field => !allowedFields.has(field));
  if (!unknownFields.length) return false;
  auditSecurityEvent(req, {
    action: 'blocked_unsupported_201_file_fields',
    module,
    targetTable: req.originalUrl || null,
    targetRecord: req.params?.employeeId || null,
    newValue: { fields: unknownFields, path: req.originalUrl },
    result: 'blocked',
  }).catch(() => {});
  res.status(400).json({ error: 'Request contains unsupported field(s).', fields: unknownFields });
  return true;
}

const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    cb(null, randomSafeFilename(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: multerFileFilter
});

function uploadDocument(req, res, next) {
  upload.single('file')(req, res, (err) => {
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
}

function isHrDocumentRole(role) {
  return HR_DOCUMENT_ROLES.includes(role);
}

function encryptedOrPlain(row, encryptedField, plainField) {
  if (!row) return null;
  if (row[encryptedField]) return decryptNullable(row[encryptedField]);
  return row[plainField] || null;
}

function present(row, encryptedField, plainField) {
  return row?.[encryptedField] || row?.[plainField] ? 'Present' : 'Not Set';
}

function sensitiveDataResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    employee_id: row.employee_id,
    ssn: encryptedOrPlain(row, 'ssn_encrypted', 'ssn'),
    tax_id: encryptedOrPlain(row, 'tax_id_encrypted', 'tax_id'),
    bank_account_number: encryptedOrPlain(row, 'bank_account_number_encrypted', 'bank_account_number'),
    bank_routing_number: encryptedOrPlain(row, 'bank_routing_number_encrypted', 'bank_routing_number'),
    emergency_contact_phone: encryptedOrPlain(row, 'emergency_contact_phone_encrypted', 'emergency_contact_phone'),
    other_sensitive_info: encryptedOrPlain(row, 'other_sensitive_info_encrypted', 'other_sensitive_info'),
    ssn_status: present(row, 'ssn_encrypted', 'ssn'),
    tax_id_status: present(row, 'tax_id_encrypted', 'tax_id'),
    bank_status: present(row, 'bank_account_number_encrypted', 'bank_account_number'),
    updated_at: row.updated_at,
    updated_by_name: row.updated_by_name,
  };
}

function encryptedSensitiveDataParams(body) {
  return {
    ssnEncrypted: encryptNullable(body.ssn),
    ssnHash: hashNullable(body.ssn),
    taxIdEncrypted: encryptNullable(body.tax_id),
    taxIdHash: hashNullable(body.tax_id),
    bankAccountEncrypted: encryptNullable(body.bank_account_number),
    bankAccountHash: hashNullable(body.bank_account_number),
    bankRoutingEncrypted: encryptNullable(body.bank_routing_number),
    bankRoutingHash: hashNullable(body.bank_routing_number),
    emergencyPhoneEncrypted: encryptNullable(body.emergency_contact_phone),
    emergencyPhoneHash: hashNullable(body.emergency_contact_phone),
    otherInfoEncrypted: encryptNullable(body.other_sensitive_info),
  };
}

// Helper: Log 201-file access to audit trail
async function logAccessLog(employeeId, userId, action, resourceType, resourceId, details) {
  try {
    await pool.execute(
      `INSERT INTO employee_201_file_access_audit
       (employee_id, accessed_by, action, resource_type, resource_id, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [employeeId, userId, action, resourceType, resourceId, JSON.stringify(details) || null]
    );
  } catch (err) {
    console.error('Error logging access:', err.message);
  }
}

// GET /api/201-files → List all employees for 201-file management
router.get('/list', requireRole(HR_DOCUMENT_ROLES), async (req, res) => {
  try {
    const [employees] = await pool.execute(`
      SELECT 
        e.id,
        e.employee_code,
        e.first_name,
        e.middle_name,
        e.last_name,
        e.email,
        e.position,
        d.name AS department,
        e.status,
        (SELECT COUNT(*) FROM documents WHERE employee_id = e.id) AS document_count,
        (SELECT COUNT(*) FROM documents WHERE employee_id = e.id AND verification_status = 'Verified') AS verified_documents
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      ORDER BY e.first_name, e.last_name
    `);
    
    res.json(employees.map(employee => {
      const first = decryptColumnValue(employee.first_name) || '';
      const middle = decryptColumnValue(employee.middle_name) || '';
      const last = decryptColumnValue(employee.last_name) || '';
      return {
        ...employee,
        first_name: undefined,
        middle_name: undefined,
        last_name: undefined,
        name: [first, middle, last].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || employee.employee_code,
      };
    }));
  } catch (err) {
    console.error('Error fetching employees for 201-file:', err);
    res.status(500).json({ error: 'Failed to fetch employees.' });
  }
});

// GET /api/201-files/:employeeId → Retrieve complete 201-file for an employee
router.get('/:employeeId', requireRole(HR_DOCUMENT_ROLES), async (req, res) => {
  try {
    const { employeeId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;
    const userEmployeeId = req.user.employeeId;

    // Permission check: Allow if user is HR staff OR viewing their own documents
    const isHrAdmin = isHrDocumentRole(userRole);
    const isOwnRecord = parseInt(employeeId) === userEmployeeId;
    
    if (!isHrAdmin && !isOwnRecord) {
      console.warn(`⚠️ Permission denied: User ${userId} (role: ${userRole}) tried to access employee ${employeeId}`);
      return res.status(403).json({ error: 'You do not have permission to view this employee\'s documents.' });
    }

    // Log access
    await logAccessLog(employeeId, userId, 'view', 'employee_info', employeeId, { action: 'viewed_201_file' });

    // Get employee personal information
    const [employeeRows] = await pool.execute(`
      SELECT 
        e.*,
        d.name AS department
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.id = ?
    `, [employeeId]);

    const employee = employeeRows[0];
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    // Get documents attached to 201-file
    const [documents] = await pool.execute(`
      SELECT 
        id,
        employee_id,
        document_type,
        file_name,
        file_path,
        uploaded_date,
        verification_status,
        verified_by,
        verified_at,
        rejection_reason,
        (SELECT CONCAT(u.username, ' (', r.label, ')') FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = verified_by) AS verified_by_name
      FROM documents
      WHERE employee_id = ?
      ORDER BY uploaded_date DESC
    `, [employeeId]);

    // Check if sensitive data exists
    const [[sensitiveData]] = await pool.execute(`
      SELECT 
        id,
        employee_id,
        ssn,
        ssn_encrypted,
        tax_id,
        tax_id_encrypted,
        bank_account_number,
        bank_account_number_encrypted,
        bank_routing_number,
        bank_routing_number_encrypted,
        emergency_contact_phone,
        emergency_contact_phone_encrypted,
        other_sensitive_info,
        other_sensitive_info_encrypted,
        updated_at,
        (SELECT CONCAT(u.username, ' (', r.label, ')') FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = updated_by) AS updated_by_name
      FROM sensitive_employee_data
      WHERE employee_id = ?
    `, [employeeId]);

    res.json({
      employee: {
        id: employee.id,
        code: employee.employee_code,
        firstName: employee.first_name,
        middleName: employee.middle_name,
        lastName: employee.last_name,
        suffix: employee.suffix,
        email: employee.email,
        contactNumber: employee.contact_number,
        nationality: employee.nationality,
        dateOfBirth: employee.date_of_birth,
        gender: employee.gender,
        residentialAddress: employee.residential_address,
        emergencyContactName: employee.emergency_contact_name,
        emergencyContactNum: employee.emergency_contact_num,
        department: employee.department,
        position: employee.position,
        employmentType: employee.employment_type,
        dateHired: employee.date_hired,
        supervisor: employee.supervisor,
        workLocation: employee.work_location,
        status: employee.status,
        createdAt: employee.created_at,
      },
      documents,
      sensitiveData: sensitiveDataResponse(sensitiveData),
    });
  } catch (err) {
    console.error('Error fetching 201-file:', err);
    res.status(500).json({ error: 'Failed to fetch 201-file.' });
  }
});

// GET /api/201-files/:employeeId/sensitive-data → Retrieve sensitive employee data
router.get('/:employeeId/sensitive-data', requireRole(HR_DOCUMENT_ROLES), async (req, res) => {
  try {
    const { employeeId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Permission check: Only HR document roles can view sensitive data
    const isHrAdmin = isHrDocumentRole(userRole);
    if (!isHrAdmin) {
      return res.status(403).json({ error: 'Only HR document roles can view sensitive employee data.' });
    }

    // Log sensitive data access
    await logAccessLog(employeeId, userId, 'sensitive_data_view', 'sensitive_data', employeeId, { action: 'viewed_sensitive_data' });

    const [[data]] = await pool.execute(`
      SELECT 
        id,
        employee_id,
        ssn,
        ssn_encrypted,
        tax_id,
        tax_id_encrypted,
        bank_account_number,
        bank_account_number_encrypted,
        bank_routing_number,
        bank_routing_number_encrypted,
        emergency_contact_phone,
        emergency_contact_phone_encrypted,
        other_sensitive_info,
        other_sensitive_info_encrypted,
        updated_at
      FROM sensitive_employee_data
      WHERE employee_id = ?
    `, [employeeId]);

    if (!data) {
      return res.status(404).json({ error: 'Sensitive data not found.' });
    }

    res.json(sensitiveDataResponse(data));
  } catch (err) {
    console.error('Error fetching sensitive data:', err);
    res.status(500).json({ error: 'Failed to fetch sensitive data.' });
  }
});

// PUT /api/201-files/:employeeId/sensitive-data → Create or update sensitive employee data
router.put('/:employeeId/sensitive-data', requireRole(HR_DOCUMENT_ROLES), DOCUMENT_PARAMETER_TAMPER_GUARD, async (req, res) => {
  try {
    const { employeeId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;
    if (rejectUnsupportedFields(req, res, SENSITIVE_DATA_FIELDS)) return;
    const encryptedFields = encryptedSensitiveDataParams(req.body);

    // Permission check: Only HR document roles can edit sensitive data
    const isHrAdmin = isHrDocumentRole(userRole);
    if (!isHrAdmin) {
      return res.status(403).json({ error: 'Only HR document roles can edit sensitive employee data.' });
    }

    // Check if sensitive data exists
    const [[existing]] = await pool.execute(
      'SELECT id FROM sensitive_employee_data WHERE employee_id = ?',
      [employeeId]
    );

    if (existing) {
      // Update
      await pool.execute(`
        UPDATE sensitive_employee_data 
        SET ssn = NULL,
            tax_id = NULL,
            bank_account_number = NULL,
            bank_routing_number = NULL,
            emergency_contact_phone = NULL,
            other_sensitive_info = NULL,
            ssn_encrypted = ?,
            ssn_hash = ?,
            tax_id_encrypted = ?,
            tax_id_hash = ?,
            bank_account_number_encrypted = ?,
            bank_account_number_hash = ?,
            bank_routing_number_encrypted = ?,
            bank_routing_number_hash = ?,
            emergency_contact_phone_encrypted = ?,
            emergency_contact_phone_hash = ?,
            other_sensitive_info_encrypted = ?,
            updated_by=?
        WHERE employee_id = ?
      `, [
        encryptedFields.ssnEncrypted,
        encryptedFields.ssnHash,
        encryptedFields.taxIdEncrypted,
        encryptedFields.taxIdHash,
        encryptedFields.bankAccountEncrypted,
        encryptedFields.bankAccountHash,
        encryptedFields.bankRoutingEncrypted,
        encryptedFields.bankRoutingHash,
        encryptedFields.emergencyPhoneEncrypted,
        encryptedFields.emergencyPhoneHash,
        encryptedFields.otherInfoEncrypted,
        userId,
        employeeId
      ]);

      await logAccessLog(employeeId, userId, 'edit', 'sensitive_data', existing.id, { action: 'updated_sensitive_data' });
    } else {
      // Insert
      const [result] = await pool.execute(`
        INSERT INTO sensitive_employee_data 
        (employee_id, ssn_encrypted, ssn_hash, tax_id_encrypted, tax_id_hash,
         bank_account_number_encrypted, bank_account_number_hash,
         bank_routing_number_encrypted, bank_routing_number_hash,
         emergency_contact_phone_encrypted, emergency_contact_phone_hash,
         other_sensitive_info_encrypted, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        employeeId,
        encryptedFields.ssnEncrypted,
        encryptedFields.ssnHash,
        encryptedFields.taxIdEncrypted,
        encryptedFields.taxIdHash,
        encryptedFields.bankAccountEncrypted,
        encryptedFields.bankAccountHash,
        encryptedFields.bankRoutingEncrypted,
        encryptedFields.bankRoutingHash,
        encryptedFields.emergencyPhoneEncrypted,
        encryptedFields.emergencyPhoneHash,
        encryptedFields.otherInfoEncrypted,
        userId
      ]);

      await logAccessLog(employeeId, userId, 'edit', 'sensitive_data', result.insertId, { action: 'created_sensitive_data' });
    }

    res.json({ message: 'Sensitive data updated successfully.' });
  } catch (err) {
    console.error('Error updating sensitive data:', err);
    res.status(500).json({ error: 'Failed to update sensitive data.' });
  }
});

// POST /api/201-files/:employeeId/documents → Upload a document to the 201-file
router.post('/:employeeId/documents', requireRole(HR_DOCUMENT_ROLES), DOCUMENT_PARAMETER_TAMPER_GUARD, uploadDocument, async (req, res) => {
  try {
    const { employeeId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;
    const { document_type } = req.body;
    if (rejectUnsupportedFields(req, res, new Set(['document_type']))) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return;
    }

    // Permission check: Only HR document roles can upload documents
    const isHrAdmin = isHrDocumentRole(userRole);
    if (!isHrAdmin) {
      return res.status(403).json({ error: 'Only HR document roles can upload documents.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const fileName = req.file.originalname;
    const filePath = `/uploads/${req.file.filename}`;

    if (!DOCUMENT_TYPE_VALUES.has(document_type || 'Other')) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Invalid document type.' });
    }

    const [result] = await pool.execute(`
      INSERT INTO documents (employee_id, document_type, file_name, file_path)
      VALUES (?, ?, ?, ?)
    `, [employeeId, document_type || 'Other', fileName, filePath]);

    await logAccessLog(employeeId, userId, 'document_upload', 'document', result.insertId, {
      action: 'uploaded_document',
      file_name: fileName,
      document_type,
    });

    res.json({ message: 'Document uploaded successfully.', id: result.insertId });
  } catch (err) {
    console.error('Error uploading document:', err);
    res.status(500).json({ error: 'Failed to upload document.' });
  }
});

// DELETE /api/201-files/:employeeId/documents/:docId → Delete an attached document
router.delete('/:employeeId/documents/:docId', requireRole(HR_DOCUMENT_ROLES), async (req, res) => {
  try {
    const { employeeId, docId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Permission check: Only HR document roles can delete documents
    const isHrAdmin = isHrDocumentRole(userRole);
    if (!isHrAdmin) {
      return res.status(403).json({ error: 'Only HR document roles can delete documents.' });
    }

    const [[existingDoc]] = await pool.execute(`
      SELECT * FROM documents WHERE id = ? AND employee_id = ?
    `, [docId, employeeId]);

    if (!existingDoc) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    await pool.execute(`
      DELETE FROM documents WHERE id = ? AND employee_id = ?
    `, [docId, employeeId]);

    if (existingDoc.file_path) {
      const absPath = path.join(__dirname, '..', 'public', existingDoc.file_path);
      fs.unlink(absPath, err => {
        if (err) console.warn('Could not delete file from disk:', err.message);
      });
    }

    await logAccessLog(employeeId, userId, 'document_delete', 'document', docId, {
      action: 'deleted_document',
      file_name: existingDoc.file_name,
      document_type: existingDoc.document_type,
    });

    res.json({ message: 'Document deleted successfully.' });
  } catch (err) {
    console.error('Error deleting document:', err);
    res.status(500).json({ error: 'Failed to delete document.' });
  }
});

// PUT /api/201-files/:employeeId/verify-document/:docId → Verify or reject a document
router.put('/:employeeId/verify-document/:docId', requireRole(HR_DOCUMENT_ROLES), DOCUMENT_PARAMETER_TAMPER_GUARD, async (req, res) => {
  try {
    const { employeeId, docId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;
    const { verification_status, rejection_reason } = req.body;
    if (rejectUnsupportedFields(req, res, new Set(['verification_status', 'rejection_reason']))) return;

    // Permission check: Only HR document roles can verify documents
    const isHrAdmin = isHrDocumentRole(userRole);
    if (!isHrAdmin) {
      return res.status(403).json({ error: 'Only HR document roles can verify documents.' });
    }

    if (!['Verified', 'Rejected'].includes(verification_status)) {
      return res.status(400).json({ error: 'Invalid verification status.' });
    }

    const [result] = await pool.execute(`
      UPDATE documents
      SET verification_status = ?, verified_by = ?, verified_at = NOW(), rejection_reason = ?
      WHERE id = ? AND employee_id = ?
    `, [verification_status, userId, rejection_reason || null, docId, employeeId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    await logAccessLog(employeeId, userId, 'document_verify', 'document', docId, { 
      action: 'verified_document',
      status: verification_status,
      reason: rejection_reason
    });

    res.json({ message: `Document ${verification_status.toLowerCase()} successfully.` });
  } catch (err) {
    console.error('Error verifying document:', err);
    res.status(500).json({ error: 'Failed to verify document.' });
  }
});

// GET /api/201-files/:employeeId/access-log → Retrieve audit log for 201-file access
router.get('/:employeeId/access-log', requireRole(HR_DOCUMENT_ROLES), async (req, res) => {
  try {
    const { employeeId } = req.params;

    const [logs] = await pool.execute(`
      SELECT 
        id,
        accessed_at,
        (SELECT CONCAT(u.username, ' (', r.label, ')') FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = accessed_by) AS accessed_by_name,
        action,
        resource_type,
        resource_id,
        details
      FROM employee_201_file_access_audit
      WHERE employee_id = ?
      ORDER BY accessed_at DESC
      LIMIT 100
    `, [employeeId]);

    res.json(logs);
  } catch (err) {
    console.error('Error fetching access log:', err);
    res.status(500).json({ error: 'Failed to fetch access log.' });
  }
});

module.exports = router;
