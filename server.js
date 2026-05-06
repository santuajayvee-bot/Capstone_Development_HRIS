/* ============================================================
   server.js — LGSV_HR System — Express + JWT + MySQL
   ============================================================ */

require('dotenv').config();
const express    = require('express');
const path       = require('path');
const multer     = require('multer');
const fs         = require('fs');

const { login, me }                          = require('./server/auth');
const { requireAuth, requireRole, ROLES }    = require('./server/middleware');
const payrollRoutes                          = require('./server/payroll');
const fileManagementRoutes                   = require('./server/201-file-management');
const bcrypt                                 = require('bcrypt');
const pool                                   = require('./config/db');

const app  = express();
const PORT = process.env.PORT || 3000;

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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── PUBLIC ───────────────────────────────────────────────────
app.post('/api/auth/login', login);

// ── ROBUST DOWNLOAD ENDPOINT ─────────────────────────────────
app.post('/api/reports/download', express.urlencoded({ extended: true, limit: '50mb' }), (req, res) => {
  const { filedata, filename, format, token } = req.body;
  
  if (!token) return res.status(401).send('Unauthorized: No token provided.');
  if (!filedata || !filename || !format) return res.status(400).send('Missing file data.');

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    if (decoded.role !== 'payroll_manager') {
      return res.status(403).send('Access denied. Reports are restricted to Payroll Managers.');
    }

    const buffer = Buffer.from(filedata, 'base64');
    let contentType = 'application/octet-stream';
    let ext = format;
    
    if (format === 'pdf') {
      contentType = 'application/pdf';
      ext = 'pdf';
    } else if (format === 'excel') {
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      ext = 'xlsx';
    } else if (format === 'csv') {
      contentType = 'text/csv';
      ext = 'csv';
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.${ext}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('Download Error:', err);
    res.status(500).send('Authentication failed or internal server error.');
  }
});

// ── PROTECTED ────────────────────────────────────────────────
app.get('/api/auth/me', requireAuth, me);

// Payroll Routes (wages, transactions, payroll generation)
app.use('/api/payroll', payrollRoutes);

// 201-File Management (Auth required, role-based per endpoint)
app.use('/api/201-files', requireAuth, fileManagementRoutes);

