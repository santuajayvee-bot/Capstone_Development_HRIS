const express = require('express');
const authController = require('../controllers/authController');

const router = express.Router();

router.post('/login', authController.login);
router.post('/mfa/verify', authController.verifyMfa);
router.post('/mfa/resend', authController.resendMfa);

module.exports = router;
