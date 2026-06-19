const express = require('express');
const authController = require('../controllers/authController');

const router = express.Router();

router.get('/turnstile/config', authController.turnstileConfig);
router.post('/login', authController.login);
router.post('/mfa/verify', authController.verifySmsMfa);
router.post('/mfa/resend', authController.resendSmsMfa);

module.exports = router;
