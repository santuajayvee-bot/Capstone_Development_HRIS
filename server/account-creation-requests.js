const express = require('express');
const { requireAuth, requireRole } = require('./middleware');
const accountCreationRequestController = require('../controllers/accountCreationRequestController');

const router = express.Router();
const HR_ACCOUNT_REQUEST_ROLES = ['hr_admin', 'hr_manager'];

router.use(requireAuth);

// HR may directly create only the locked Regular Employee account for a hire
// that has completed both final approval and transfer to the directory.
router.get(
  '/approved-employees/:employeeId',
  requireRole(HR_ACCOUNT_REQUEST_ROLES),
  accountCreationRequestController.getApprovedTransferredEmployeeAccountStatus
);
router.post(
  '/approved-employees/:employeeId',
  requireRole(HR_ACCOUNT_REQUEST_ROLES),
  accountCreationRequestController.createApprovedTransferredEmployeeAccountForHr
);

module.exports = router;
