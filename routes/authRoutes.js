const express = require('express');
const authController = require('../controllers/authController');
const { requireAuth } = require('../server/middleware');

const router = express.Router();

router.get('/captcha-config', authController.captchaConfig);
router.post('/login', authController.login);
router.post('/device-approval/status', authController.deviceApprovalStatus);
router.post('/logout', requireAuth, authController.logout);
router.post('/mfa/verify', authController.verifyMfa);
router.post('/mfa/resend', authController.resendMfa);
router.get('/lockout-status', authController.lockoutStatus);

module.exports = router;
