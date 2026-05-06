/* ============================================================
   server/attendance.js — Attendance Management Controller
   Zero Trust Security · QR · Geofence · Device Binding · Audit
   ============================================================ */

const express = require('express');
const crypto  = require('crypto');
const QRCode  = require('qrcode');
const pool    = require('../config/db');
const { requireAuth, requireRole, ROLES } = require('./middleware');

const router = express.Router();

// ── Haversine formula — distance in meters between two GPS points ──
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = x => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Helper: write audit log ──
async function writeAuditLog(userId, employeeId, action, oldVal, newVal, req) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const ua = (req.headers['user-agent'] || '').substring(0, 500);
  await pool.execute(
    `INSERT INTO system_audit_log (user_id, employee_id, action_performed, old_value, new_value, ip_address, user_agent)
     VALUES (?,?,?,?,?,?,?)`,
    [userId, employeeId, action, oldVal, newVal, ip, ua]
  );
}

/* ================================================================
   1. QR CODE GENERATION (HR Admin)
   ================================================================ */
router.get('/qr/generate', requireAuth, requireRole(ROLES.hr_admin), async (req, res) => {
  try {
    const [sites] = await pool.execute('SELECT * FROM geofence_config WHERE is_active = 1 LIMIT 1');
    if (sites.length === 0) return res.status(404).json({ error: 'No active geofence configured.' });
    const site = sites[0];
    const payload = `LGSV_ATT:${site.id}:${site.site_secret}`;
    const qrDataUrl = await QRCode.toDataURL(payload, { width: 400, margin: 2 });
    res.json({ qr: qrDataUrl, site_name: site.site_name, site_id: site.id });
  } catch (err) {
    console.error('[attendance/qr/generate]', err);
    res.status(500).json({ error: 'Failed to generate QR code.' });
  }
});

/* ================================================================
   2. CLOCK-IN (Level 1: Employee)
   Validates: QR token · Geofence · Device binding · One-log rule
   ================================================================ */
router.post('/clock-in', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const empId = req.user.employeeId;
    if (!empId) return res.status(400).json({ error: 'Account not linked to employee record.' });

    const { qr_token, latitude, longitude, device_fingerprint } = req.body;
    if (!qr_token || latitude == null || longitude == null || !device_fingerprint) {
      return res.status(400).json({ error: 'Missing required fields: qr_token, latitude, longitude, device_fingerprint.' });
    }

    // 1. Validate QR token
    const parts = qr_token.split(':');
    if (parts.length !== 3 || parts[0] !== 'LGSV_ATT') {
      return res.status(400).json({ error: 'Invalid QR code format.' });
    }
    const [, siteId, secret] = parts;
    const [sites] = await pool.execute(
      'SELECT * FROM geofence_config WHERE id = ? AND site_secret = ? AND is_active = 1',
      [siteId, secret]
    );
    if (sites.length === 0) return res.status(403).json({ error: 'Invalid or expired QR code.' });
    const site = sites[0];

    // 2. Geofence validation (Bypass if DISABLE_GEOFENCE=true)
    const dist = haversineDistance(parseFloat(latitude), parseFloat(longitude), parseFloat(site.latitude), parseFloat(site.longitude));
    const isBypassed = process.env.DISABLE_GEOFENCE === 'true';

    if (!isBypassed && dist > site.radius_meters) {
      return res.status(403).json({ error: `You are ${Math.round(dist)}m away. Must be within ${site.radius_meters}m of ${site.site_name}.` });
    }

    const today = new Date().toISOString().slice(0, 10);

    // 3. Device binding check
    const [bindings] = await pool.execute(
      'SELECT * FROM device_bindings WHERE employee_id = ? AND date = ?', [empId, today]
    );
    if (bindings.length > 0 && bindings[0].device_fingerprint !== device_fingerprint) {
      return res.status(403).json({ error: 'Device mismatch. Attendance already logged from a different device today.' });
    }
    if (bindings.length === 0) {
      await pool.execute(
        'INSERT INTO device_bindings (employee_id, date, device_fingerprint) VALUES (?,?,?)',
        [empId, today, device_fingerprint]
      );
    }

    // 4. One-log rule
    const [existing] = await pool.execute(
      'SELECT * FROM attendance_log WHERE employee_id = ? AND date = ?', [empId, today]
    );
    if (existing.length > 0) {
      if (!existing[0].time_out) {
        return res.status(409).json({ error: 'Already clocked in. Please clock out first.' });
      }
      return res.status(409).json({ error: 'Attendance already completed for today.' });
    }

    // 5. Determine status (Late if after 9:00 AM)
    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 8);
    const hour = now.getHours();
    const status = hour >= 9 ? 'Late' : 'Present';

    // 6. Persist
    const [result] = await pool.execute(
      `INSERT INTO attendance_log (employee_id, date, time_in, status, device_fingerprint, clock_in_lat, clock_in_lng)
       VALUES (?,?,?,?,?,?,?)`,
      [empId, today, timeStr, status, device_fingerprint, latitude, longitude]
    );

    res.json({
      message: `Clock-in recorded at ${timeStr}`,
      attendance_id: result.insertId,
      status,
      time_in: timeStr
    });
  } catch (err) {
    console.error('[attendance/clock-in]', err);
    res.status(500).json({ error: 'Clock-in failed.' });
  }
});

