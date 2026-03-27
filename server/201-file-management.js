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

const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /pdf|doc|docx|jpg|jpeg|png/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Invalid file type. Only PDF, DOC, DOCX, JPG, JPEG, and PNG are allowed.'));
  }
});

// Helper: Log 201-file access to audit trail
async function logAccessLog(employeeId, userId, action, resourceType, resourceId, details) {
  try {
    await pool.execute(
      `INSERT INTO employee_201_file_access_log 
       (employee_id, accessed_by, action, resource_type, resource_id, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [employeeId, userId, action, resourceType, resourceId, JSON.stringify(details) || null]
    );
  } catch (err) {
    console.error('Error logging access:', err.message);
  }
}

// GET /api/201-files → List all employees for 201-file management
router.get('/list', async (req, res) => {
  try {
    const [employees] = await pool.execute(`
      SELECT 
        e.id,
        e.employee_code,
        CONCAT(e.first_name, ' ', e.last_name) AS name,
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
    
    res.json(employees);
  } catch (err) {
    console.error('Error fetching employees for 201-file:', err);
    res.status(500).json({ error: 'Failed to fetch employees.' });
  }
});

// GET /api/201-files/:employeeId → Retrieve complete 201-file for an employee
router.get('/:employeeId', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const userId = req.user.id;

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
        tax_id,
        bank_account_number,
        bank_routing_number,
        emergency_contact_phone,
        other_sensitive_info,
        CASE WHEN ssn IS NOT NULL THEN 'Present' ELSE 'Not Set' END AS ssn_status,
        CASE WHEN tax_id IS NOT NULL THEN 'Present' ELSE 'Not Set' END AS tax_id_status,
        CASE WHEN bank_account_number IS NOT NULL THEN 'Present' ELSE 'Not Set' END AS bank_status,
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
      sensitiveData: sensitiveData || null,
    });
  } catch (err) {
    console.error('Error fetching 201-file:', err);
    res.status(500).json({ error: 'Failed to fetch 201-file.' });
  }
});

// GET /api/201-files/:employeeId/sensitive-data → Retrieve sensitive employee data
router.get('/:employeeId/sensitive-data', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const userId = req.user.id;

    // Log sensitive data access
    await logAccessLog(employeeId, userId, 'sensitive_data_view', 'sensitive_data', employeeId, { action: 'viewed_sensitive_data' });

    const [[data]] = await pool.execute(`
      SELECT 
        id,
        employee_id,
        ssn,
        tax_id,
        bank_account_number,
        bank_routing_number,
        emergency_contact_phone,
        other_sensitive_info,
        updated_at
      FROM sensitive_employee_data
      WHERE employee_id = ?
    `, [employeeId]);

    if (!data) {
      return res.status(404).json({ error: 'Sensitive data not found.' });
    }

    res.json(data);
  } catch (err) {
    console.error('Error fetching sensitive data:', err);
    res.status(500).json({ error: 'Failed to fetch sensitive data.' });
  }
});

// PUT /api/201-files/:employeeId/sensitive-data → Create or update sensitive employee data
router.put('/:employeeId/sensitive-data', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const userId = req.user.id;
    const { ssn, tax_id, bank_account_number, bank_routing_number, emergency_contact_phone, other_sensitive_info } = req.body;

    // Check if sensitive data exists
    const [[existing]] = await pool.execute(
      'SELECT id FROM sensitive_employee_data WHERE employee_id = ?',
      [employeeId]
    );

    if (existing) {
      // Update
      await pool.execute(`
        UPDATE sensitive_employee_data 
        SET ssn=?, tax_id=?, bank_account_number=?, bank_routing_number=?, 
            emergency_contact_phone=?, other_sensitive_info=?, updated_by=?
        WHERE employee_id = ?
      `, [ssn, tax_id, bank_account_number, bank_routing_number, emergency_contact_phone, other_sensitive_info, userId, employeeId]);

      await logAccessLog(employeeId, userId, 'edit', 'sensitive_data', existing.id, { action: 'updated_sensitive_data' });
    } else {
      // Insert
      const [result] = await pool.execute(`
        INSERT INTO sensitive_employee_data 
        (employee_id, ssn, tax_id, bank_account_number, bank_routing_number, emergency_contact_phone, other_sensitive_info, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [employeeId, ssn, tax_id, bank_account_number, bank_routing_number, emergency_contact_phone, other_sensitive_info, userId]);

      await logAccessLog(employeeId, userId, 'edit', 'sensitive_data', result.insertId, { action: 'created_sensitive_data' });
    }

    res.json({ message: 'Sensitive data updated successfully.' });
  } catch (err) {
    console.error('Error updating sensitive data:', err);
    res.status(500).json({ error: 'Failed to update sensitive data.' });
  }
});

// POST /api/201-files/:employeeId/documents → Upload a document to the 201-file
router.post('/:employeeId/documents', upload.single('file'), async (req, res) => {
  try {
    const { employeeId } = req.params;
    const userId = req.user.id;
    const { document_type } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const fileName = req.file.originalname;
    const filePath = `/uploads/${req.file.filename}`;

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
router.delete('/:employeeId/documents/:docId', async (req, res) => {
  try {
    const { employeeId, docId } = req.params;
    const userId = req.user.id;

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
router.put('/:employeeId/verify-document/:docId', async (req, res) => {
  try {
    const { employeeId, docId } = req.params;
    const userId = req.user.id;
    const { verification_status, rejection_reason } = req.body;

    if (!['Verified', 'Rejected'].includes(verification_status)) {
      return res.status(400).json({ error: 'Invalid verification status.' });
    }

    await pool.execute(`
      UPDATE documents
      SET verification_status = ?, verified_by = ?, verified_at = NOW(), rejection_reason = ?
      WHERE id = ? AND employee_id = ?
    `, [verification_status, userId, rejection_reason || null, docId, employeeId]);

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
router.get('/:employeeId/access-log', async (req, res) => {
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
      FROM employee_201_file_access_log
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