// Employees
app.get('/api/employees', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const [rows] = await pool.execute(
      `SELECT e.*, d.name AS department FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id ORDER BY e.first_name`
    );
    
    console.log('\n=== GET /api/employees ===');
    console.log('Total employees returned:', rows.length);
    if (rows.length > 0) {
      console.log('Sample employee data:', {
        employee_code: rows[0].employee_code,
        name: rows[0].first_name + ' ' + rows[0].last_name,
        department: rows[0].department,
        position: rows[0].position,
        supervisor: rows[0].supervisor,
        work_location: rows[0].work_location
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
    const { employee_code, first_name, middle_name, last_name, suffix, email, contact_number, nationality, date_of_birth, gender, residential_address, emergency_contact_name, emergency_contact_num, department_id, position, employment_type, date_hired, supervisor, work_location, status } = req.body;
    
    console.log('\n=== POST /api/employees ===');
    console.log('User role:', req.user.role);
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    if (!first_name || !last_name || !email) {
      console.error('❌ Missing required fields');
      return res.status(400).json({ error: 'First name, last name, and email are required.' });
    }
    
    if (!employee_code) {
      console.error('❌ Missing employee_code');
      return res.status(400).json({ error: 'Employee code is required.' });
    }

    console.log('Executing INSERT for:', { employee_code, first_name, last_name, email });
    
    const [result] = await pool.execute(
      `INSERT INTO employees (employee_code, first_name, middle_name, last_name, suffix, email, contact_number, nationality, date_of_birth, gender, residential_address, emergency_contact_name, emergency_contact_num, department_id, position, employment_type, date_hired, supervisor, work_location, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [employee_code, first_name, middle_name || null, last_name, suffix || null, email, contact_number || null, nationality || 'Filipino', date_of_birth || null, gender || null, residential_address || null, emergency_contact_name || null, emergency_contact_num || null, department_id || null, position || null, employment_type || 'Full-time', date_hired || null, supervisor || null, work_location || null, status || 'Active']
    );
    
    console.log('✅ Employee inserted successfully!');
    console.log('Insert result:', { insertId: result.insertId, affectedRows: result.affectedRows });
    console.log('Employee Code:', employee_code);
    return res.status(201).json({ id: result.insertId, employee_code: employee_code, message: 'Employee added successfully.' });
  } catch (err) { 
    console.error('❌ ERROR adding employee:');
    console.error('Message:', err.message);
    console.error('SQL Error:', err.sqlMessage);
    console.error('SQL State:', err.sqlState);
    console.error('Full error:', err);
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ error: 'Failed to add employee: ' + err.message }); 
  }
});

// Update Employee
app.put('/api/employees/:id', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json');
    
    const pool = require('./config/db');
    const { id } = req.params; // numeric employee id
    const { first_name, middle_name, last_name, suffix, email, contact_number, nationality, date_of_birth, gender, residential_address, emergency_contact_name, emergency_contact_num, department_id, position, employment_type, date_hired, supervisor, work_location, status } = req.body;
    
    console.log('\n=== PUT /api/employees/:id ===');
    console.log('Employee ID:', id);
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    if (!first_name || !last_name || !email) {
      console.error('❌ Missing required fields');
      return res.status(400).json({ error: 'First name, last name, and email are required.' });
    }

    console.log('Executing UPDATE for:', { id, first_name, last_name, email, department_id, position, supervisor, work_location });

    const [result] = await pool.execute(
      `UPDATE employees SET 
        first_name=?, middle_name=?, last_name=?, suffix=?, email=?, contact_number=?, 
        nationality=?, date_of_birth=?, gender=?, residential_address=?, emergency_contact_name=?, 
        emergency_contact_num=?, department_id=?, position=?, employment_type=?, date_hired=?, supervisor=?, work_location=?, status=?
       WHERE id=?`,
      [first_name, middle_name || null, last_name, suffix || null, email, contact_number || null, 
       nationality || 'Filipino', date_of_birth || null, gender || null, residential_address || null, 
       emergency_contact_name || null, emergency_contact_num || null, department_id || null, position || null, 
       employment_type || 'Full-time', date_hired || null, supervisor || null, work_location || null, status || 'Active', id]
    );
    
    console.log('✅ UPDATE executed');
    console.log('Rows affected:', result.affectedRows);
    console.log('Change count:', result.changedRows);
    
    if (result.affectedRows === 0) {
      console.error('❌ No rows updated! Employee ID might not exist:', id);
      return res.status(404).json({ error: 'Employee not found.' });
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
app.post('/api/employees/:id/documents', requireAuth, requireRole(ROLES.staff_management), upload.single('file'), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params; // id = employee_code
    const { docType } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided.' });
    }
    
    if (!docType) {
      return res.status(400).json({ error: 'Document type is required.' });
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
    
    // Insert or update document record (REPLACE replaces if duplicate)
    const [result] = await pool.execute(
      `REPLACE INTO documents (employee_id, document_type, file_name, file_path) 
       VALUES (?, ?, ?, ?)`,
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

// Leave
app.get('/api/leave', requireAuth, requireRole(['hr_admin', 'employee']), async (req, res) => {
  try {
    const pool = require('./config/db');
    let q = `SELECT lr.*, CONCAT(e.first_name,' ',e.last_name) AS employee_name
             FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id`;
    const p = [];
    if (req.user.role === 'employee') { q += ' WHERE lr.employee_id = ?'; p.push(req.user.employeeId); }
    q += ' ORDER BY lr.created_at DESC';
    const [rows] = await pool.execute(q, p);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch leave.' }); }
});

app.post('/api/leave', requireAuth, requireRole([...ROLES.admin_any, 'employee']), upload.single('attachment'), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { type, date_from, date_to, days, reason, employee_id } = req.body;
    // For employees, always use their own ID from the token.
    // For admins/HR, prefer body employee_id (manual encoding), fall back to their own linked employee_id.
    let empId;
    if (req.user.role === 'employee') {
      empId = req.user.employeeId;
    } else {
      empId = employee_id ? parseInt(employee_id) : req.user.employeeId;
    }
    
    console.log('POST /api/leave - req.user:', req.user);
    console.log('POST /api/leave - req.body:', req.body);
    console.log('POST /api/leave - file:', req.file?.filename);
    console.log('POST /api/leave - final empId:', empId);
    
    if (!empId) {
      console.error('Error: No employee_id found');
      return res.status(400).json({ error: 'Your admin account is not linked to an employee record. Please ask the system administrator to link your account to an employee profile.' });
    }

    // Check if employee is eligible for leave (not Agency Worker)
    const [empRows] = await pool.execute('SELECT employment_type FROM employees WHERE id = ?', [empId]);
    if (empRows.length > 0) {
      const empType = (empRows[0].employment_type || '').toLowerCase();
      if (empType.includes('agency') || empType.includes('contractual')) {
         // Delete uploaded file if exists
         if (req.file) {
            const fs = require('fs');
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
         }
         return res.status(403).json({ error: 'Agency/Contractual workers are not authorized to file leave requests. Please contact your manpower agency.' });
      }
    }
    
    // Save file path if attachment was uploaded
    const filePath = req.file ? `/uploads/${req.file.filename}` : null;
    
    const [result] = await pool.execute(
      `INSERT INTO leave_requests (employee_id,type,date_from,date_to,days,reason,file_path) VALUES (?,?,?,?,?,?,?)`,
      [empId, type, date_from, date_to, days || 1, reason, filePath]
    );
    console.log('Leave request inserted with ID:', result.insertId);
    res.json({ id: result.insertId, message: 'Leave request submitted.' });
  } catch (err) { 
    console.error('Error saving leave request:', err);
    res.status(500).json({ error: 'Failed to submit leave.' }); 
  }
});

app.patch('/api/leave/:id/status', requireAuth, requireRole(['hr_admin']), async (req, res) => {
  try {
    const pool = require('./config/db');
    await pool.execute(
      `UPDATE leave_requests SET status=?, reviewed_by=?, reviewed_at=NOW() WHERE id=?`,
      [req.body.status, req.user.id, req.params.id]
    );
    res.json({ message: 'Leave status updated.' });
  } catch (err) { res.status(500).json({ error: 'Failed to update leave.' }); }
});

// Attendance
app.get('/api/attendance', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    let q = `SELECT a.*, CONCAT(e.first_name,' ',e.last_name) AS employee_name
             FROM attendance a JOIN employees e ON e.id = a.employee_id`;
    const p = [];
    if (req.user.role === 'employee') { q += ' WHERE a.employee_id = ?'; p.push(req.user.employeeId); }
    q += ' ORDER BY a.date DESC LIMIT 100';
    const [rows] = await pool.execute(q, p);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch attendance.' }); }
});

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
// Verification Gateway (Trade Test & OSH)
app.post('/api/onboarding/verify/:id', requireAuth, async (req, res) => {
  const d = req.body;
  try {
    const orientationStatus = (d.rules_ack && d.duties_ack && d.safety_ack) ? 'completed' : 'pending';
    await pool.execute(`
      UPDATE employees 
      SET trade_test_status = ?, trade_test_notes = ?, orientation_status = ?, 
          trade_test_verified_by = ?, orientation_verified_by = ?
      WHERE id = ?
    `, [
      d.trade_test_status || 'pending', d.trade_test_notes || '', 
      orientationStatus, req.user.id, req.user.id, req.params.id
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save verification' });
  }
});

// Get Main Employee List (Only Completed/Finalized Hires)
app.get('/api/employees', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM employees WHERE onboarding_status != "active" OR onboarding_status IS NULL ORDER BY id DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// Get Newly Hired (Onboarding Only)
app.get('/api/onboarding/employees', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM employees WHERE onboarding_status = "active" ORDER BY id DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// Finalize Onboarding (Move to Employee Management)
app.post('/api/onboarding/finalize/:id', requireAuth, async (req, res) => {
  try {
    // 1. Check Guardrails
    const [emp] = await pool.execute('SELECT trade_test_status, orientation_status FROM employees WHERE id = ?', [req.params.id]);
    if (!emp[0] || emp[0].trade_test_status !== 'passed' || emp[0].orientation_status !== 'completed') {
      return res.status(400).json({ error: 'Industrial Guardrail: Trade test and OSH orientation must be completed before enrollment.' });
    }

    // 2. Finalize Status
    await pool.execute('UPDATE employees SET onboarding_status = "completed", status = "Active" WHERE id = ?', [req.params.id]);

    // 3. Anchor to Blockchain
    await pool.execute(`
      INSERT INTO audit_log (user_id, action, details, employee_id)
      VALUES (?, 'BLOCKCHAIN_ANCHOR', 'Initial employment baseline secured for new hire.', ?)
    `, [req.user.id, req.params.id]);

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});
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
app.get('/api/blockchain', requireAuth, requireRole(ROLES.admin), async (req, res) => {
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



// ── SECURE ONBOARDING (Marulas Industrial Corp.) ──────────────────
const crypto = require('crypto');
const ENCRYPTION_KEY = process.env.JWT_SECRET || 'fallback_secret_32_chars_long_!!'; // Must be 32 chars
const IV_LENGTH = 16;

function encrypt(text) {
  if (!text) return null;
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch (e) { return text; }
}

app.post('/api/onboarding/register', requireAuth, async (req, res) => {
  if (req.user.role !== 'hr_admin' && req.user.role !== 'admin' && req.user.role !== 'system_admin' && req.user.role !== 'payroll_officer') {
    return res.status(403).json({ error: 'Unauthorized. HR Admin access only.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const d = req.body;
    console.log('--- NEW ONBOARDING ATTEMPT ---');
    console.log('Payload:', JSON.stringify(d, null, 2));

    // 1. Generate unique Employee Code
    const [count] = await conn.execute('SELECT COUNT(*) as total FROM employees');
    const employee_code = `EMP-${new Date().getFullYear()}-${(count[0].total + 1001).toString().slice(1)}`;

    // 2. Encrypt PII
    const encryptedData = {
      mobile: encrypt(d.mobile),
      address: encrypt(d.address),
      tin: encrypt(d.tin),
      sss: encrypt(d.sss),
      philhealth: encrypt(d.philhealth),
      pagibig: encrypt(d.pagibig)
    };

    // 3. Create Employee Record
    const dummyEmail = `${employee_code.toLowerCase()}@lgsv-hr.com`;
    const [empResult] = await conn.execute(`
      INSERT INTO employees (
        employee_code, first_name, last_name, email, dob, gender, marital_status, 
        blood_type, mobile, address, branch, worker_category, 
        position, wage_structure, tin, sss, philhealth, pagibig, data_consent, onboarding_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `, [
      employee_code, d.first_name, d.last_name, dummyEmail, d.dob, d.gender, d.marital_status,
      d.blood_type, encryptedData.mobile, encryptedData.address, d.branch, d.category,
      d.position, d.wage_structure, encryptedData.tin, encryptedData.sss, encryptedData.philhealth, encryptedData.pagibig,
      d.data_consent ? 1 : 0
    ]);

    const employee_id = empResult.insertId;

    // 4. Create User Record (Level 1 Profile)
    const tempPass = 'Welcome123!';
    const hashedPass = await bcrypt.hash(tempPass, 10);
    const timestamp = Date.now().toString().slice(-4);
    const username = `${d.first_name.toLowerCase()}.${d.last_name.toLowerCase()}.${employee_code.split('-').pop()}.${timestamp}`;
    await conn.execute(`
      INSERT INTO users (username, password_hash, role_id, employee_id)
      VALUES (?, ?, 4, ?)
    `, [username, hashedPass, employee_id]);

    // 5. Audit Log
    await conn.execute(`
      INSERT INTO audit_logs (user_id, action, details)
      VALUES (?, ?, ?)
    `, [req.user.id, 'ONBOARD_EMPLOYEE', `Added employee ${employee_code} (${d.first_name} ${d.last_name})`]);

    await conn.commit();
    res.json({ success: true, employee_code, employee_id });

  } catch (err) {
    await conn.rollback();
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Failed to complete onboarding.' });
  } finally {
    conn.release();
  }
});

app.get('/api/onboarding/dashboard', requireAuth, async (req, res) => {
  try {
    const [hires] = await pool.execute('SELECT COUNT(*) as count FROM employees WHERE onboarding_status = "active"');
    const [bio] = await pool.execute('SELECT COUNT(*) as count FROM employees WHERE onboarding_status = "active" AND biometric_status = "completed"');
    const [wage] = await pool.execute('SELECT COUNT(*) as count FROM employees WHERE onboarding_status = "active" AND wage_rate_locked = 1');
    const [hashes] = await pool.execute('SELECT COUNT(*) as count FROM employees WHERE blockchain_baseline_hash IS NOT NULL');
    
    const total = hires[0].count || 1;
    res.json({
      newHires: hires[0].count,
      biometricRate: Math.round((bio[0].count / total) * 100),
      wageReadyRate: Math.round((wage[0].count / total) * 100),
      hashes: hashes[0].count
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅  LGSV_HR running → http://localhost:${PORT}`);
});