/* ================================================================
   3. CLOCK-OUT (Level 1: Employee)
   ================================================================ */
router.post('/clock-out', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const empId = req.user.employeeId;
    if (!empId) return res.status(400).json({ error: 'Account not linked to employee record.' });

    const { qr_token, latitude, longitude, device_fingerprint } = req.body;
    if (!qr_token || latitude == null || longitude == null || !device_fingerprint) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    // Validate QR
    const parts = qr_token.split(':');
    if (parts.length !== 3 || parts[0] !== 'LGSV_ATT') {
      return res.status(400).json({ error: 'Invalid QR code.' });
    }
    const [sites] = await pool.execute(
      'SELECT * FROM geofence_config WHERE id = ? AND site_secret = ? AND is_active = 1',
      [parts[1], parts[2]]
    );
    if (sites.length === 0) return res.status(403).json({ error: 'Invalid QR code.' });
    const site = sites[0];

    // Geofence (Bypass if DISABLE_GEOFENCE=true)
    const dist = haversineDistance(parseFloat(latitude), parseFloat(longitude), parseFloat(site.latitude), parseFloat(site.longitude));
    const isBypassed = process.env.DISABLE_GEOFENCE === 'true';

    if (!isBypassed && dist > site.radius_meters) {
      return res.status(403).json({ error: `Outside geofence (${Math.round(dist)}m away).` });
    }

    // Device binding
    const today = new Date().toISOString().slice(0, 10);
    const [bindings] = await pool.execute(
      'SELECT * FROM device_bindings WHERE employee_id = ? AND date = ?', [empId, today]
    );
    if (bindings.length > 0 && bindings[0].device_fingerprint !== device_fingerprint) {
      return res.status(403).json({ error: 'Device mismatch.' });
    }

    // Find open session
    const [existing] = await pool.execute(
      'SELECT * FROM attendance_log WHERE employee_id = ? AND date = ? AND time_out IS NULL',
      [empId, today]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: 'No open clock-in session found for today.' });
    }

    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 8);

    await pool.execute(
      `UPDATE attendance_log SET time_out = ?, clock_out_lat = ?, clock_out_lng = ? WHERE attendance_id = ?`,
      [timeStr, latitude, longitude, existing[0].attendance_id]
    );

    res.json({ message: `Clock-out recorded at ${timeStr}`, time_out: timeStr });
  } catch (err) {
    console.error('[attendance/clock-out]', err);
    res.status(500).json({ error: 'Clock-out failed.' });
  }
});

/* ================================================================
   4. EMPLOYEE ATTENDANCE DASHBOARD (Level 1: Read-only)
   ================================================================ */
router.get('/my-records', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const empId = req.user.employeeId;
    if (!empId) return res.status(400).json({ error: 'Account not linked to employee.' });
    const { month, year } = req.query;
    let q = `SELECT * FROM attendance_log WHERE employee_id = ?`;
    const p = [empId];
    if (month && year) { q += ' AND MONTH(date) = ? AND YEAR(date) = ?'; p.push(month, year); }
    q += ' ORDER BY date DESC LIMIT 200';
    const [rows] = await pool.execute(q, p);
    res.json(rows);
  } catch (err) {
    console.error('[attendance/my-records]', err);
    res.status(500).json({ error: 'Failed to fetch records.' });
  }
});

