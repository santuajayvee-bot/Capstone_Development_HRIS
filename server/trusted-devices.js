const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('./middleware');
const {
  createDeviceSession,
  getTrustedDeviceStatus,
  listDeviceHistory,
  listDevices,
  listSessionHistory,
  registerDevice,
  renameDevice,
  restoreDevice,
  revokeDevice,
  updateSessionStatus,
} = require('../services/trustedDeviceService');

const router = express.Router();

function currentUserId(req) {
  return Number(req.user?.id || 0);
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
    await createDeviceSession({ userId, req, fingerprint: req.body?.fingerprint || {}, loginMethod: 'Password', deviceName: req.body?.deviceName });
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

router.post('/sessions/:sessionId/terminate', async (req, res) => {
  try {
    const updated = await updateSessionStatus({ userId: currentUserId(req), sessionId: Number(req.params.sessionId), sessionStatus: 'Terminated', req });
    return res.json({ success: true, terminated: updated > 0, message: updated > 0 ? 'Session terminated.' : 'Session not found.' });
  } catch (error) {
    return safeError(res, error, 'Session could not be terminated.');
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
