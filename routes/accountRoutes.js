const express = require('express');

const accountController = require('../controllers/accountController');
const { requireAuth, requireRole, ROLES } = require('../server/middleware');

const router = express.Router();

router.put('/password', requireAuth, requireRole(ROLES.any), accountController.changeOwnAccountPassword);

module.exports = router;
