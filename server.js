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
const attendanceRoutes                       = require('./server/attendance');

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

// ── PROTECTED ────────────────────────────────────────────────
app.get('/api/auth/me', requireAuth, me);

// Payroll Routes (wages, transactions, payroll generation)
app.use('/api/payroll', payrollRoutes);

// 201-File Management (Auth required, role-based per endpoint)
app.use('/api/201-files', requireAuth, fileManagementRoutes);

// Attendance Module (QR, Geofence, Device Binding, Audit)
app.use('/api/attendance', attendanceRoutes);

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
    const { first_name, middle_name, last_name, suffix, email, contact_number, nationality, date_of_birth, gender, residential_address, emergency_contact_name, emergency_contact_num, department_id, position, employment_type, date_hired, supervisor, work_location, status, wage_type, base_rate, sewingRates } = req.body;
    
    console.log('\n=== PUT /api/employees/:id ===');
    console.log('Employee ID:', id);
    console.log('Wage Type:', wage_type);
    console.log('Base Rate:', base_rate);
    console.log('Sewing Rates:', sewingRates);
    
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
        }
      } catch (err) {
        console.warn('⚠️ Error saving wage configuration:', err.message);
        // Don't fail the whole request if wage save fails
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

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅  LGSV_HR running → http://localhost:${PORT}`);
});


