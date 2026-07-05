const express = require('express');

const { requireAuth } = require('./middleware');
const pool = require('../config/db');
const { revokeSessionByJwtId } = require('../db/authQueries');
const {
  auditDpaEvent,
  findCurrentDpaAcceptance,
  getCurrentDpaVersion,
  requestIp,
  requestUserAgent,
} = require('./dpa-service');

const REFRESH_COOKIE_NAME = 'refreshToken';

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/auth',
  });
}

async function getDpaStatus(req, res) {
  try {
    const version = getCurrentDpaVersion();
    const acceptance = await findCurrentDpaAcceptance(req.user.id, version);
    return res.json({
      agreement_version: version,
      accepted: Boolean(acceptance),
      accepted_at: acceptance?.Accepted_At || null,
      requires_acceptance: !acceptance,
    });
  } catch (error) {
    console.error('[DPA] status failed:', error.message);
    return res.status(500).json({ error: 'Data Privacy Agreement status could not be loaded.' });
  }
}

async function acceptDpa(req, res) {
  const version = getCurrentDpaVersion();
  const submittedVersion = String(req.body?.agreement_version || version).trim();

  if (submittedVersion !== version) {
    return res.status(409).json({
      error: 'Data Privacy Agreement version has changed. Please reload and review the latest agreement.',
      code: 'DPA_VERSION_CHANGED',
      agreement_version: version,
    });
  }

  const consent = req.body?.consent === true || req.body?.accepted === true;
  if (!consent) {
    return res.status(400).json({ error: 'Data Privacy Agreement consent is required.' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO DATA_PRIVACY_AGREEMENT_ACCEPTANCE
         (User_ID, Employee_ID, Agreement_Version, Accepted_At, IP_Address, User_Agent)
       VALUES (?, ?, ?, NOW(), ?, ?)
       ON DUPLICATE KEY UPDATE
         Acceptance_ID = LAST_INSERT_ID(Acceptance_ID)`,
      [
        req.user.id,
        req.user.employeeId || null,
        version,
        requestIp(req),
        requestUserAgent(req),
      ]
    );

    await auditDpaEvent(req, 'DPA_ACCEPTED', 'success', {
      agreement_version: version,
      user_id: req.user.id,
      employee_id: req.user.employeeId || null,
      decision: 'accepted',
      audit_scope: 'DPA acceptance with IP address and user agent',
    }, {
      connection,
      required: true,
    });

    await connection.commit();

    return res.json({
      status: 'success',
      message: 'Data Privacy Agreement accepted.',
      agreement_version: version,
      accepted: true,
    });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('[DPA] accept failed:', error.message);
    return res.status(500).json({ error: 'Data Privacy Agreement acceptance could not be saved.' });
  } finally {
    if (connection) connection.release();
  }
}

async function declineDpa(req, res) {
  const version = getCurrentDpaVersion();

  try {
    await auditDpaEvent(req, 'DPA_DECLINED', 'blocked', {
      agreement_version: version,
      user_id: req.user?.id || null,
      employee_id: req.user?.employeeId || null,
      decision: 'declined',
      audit_scope: 'DPA refusal with IP address and user agent',
    }, {
      required: true,
    });

    let revokedSessions = 0;
    if (req.user?.jti) {
      revokedSessions = await revokeSessionByJwtId(req.user.jti, 'dpa_declined').catch(error => {
        console.warn('[DPA] Session revocation after decline failed:', error.message);
        return 0;
      });
    }

    clearRefreshCookie(res);

    return res.json({
      status: 'blocked',
      message: 'Data Privacy Agreement declined. Your session has been ended.',
      code: 'DPA_DECLINED',
      agreement_version: version,
      loggedOut: true,
      shouldClose: true,
      revoked_sessions: revokedSessions,
    });
  } catch (error) {
    console.error('[DPA] decline audit failed:', error.message);
    clearRefreshCookie(res);
    return res.status(500).json({
      error: 'Data Privacy Agreement refusal could not be logged. Access remains blocked.',
      code: 'DPA_AUDIT_FAILED',
      agreement_version: version,
      loggedOut: true,
      shouldClose: true,
    });
  }
}

const router = express.Router();
router.use(requireAuth);
router.get('/status', getDpaStatus);
router.post('/accept', acceptDpa);
router.post('/decline', declineDpa);

module.exports = {
  acceptDpa,
  declineDpa,
  getDpaStatus,
  router,
};
