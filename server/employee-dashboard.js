/* ============================================================
   server/employee-dashboard.js — Employee Actor Module
   ============================================================
   Secure-by-Design: STRIDE Threat Model Defenses
   
   - Elevation of Privilege: requireEmployeeOnly middleware
   - Information Disclosure: AES-256-GCM PII decryption at runtime
   - Repudiation: SHA-256 hash verification (blockchain ledger)
   - Tampering: Parameterized queries + input sanitization
   ============================================================ */

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const pool    = require('../config/db');
const { requireAuth }         = require('./middleware');
const { decryptPII }          = require('./crypto');

// ── All routes require authentication ────────────────────────
router.use(requireAuth);

/* ================================================================
   MIDDLEWARE: requireEmployeeOnly
   ================================================================
   STRIDE Defense: Elevation of Privilege
   Blocks Admin/HR/Payroll tokens from accessing employee-only views.
   Logs unauthorized access attempts to system_audit_log.
   ================================================================ */
function requireEmployeeOnly(req, res, next) {
  const role = req.user?.role;

  if (role !== 'employee') {
    // Log unauthorized access attempt (non-repudiation)
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.socket?.remoteAddress || 'unknown';

    console.log(`\n🔒 [SECURITY] ELEVATION_OF_PRIVILEGE_BLOCKED`);
    console.log(`   Role '${role}' attempted to access Employee-only endpoint: ${req.method} ${req.originalUrl}`);
    console.log(`   User ID: ${req.user?.id} | IP: ${ip}`);
    console.log(`   Timestamp: ${new Date().toISOString()}`);

    // Audit trail
    pool.execute(
      `INSERT INTO system_audit_log
         (user_id, employee_id, action_performed, module, ip_address, user_agent, timestamp)
       VALUES (?, ?, ?, 'RBAC_SECURITY', ?, ?, NOW())`,
      [
        req.user?.id || 0,
        req.user?.employeeId || null,
        `ELEVATION_OF_PRIVILEGE_BLOCKED: Role '${role}' attempted Employee-only endpoint ${req.method} ${req.originalUrl}`,
        ip,
        req.headers['user-agent'] || 'unknown',
      ]
    ).catch(err => console.error('[Audit] Failed to log EoP attempt:', err.message));

    return res.status(403).json({
      error: 'Access denied.',
      message: 'This endpoint is restricted to Employee accounts only.',
      your_role: role,
    });
  }

  // Ensure employee has a linked employee_id
  if (!req.user.employeeId) {
    return res.status(403).json({
      error: 'Account not linked to an employee profile.',
      message: 'Contact your System Administrator to link your account.',
    });
  }

  next();
}

/* ================================================================
   HELPER: sanitizeInput — Tampering defense
   ================================================================ */
function sanitizeInput(str) {
  if (typeof str !== 'string') return str;
  // Strip angle brackets, null bytes, and common SQLi markers
  const cleaned = str.trim().replace(/[\x00<>]/g, '');

  // Detect SQLi payloads and log them
  const sqliPatterns = [
    /('\s*(OR|AND)\s+')/i,
    /(UNION\s+SELECT)/i,
    /(DROP\s+TABLE)/i,
    /(;\s*DELETE\s+FROM)/i,
    /(--\s*$)/,
    /(\b(SLEEP|BENCHMARK|LOAD_FILE|INTO\s+OUTFILE)\b)/i,
  ];

  for (const pattern of sqliPatterns) {
    if (pattern.test(str)) {
      console.log(`\n🛡️  [SECURITY] SQLi_PAYLOAD_BLOCKED`);
      console.log(`   Input: "${str.substring(0, 80)}"`);
      console.log(`   Pattern matched: ${pattern.source}`);
      console.log(`   Timestamp: ${new Date().toISOString()}`);
      return null; // Signal blocked input
    }
  }

  return cleaned;
}

/* ================================================================
   HELPER: computePayslipHash — SHA-256 for integrity
   ================================================================ */
