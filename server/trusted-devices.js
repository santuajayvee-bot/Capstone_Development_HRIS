const express = require('express');
const pool = require('../config/db');
const { revokeSessionById, revokeSessionByJwtId } = require('../db/authQueries');
const { requireAuth } = require('./middleware');
const {
  approveDeviceRequest,
  getTrustedDeviceStatus,
  listApprovalRequests,
  listDeviceActivity,
  listDeviceHistory,
  listDevices,
  listSecurityNotifications,
  listSessionHistory,
  markNotificationRead,
  registerDevice,
  renameDevice,
  restoreDevice,
  revokeDevice,
  securitySummary,
  updateApprovalRequestStatus,
  updateSessionStatus,
} = require('../services/trustedDeviceService');

const router = express.Router();

function currentUserId(req) {
  return Number(req.user?.id || 0);
}

async function revokeAuthSessionForDeviceSession(session, reason = 'device_session_terminated') {
  if (!session) return 0;
  let revoked = 0;
  if (session.jwtId) {
    revoked += await revokeSessionByJwtId(session.jwtId, reason);
  }
  if (!revoked && session.userSessionId) {
    revoked += await revokeSessionById(session.userSessionId, reason);
  }
  return revoked;
}

function activeSessionDeviceKey(session = {}) {
  const browser = String(session.browser || '').trim().toLowerCase();
  const os = String(session.operatingSystem || '').trim().toLowerCase();
  const ip = String(session.ipAddress || '').trim().toLowerCase();
  if (browser || os || ip) return `meta:${browser}|${os}|${ip}`;
  if (session.deviceId) return `device:${session.deviceId}`;
  return `session:${session.id}`;
}

function sessionHasSpecificDeviceName(session = {}) {
  const name = String(session.deviceName || '').trim().toLowerCase();
  return Boolean(name && name !== 'current device' && name !== 'device session');
}

function sessionTimeValue(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

async function activeSessionsForResponse(req, sessions) {
  const activeSessions = sessions
    .filter(session => session.sessionStatus === 'Active')
    .map(session => ({
      ...session,
      isCurrent: session.jwtId && req.user?.jti ? session.jwtId === req.user.jti : session.isCurrent,
    }));
  const selected = new Map();
  const stale = [];

  for (const session of activeSessions) {
    const key = activeSessionDeviceKey(session);
    const existing = selected.get(key);
    if (!existing) {
      selected.set(key, session);
      continue;
    }

    const sessionScore = [
      session.isCurrent ? 4 : 0,
      sessionHasSpecificDeviceName(session) ? 2 : 0,
      sessionTimeValue(session.lastActivity || session.loginAt) / 1e13,
    ].reduce((sum, part) => sum + part, 0);
    const existingScore = [
      existing.isCurrent ? 4 : 0,
      sessionHasSpecificDeviceName(existing) ? 2 : 0,
      sessionTimeValue(existing.lastActivity || existing.loginAt) / 1e13,
    ].reduce((sum, part) => sum + part, 0);

    if (sessionScore > existingScore) {
      stale.push(existing);
      selected.set(key, session);
    } else {
      stale.push(session);
    }
  }

  for (const session of stale) {
    await revokeAuthSessionForDeviceSession(session, 'device_session_superseded');
    await updateSessionStatus({
      userId: currentUserId(req),
      sessionId: Number(session.id),
      sessionStatus: 'Superseded',
      req,
    });
  }

  return [...selected.values()].sort((a, b) => sessionTimeValue(b.loginAt) - sessionTimeValue(a.loginAt));
}

async function getPasswordHash(userId) {
  const [rows] = await pool.execute(
    'SELECT password_hash FROM users WHERE id = ? LIMIT 1',
    [userId]
  );
  return rows[0]?.password_hash || null;
}

function safeError(res, error, fallback = 'Trusted device request could not be completed.') {
  const status = Number(error?.status || error?.statusCode || 500);
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    error: status >= 500 ? fallback : error.message,
  });
}

router.use(requireAuth);

router.post('/status', async (req, res) => {
  try {
    const status = await getTrustedDeviceStatus(currentUserId(req), req.body?.fingerprint || {}, req);
    return res.json({
      trusted: status.trusted,
      registered: Boolean(status.device),
      revoked: Boolean(status.device?.revoked_at),
    });
  } catch (error) {
    return safeError(res, error, 'Trusted device status could not be loaded.');
  }
});