router.get('/my-summary', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const empId = req.user.employeeId;
    if (!empId) return res.status(400).json({ error: 'Account not linked.' });
    const [rows] = await pool.execute(`
      SELECT
        COUNT(*) AS total_days,
        SUM(CASE WHEN status IN ('Present','Late') THEN 1 ELSE 0 END) AS present_days,
        SUM(CASE WHEN status = 'Late' THEN 1 ELSE 0 END) AS late_days,
        SUM(CASE WHEN absences = 1 THEN 1 ELSE 0 END) AS absent_days,
        COALESCE(SUM(overtime_hours), 0) AS total_overtime,
        COALESCE(SUM(TIMESTAMPDIFF(HOUR, time_in, COALESCE(time_out, time_in))), 0) AS total_hours
      FROM attendance_log WHERE employee_id = ? AND MONTH(date) = MONTH(CURDATE()) AND YEAR(date) = YEAR(CURDATE())
    `, [empId]);
    res.json(rows[0]);
  } catch (err) {
    console.error('[attendance/my-summary]', err);
    res.status(500).json({ error: 'Failed to fetch summary.' });
  }
});

router.get('/status', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const empId = req.user.employeeId;
    if (!empId) return res.json({ clocked_in: false });
    const today = new Date().toISOString().slice(0, 10);
    const [rows] = await pool.execute(
      'SELECT * FROM attendance_log WHERE employee_id = ? AND date = ?', [empId, today]
    );
    if (rows.length === 0) return res.json({ clocked_in: false, clocked_out: false });
    res.json({ clocked_in: true, clocked_out: !!rows[0].time_out, record: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get status.' });
  }
});

/* ================================================================
   5. HR ADMIN — ALL RECORDS + OVERVIEW
   ================================================================ */
router.get('/all', requireAuth, requireRole(ROLES.staff_any), async (req, res) => {
  try {
    const { date, month, year, search } = req.query;
    let q = `SELECT al.*, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
                    e.employee_code, d.name AS department, e.position
             FROM attendance_log al
             JOIN employees e ON e.id = al.employee_id
             LEFT JOIN departments d ON d.id = e.department_id`;
    const p = [];
    const conditions = [];
    if (date) { conditions.push('al.date = ?'); p.push(date); }
    if (month && year) { conditions.push('MONTH(al.date) = ? AND YEAR(al.date) = ?'); p.push(month, year); }
    if (search) { conditions.push("CONCAT(e.first_name,' ',e.last_name) LIKE ?"); p.push(`%${search}%`); }
    if (conditions.length) q += ' WHERE ' + conditions.join(' AND ');
    q += ' ORDER BY al.date DESC, al.time_in ASC LIMIT 500';
    const [rows] = await pool.execute(q, p);
    res.json(rows);
  } catch (err) {
    console.error('[attendance/all]', err);
    res.status(500).json({ error: 'Failed to fetch attendance.' });
  }
});