function computePayslipHash(payslip, previousHash = '0'.repeat(64)) {
  const payload = JSON.stringify({
    id: payslip.id,
    employee_id: payslip.employee_id,
    wage_type_id: payslip.wage_type_id,
    total_earning: payslip.total_earning,
    total_deduction: payslip.total_deduction,
    net_pay: payslip.net_pay,
    payroll_run_id: payslip.payroll_run_id,
    status: payslip.status,
  });
  return crypto.createHash('sha256').update(payload + previousHash).digest('hex');
}

// ── Apply employee-only guard to all routes ──────────────────
router.use(requireEmployeeOnly);

/* ================================================================
   GET /api/employee/dashboard
   ================================================================
   Task 1: Employee Dashboard summary
   Returns: profile info, latest payslip summary, 201-file status,
            recent attendance, pending leave count
   ================================================================ */
router.get('/dashboard', async (req, res) => {
  try {
    const empId = req.user.employeeId;

    // 1. Employee profile
    const [empRows] = await pool.execute(
      `SELECT e.*, d.name AS department
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.id = ?`,
      [empId]
    );
    if (empRows.length === 0) {
      return res.status(404).json({ error: 'Employee profile not found.' });
    }
    const profile = empRows[0];

    // 2. Latest payslip summary
    const [payslipRows] = await pool.execute(
      `SELECT ps.id, ps.net_pay, ps.total_earning, ps.total_deduction, ps.status,
              pr.start_date AS period_start, pr.end_date AS period_end, pr.month_year
       FROM payslips ps
       JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
       WHERE ps.employee_id = ?
       ORDER BY ps.created_at DESC LIMIT 1`,
      [empId]
    );

    // 3. 201-file document count
    const [docRows] = await pool.execute(
      `SELECT COUNT(*) AS total_docs FROM documents WHERE employee_id = ?`,
      [empId]
    );

    // 4. Pending leave count
    const [leaveRows] = await pool.execute(
      `SELECT COUNT(*) AS pending FROM leave_requests WHERE employee_id = ? AND status = 'Pending'`,
      [empId]
    );

    // 5. Today's attendance
    const [attendanceRows] = await pool.execute(
      `SELECT
         CASE WHEN time_in IS NULL THEN NULL ELSE CONCAT(date, ' ', time_in) END AS clock_in,
         CASE WHEN time_out IS NULL THEN NULL ELSE CONCAT(date, ' ', time_out) END AS clock_out
       FROM attendance_log
       WHERE employee_id = ? AND date = CURDATE()
       LIMIT 1`,
      [empId]
    ).catch(() => [[]]);

    // Sanitize — never return sensitive fields
    const safeSummary = {
      profile: {
        employee_code: profile.employee_code,
        first_name: profile.first_name,
        last_name: profile.last_name,
        department: profile.department,
        position: profile.position,
        status: profile.status,
        employment_type: profile.employment_type,
      },
      latest_payslip: payslipRows[0] || null,
      documents_count: docRows[0]?.total_docs || 0,
      pending_leaves: leaveRows[0]?.pending || 0,
      today_attendance: attendanceRows[0] || null,
    };

    console.log(`\n✅ [Employee] Dashboard loaded for ${profile.first_name} ${profile.last_name} (ID: ${empId})`);

    return res.json(safeSummary);
  } catch (err) {
    console.error('[Employee] Dashboard error:', err.message);
    return res.status(500).json({ error: 'Failed to load dashboard.' });
  }
});

/* ================================================================
   GET /api/employee/201-file
   ================================================================
   Task 2: 201-File View (Information Disclosure Protection)
   Decrypts AES-256-GCM encrypted PII at runtime.
   NEVER logs plaintext PII to console.
   ================================================================ */