router.get('/security-summary', async (req, res) => {
  try {
    return res.json(await securitySummary(currentUserId(req)));
  } catch (error) {
    return safeError(res, error, 'Security summary could not be loaded.');
  }
});

router.get('/activity', async (req, res) => {
  try {
    const events = await listDeviceActivity({
      userId: currentUserId(req),
      search: req.query?.search || '',
      riskLevel: req.query?.riskLevel || '',
      status: req.query?.status || '',
      limit: req.query?.limit || 100,
      offset: req.query?.offset || 0,
    });
    return res.json(events);
  } catch (error) {
    return safeError(res, error, 'Device activity could not be loaded.');
  }
});

router.get('/activity/export', async (req, res) => {
  try {
    const events = await listDeviceActivity({
      userId: currentUserId(req),
      search: req.query?.search || '',
      riskLevel: req.query?.riskLevel || '',
      status: req.query?.status || '',
      limit: 500,
      offset: 0,
    });
    const header = ['Date/Time', 'User', 'Device', 'Browser', 'OS', 'IP Address', 'Location', 'Status', 'Risk Level'];
    const csv = [header, ...events.map(row => [
      row.createdAt,
      row.user,
      row.deviceName,
      row.browser,
      row.operatingSystem,
      row.ipAddress,
      row.location,
      row.status,
      row.riskLevel,
    ])].map(cols => cols.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="device-activity-logs.csv"');
    return res.send(csv);
  } catch (error) {
    return safeError(res, error, 'Device activity export could not be generated.');
  }
});

router.get('/notifications', async (req, res) => {
  try {
    return res.json(await listSecurityNotifications(currentUserId(req), req.query?.unread === '1'));
  } catch (error) {
    return safeError(res, error, 'Security notifications could not be loaded.');
  }
});

router.post('/notifications/:notificationId/read', async (req, res) => {
  try {
    const updated = await markNotificationRead(currentUserId(req), Number(req.params.notificationId));
    return res.json({ success: true, updated });
  } catch (error) {
    return safeError(res, error, 'Security notification could not be updated.');
  }
});

router.get('/approval-requests', async (req, res) => {
  try {
    return res.json(await listApprovalRequests(currentUserId(req)));
  } catch (error) {
    return safeError(res, error, 'Device approval requests could not be loaded.');
  }
});

router.post('/approval-requests/:requestId/approve', async (req, res) => {
  try {
    const result = await approveDeviceRequest({ userId: currentUserId(req), requestId: Number(req.params.requestId), req });
    return res.json({ success: true, message: 'Device trusted.', ...result });
  } catch (error) {
    return safeError(res, error, 'Device approval could not be completed.');
  }
});

router.post('/approval-requests/:requestId/ignore', async (req, res) => {
  try {
    await updateApprovalRequestStatus({ userId: currentUserId(req), requestId: Number(req.params.requestId), status: 'Ignored', req });
    return res.json({ success: true, message: 'Unknown device ignored.' });
  } catch (error) {
    return safeError(res, error, 'Device approval request could not be ignored.');
  }
});

router.post('/approval-requests/:requestId/secure-account', async (req, res) => {
  try {
    await updateApprovalRequestStatus({ userId: currentUserId(req), requestId: Number(req.params.requestId), status: 'Secured', req });
    return res.json({ success: true, message: 'Security event marked for account protection.' });
  } catch (error) {
    return safeError(res, error, 'Secure-account action could not be completed.');
  }
});

router.post('/', async (req, res) => {
  try {
    const devices = await listDevices(currentUserId(req), req.body?.fingerprint || {}, req);
    return res.json(devices);
  } catch (error) {
    return safeError(res, error, 'Trusted devices could not be loaded.');
  }
});

router.post('/register', async (req, res) => {
  try {
    const userId = currentUserId(req);
    const passwordHash = await getPasswordHash(userId);
    const result = await registerDevice({
      userId,
      fingerprint: req.body?.fingerprint || {},
      password: req.body?.password,
      passwordHash,
      deviceName: req.body?.deviceName,
      req,
    });
    return res.status(201).json({ success: true, message: 'Current device registered as trusted.', deviceHash: result.deviceHash });
  } catch (error) {
    if (error?.code === 'DEVICE_RESTORE_REQUIRED') {
      return res.status(409).json({ error: error.message, restoreRequired: true, deviceId: error.deviceId });
    }
    return safeError(res, error, 'Trusted device could not be registered.');
  }
});

router.post('/restore', async (req, res) => {
  try {
    await restoreDevice({ userId: currentUserId(req), deviceId: Number(req.body?.deviceId), req });
    return res.json({ success: true, message: 'Device restored.' });
  } catch (error) {
    return safeError(res, error, 'Trusted device could not be restored.');
  }
});

router.get('/history', async (req, res) => {
  try {
    const devices = await listDeviceHistory(currentUserId(req));
    return res.json(devices);
  } catch (error) {
    return safeError(res, error, 'Device history could not be loaded.');
  }
});

router.get('/sessions', async (req, res) => {
  try {
    const sessions = await listSessionHistory(currentUserId(req));
    return res.json(sessions);
  } catch (error) {
    return safeError(res, error, 'Session history could not be loaded.');
  }
});

router.get('/active-sessions', async (req, res) => {
  try {
    const sessions = await listSessionHistory(currentUserId(req));
    return res.json(await activeSessionsForResponse(req, sessions));
  } catch (error) {
    return safeError(res, error, 'Active sessions could not be loaded.');
  }
});

router.post('/sessions/:sessionId/terminate', async (req, res) => {
  try {
    const userId = currentUserId(req);
    const sessionId = Number(req.params.sessionId);
    const sessions = await listSessionHistory(userId);
    const session = sessions.find(item => Number(item.id) === sessionId);
    const revoked = await revokeAuthSessionForDeviceSession(session);
    const updated = await updateSessionStatus({ userId, sessionId, sessionStatus: 'Terminated', req });
    return res.json({ success: true, terminated: updated > 0, revoked, message: updated > 0 ? 'Session terminated.' : 'Session not found.' });
  } catch (error) {
    return safeError(res, error, 'Session could not be terminated.');
  }
});

router.post('/active-sessions/:sessionId/logout', async (req, res) => {
  try {
    const userId = currentUserId(req);
    const sessionId = Number(req.params.sessionId);
    const sessions = await listSessionHistory(userId);
    const session = sessions.find(item => Number(item.id) === sessionId);
    const revoked = await revokeAuthSessionForDeviceSession(session);
    const updated = await updateSessionStatus({ userId, sessionId, sessionStatus: 'Terminated', req });
    return res.json({ success: true, terminated: updated > 0, revoked, message: updated > 0 ? 'Session terminated.' : 'Session not found.' });
  } catch (error) {
    return safeError(res, error, 'Session could not be terminated.');
  }
});

router.post('/active-sessions/logout-others', async (req, res) => {
  try {
    const sessions = await listSessionHistory(currentUserId(req));
    let terminated = 0;
    let revoked = 0;
    for (const session of sessions.filter(item => item.sessionStatus === 'Active' && (item.jwtId ? item.jwtId !== req.user?.jti : !item.isCurrent))) {
      revoked += await revokeAuthSessionForDeviceSession(session);
      terminated += await updateSessionStatus({ userId: currentUserId(req), sessionId: Number(session.id), sessionStatus: 'Terminated', req });
    }
    return res.json({ success: true, terminated, revoked, message: 'Other active device sessions terminated.' });
  } catch (error) {
    return safeError(res, error, 'Other sessions could not be terminated.');
  }
});

router.put('/:deviceId', async (req, res) => {
  try {
    await renameDevice({
      userId: currentUserId(req),
      deviceId: Number(req.params.deviceId),
      deviceName: req.body?.deviceName,
      req,
    });
    return res.json({ success: true, message: 'Device renamed.' });
  } catch (error) {
    return safeError(res, error, 'Trusted device could not be renamed.');
  }
});

router.delete('/:deviceId', async (req, res) => {
  try {
    const userId = currentUserId(req);
    const passwordHash = await getPasswordHash(userId);
    await revokeDevice({
      userId,
      deviceId: Number(req.params.deviceId),
      password: req.body?.password,
      passwordHash,
      req,
    });
    return res.json({ success: true, message: 'Device revoked.' });
  } catch (error) {
    return safeError(res, error, 'Trusted device could not be revoked.');
  }
});

module.exports = router;