router.get('/overview', requireAuth, requireRole(ROLES.staff_any), async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [stats] = await pool.execute(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'Present' THEN 1 ELSE 0 END) AS present,
        SUM(CASE WHEN status = 'Late' THEN 1 ELSE 0 END) AS late,
        SUM(CASE WHEN absences = 1 THEN 1 ELSE 0 END) AS absent,
        SUM(CASE WHEN status = 'On Leave' THEN 1 ELSE 0 END) AS on_leave,
        COALESCE(SUM(TIMESTAMPDIFF(HOUR, time_in, COALESCE(time_out, time_in))), 0) AS total_hours,
        COALESCE(SUM(overtime_hours), 0) AS total_overtime
      FROM attendance_log WHERE date = ?
    `, [today]);
    const [empCount] = await pool.execute("SELECT COUNT(*) AS total FROM employees WHERE status = 'Active'");
    res.json({ date: today, ...stats[0], total_employees: empCount[0].total });
  } catch (err) {
    console.error('[attendance/overview]', err);
    res.status(500).json({ error: 'Failed to fetch overview.' });
  }
});

/* ================================================================
   6. HR ADMIN — OVERRIDE TIME IN/OUT (with forced audit log)
   ================================================================ */
router.patch('/:id/override', requireAuth, requireRole(ROLES.hr_admin), async (req, res) => {
  try {
    const { id } = req.params;
    const { time_in, time_out } = req.body;
    if (!time_in && !time_out) return res.status(400).json({ error: 'Provide time_in or time_out to override.' });

    // Fetch current record
    const [existing] = await pool.execute('SELECT * FROM attendance_log WHERE attendance_id = ?', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Record not found.' });
    const record = existing[0];

    const updates = [];
    const values = [];
    const oldValues = {};
    const newValues = {};

    if (time_in) {
      oldValues.time_in = record.time_in;
      newValues.time_in = time_in;
      updates.push('time_in = ?');
      values.push(time_in);
    }
    if (time_out) {
      oldValues.time_out = record.time_out;
      newValues.time_out = time_out;
      updates.push('time_out = ?');
      values.push(time_out);
    }
    values.push(id);

    await pool.execute(`UPDATE attendance_log SET ${updates.join(', ')} WHERE attendance_id = ?`, values);

    // FORCED audit log entry — non-repudiation
    await writeAuditLog(
      req.user.id,
      record.employee_id,
      `ATTENDANCE OVERRIDE [ID:${id}] Date:${record.date}`,
      JSON.stringify(oldValues),
      JSON.stringify(newValues),
      req
    );

    res.json({ message: 'Attendance record overridden. Audit log recorded.' });
  } catch (err) {
    console.error('[attendance/override]', err);
    res.status(500).json({ error: 'Override failed.' });
  }
});

/* ================================================================
   7. MANUAL OVERTIME ENCODING (HR Admin / Payroll Officer)
   ================================================================ */
router.patch('/:id/overtime', requireAuth, requireRole([...ROLES.hr_admin, ...ROLES.payroll_any]), async (req, res) => {
  try {
    const { id } = req.params;
    const { overtime_hours } = req.body;
    if (overtime_hours == null || isNaN(overtime_hours) || overtime_hours < 0) {
      return res.status(400).json({ error: 'Valid overtime_hours required (>= 0).' });
    }

    const [existing] = await pool.execute('SELECT * FROM attendance_log WHERE attendance_id = ?', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Record not found.' });

    const oldOT = existing[0].overtime_hours;
    await pool.execute('UPDATE attendance_log SET overtime_hours = ? WHERE attendance_id = ?', [overtime_hours, id]);

    await writeAuditLog(
      req.user.id,
      existing[0].employee_id,
      `OVERTIME ENCODED [ID:${id}] Date:${existing[0].date}`,
      `overtime_hours: ${oldOT}`,
      `overtime_hours: ${overtime_hours}`,
      req
    );

    res.json({ message: `Overtime updated to ${overtime_hours}h. Audit logged.` });
  } catch (err) {
    console.error('[attendance/overtime]', err);
    res.status(500).json({ error: 'Failed to encode overtime.' });
  }
});

/* ================================================================
   8. AUDIT LOG VIEWER (HR Admin only)
   ================================================================ */
router.get('/audit-log', requireAuth, requireRole(ROLES.hr_admin), async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT sal.*, u.username AS performed_by,
             CONCAT(e.first_name,' ',e.last_name) AS employee_name
      FROM system_audit_log sal
      JOIN users u ON u.id = sal.user_id
      LEFT JOIN employees e ON e.id = sal.employee_id
      ORDER BY sal.timestamp DESC LIMIT 200
    `);
    res.json(rows);
  } catch (err) {
    console.error('[attendance/audit-log]', err);
    res.status(500).json({ error: 'Failed to fetch audit log.' });
  }
});

/* ================================================================
   9. GEOFENCE CONFIG (HR Admin)
   ================================================================ */
router.get('/geofence', requireAuth, requireRole(ROLES.hr_admin), async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT id, site_name, latitude, longitude, radius_meters, is_active FROM geofence_config');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch geofence.' });
  }
});

router.put('/geofence/:id', requireAuth, requireRole(ROLES.hr_admin), async (req, res) => {
  try {
    const { site_name, latitude, longitude, radius_meters } = req.body;
    if (!site_name || latitude == null || longitude == null || !radius_meters) {
      return res.status(400).json({ error: 'All fields required.' });
    }
    await pool.execute(
      'UPDATE geofence_config SET site_name=?, latitude=?, longitude=?, radius_meters=? WHERE id=?',
      [site_name, latitude, longitude, radius_meters, req.params.id]
    );
    await writeAuditLog(req.user.id, null, `GEOFENCE UPDATED [ID:${req.params.id}]`, null, JSON.stringify({ site_name, latitude, longitude, radius_meters }), req);
    res.json({ message: 'Geofence updated.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update geofence.' });
  }
});

module.exports = router;