router.get('/201-file', async (req, res) => {
  try {
    const empId = req.user.employeeId;

    // Get employee record with encrypted PII
    const [rows] = await pool.execute(
      `SELECT e.id, e.employee_code, e.first_name, e.middle_name, e.last_name, e.suffix,
              e.email, e.contact_number, e.nationality, e.date_of_birth, e.gender,
              e.residential_address, e.emergency_contact_name, e.emergency_contact_num,
              e.employment_type, e.date_hired, e.position, e.status,
              e.encrypted_pii,
              d.name AS department
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.id = ?`,
      [empId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Employee record not found.' });
    }

    const employee = rows[0];

    // Decrypt PII using AES-256-GCM (no plaintext logging!)
    let decryptedPii = {};
    if (employee.encrypted_pii) {
      try {
        decryptedPii = decryptPII(employee.encrypted_pii);
        console.log(`\n🔐 [CRYPTO] AES-256-GCM PII decrypted for Employee ID: ${empId}`);
        console.log(`   Fields decrypted: ${Object.keys(decryptedPii).length}`);
        console.log(`   Timestamp: ${new Date().toISOString()}`);
        // SECURITY: plaintext PII is NEVER logged
      } catch (decErr) {
        console.error(`\n⚠️  [CRYPTO] PII decryption failed for Employee ID: ${empId}`);
        console.error(`   Reason: ${decErr.message}`);
      }
    }

    // Get uploaded documents
    const [docs] = await pool.execute(
      `SELECT id, document_type, file_name, uploaded_date FROM documents WHERE employee_id = ? ORDER BY document_type`,
      [empId]
    );

    // Remove encrypted_pii from response — send decrypted fields separately
    delete employee.encrypted_pii;

    // Audit this access
    await pool.execute(
      `INSERT INTO system_audit_log
         (user_id, employee_id, target_employee_id, action_performed, module, ip_address, user_agent, timestamp)
       VALUES (?, ?, ?, '201_FILE_VIEWED: Employee viewed own 201-file', 'EMPLOYEE', ?, ?, NOW())`,
      [
        req.user.id, empId, empId,
        req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
        req.headers['user-agent'] || 'unknown',
      ]
    ).catch(() => {});

    return res.json({
      demographics: employee,
      statutory_ids: {
        sss_number: decryptedPii.sss_number || '—',
        philhealth_number: decryptedPii.philhealth_number || '—',
        pagibig_number: decryptedPii.pagibig_number || '—',
        tin: decryptedPii.tin || '—',
        bank_name: decryptedPii.bank_name || '—',
        bank_account: decryptedPii.bank_account || '—',
      },
      documents: docs,
    });
  } catch (err) {
    console.error('[Employee] 201-file error:', err.message);
    return res.status(500).json({ error: 'Failed to load 201-file.' });
  }
});

/* ================================================================
   GET /api/employee/payslips
   ================================================================
   Task 3: Digital Payslip & Output Verification (Repudiation)
   Computes SHA-256 hash and verifies against blockchain ledger.
   ================================================================ */
router.get('/payslips', async (req, res) => {
  try {
    const empId = req.user.employeeId;

    const [payslips] = await pool.execute(
      `SELECT ps.*, pr.start_date AS period_start, pr.end_date AS period_end, pr.month_year, pr.status AS run_status,
              wt.name AS wage_type_name
       FROM payslips ps
       JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
       JOIN wage_types wt ON wt.id = ps.wage_type_id
       WHERE ps.employee_id = ?
       ORDER BY ps.created_at DESC`,
      [empId]
    );

    // For each payslip, verify against blockchain hash
    const verifiedPayslips = [];
    for (const ps of payslips) {
      const [hashRows] = await pool.execute(
        `SELECT sha256_hash, previous_hash, block_number FROM blockchain_hashes
         WHERE record_type = 'payslip' AND record_id = ?`,
        [ps.id]
      );

      let integrity = 'UNVERIFIED';
      let blockchainHash = null;
      let computedHash = null;

      if (hashRows.length > 0) {
        const storedHash = hashRows[0].sha256_hash;
        const prevHash = hashRows[0].previous_hash;
        computedHash = computePayslipHash(ps, prevHash);
        blockchainHash = storedHash;

        if (computedHash === storedHash) {
          integrity = 'VERIFIED';
          console.log(`\n✅ [BLOCKCHAIN] Hash MATCHED for Payslip ID: ${ps.id}`);
          console.log(`   Block #${hashRows[0].block_number}`);
          console.log(`   SHA-256: ${storedHash.substring(0, 32)}...`);
          console.log(`   Status: INTEGRITY_VERIFIED ✓`);
        } else {
          integrity = 'TAMPERED';
          console.log(`\n🚨 [BLOCKCHAIN] Hash MISMATCH for Payslip ID: ${ps.id}`);
          console.log(`   Stored:   ${storedHash.substring(0, 32)}...`);
          console.log(`   Computed: ${computedHash.substring(0, 32)}...`);
          console.log(`   Status: TAMPERED — POSSIBLE DATA MANIPULATION ✗`);

          // Log tampering to audit trail
          await pool.execute(
            `INSERT INTO system_audit_log
               (user_id, employee_id, action_performed, module, new_value, ip_address, timestamp)
             VALUES (?, ?, ?, 'BLOCKCHAIN_SECURITY', ?, ?, NOW())`,
            [
              req.user.id, empId,
              `INTEGRITY_VIOLATION: Payslip ID ${ps.id} hash mismatch detected`,
              JSON.stringify({ stored: storedHash, computed: computedHash }),
              req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
            ]
          ).catch(() => {});
        }
      }

      verifiedPayslips.push({
        id: ps.id,
        period_start: ps.period_start,
        period_end: ps.period_end,
        month_year: ps.month_year,
        wage_type: ps.wage_type_name,
        total_earning: ps.total_earning,
        total_deduction: ps.total_deduction,
        net_pay: ps.net_pay,
        status: ps.status,
        run_status: ps.run_status,
        integrity,
        blockchain_hash: blockchainHash ? blockchainHash.substring(0, 16) + '...' : null,
      });
    }

    return res.json(verifiedPayslips);
  } catch (err) {
    console.error('[Employee] Payslips error:', err.message);
    return res.status(500).json({ error: 'Failed to load payslips.' });
  }
});

/* ================================================================
   PUT /api/employee/emergency-contact
   ================================================================
   Task 4: Form Input Hardening (Tampering Protection)
   Strict sanitization on all inputs. 0% SQLi success rate.
   ================================================================ */
router.put('/emergency-contact', async (req, res) => {
  try {
    const empId = req.user.employeeId;
    const { emergency_contact_name, emergency_contact_num } = req.body;

    // Sanitize and check for SQLi
    const cleanName = sanitizeInput(emergency_contact_name || '');
    const cleanNum  = sanitizeInput(emergency_contact_num || '');

    if (cleanName === null || cleanNum === null) {
      // SQLi payload detected — blocked
      const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
      console.log(`\n🛡️  [SECURITY] SQLi_BLOCKED on /emergency-contact`);
      console.log(`   User ID: ${req.user.id} | Employee ID: ${empId}`);
      console.log(`   IP: ${ip}`);
      console.log(`   Timestamp: ${new Date().toISOString()}`);

      await pool.execute(
        `INSERT INTO system_audit_log
           (user_id, employee_id, action_performed, module, ip_address, user_agent, timestamp)
         VALUES (?, ?, 'SQLI_PAYLOAD_BLOCKED: Malicious input detected on emergency contact form', 'SECURITY', ?, ?, NOW())`,
        [req.user.id, empId, ip, req.headers['user-agent'] || 'unknown']
      ).catch(() => {});

      return res.status(400).json({ error: 'Invalid input detected and blocked.' });
    }

    if (!cleanName || !cleanNum) {
      return res.status(400).json({ error: 'Both contact name and number are required.' });
    }

    // Phone number validation
    if (!/^[\d\s+\-()]{7,20}$/.test(cleanNum)) {
      return res.status(400).json({ error: 'Invalid phone number format.' });
    }

    // Parameterized query — immune to SQLi by design
    await pool.execute(
      'UPDATE employees SET emergency_contact_name = ?, emergency_contact_num = ? WHERE id = ?',
      [cleanName, cleanNum, empId]
    );

    // Audit
    await pool.execute(
      `INSERT INTO system_audit_log
         (user_id, employee_id, target_employee_id, action_performed, module, ip_address, timestamp)
       VALUES (?, ?, ?, 'EMERGENCY_CONTACT_UPDATED: Employee updated emergency contact info', 'EMPLOYEE', ?, NOW())`,
      [req.user.id, empId, empId, req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown']
    ).catch(() => {});

    console.log(`\n✅ [Employee] Emergency contact updated for Employee ID: ${empId}`);

    return res.json({ message: 'Emergency contact updated successfully.' });
  } catch (err) {
    console.error('[Employee] Emergency contact update error:', err.message);
    return res.status(500).json({ error: 'Failed to update emergency contact.' });
  }
});

module.exports = router;
