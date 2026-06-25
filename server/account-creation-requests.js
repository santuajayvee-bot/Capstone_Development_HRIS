const express = require('express');
const { requireAuth, requireRole, ROLES } = require('./middleware');
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

// HR submits only a default Regular Employee request after the employee is
// approved and transferred. This legacy route remains for existing request
// records; new onboarding account creation uses the direct route above.
router.post(
  '/employees/:employeeId',
  requireRole(HR_ACCOUNT_REQUEST_ROLES),
  accountCreationRequestController.requestAccountForEmployee
);
router.get('/mine', requireRole(HR_ACCOUNT_REQUEST_ROLES), accountCreationRequestController.listMyAccountRequests);
router.get(
  '/employee/:employeeId',
  requireRole(HR_ACCOUNT_REQUEST_ROLES),
  accountCreationRequestController.getEmployeeAccountRequest
);

// Only Level 4 can approve/reject a request, issue a temporary password, and
// optionally select a role above the default Level 1 employee role.
router.get('/', requireRole(ROLES.admin_any), accountCreationRequestController.listAllAccountRequests);
router.patch('/:requestId/approve', requireRole(ROLES.admin_any), accountCreationRequestController.approveRequest);
router.patch('/:requestId/reject', requireRole(ROLES.admin_any), accountCreationRequestController.rejectRequest);

module.exports = router;
