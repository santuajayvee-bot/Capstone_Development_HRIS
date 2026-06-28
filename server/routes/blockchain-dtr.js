const express = require('express');
const { requireAuth, requireRole } = require('../middleware');
const { authorizeLevel } = require('../middleware/authorize-level');
const {
  createDTRAdjustment,
  generateAndAnchorDTR,
  getDTRAuditTrail,
  getFinalizedDTRLedgerRecords,
  getDTRLedgerHistory,
  readDTRLedgerRecord,
  recordDTROnBlockchain,
  verifyDTRIntegrity,
} = require('../controllers/blockchainDtrController');

const router = express.Router();

const requireHrDtrFinalizer = authorizeLevel(2, {
  exact: true,
  allowedRoles: ['hr_admin', 'hr_manager'],
});

const requireDtrAnchorRole = requireRole([
  'hr_admin',
  'hr_manager',
  'system_admin',
  'admin',
]);

const requireSystemAdministrator = authorizeLevel(4, {
  exact: true,
  allowedRoles: ['system_admin', 'admin'],
});

const requireDtrViewer = requireRole([
  'employee',
  'hr_admin',
  'hr_manager',
  'payroll_officer',
  'payroll_manager',
  'system_admin',
  'admin',
]);

router.use(requireAuth);

router.get('/finalized', requireDtrViewer, getFinalizedDTRLedgerRecords);
router.post('/generate/:employeeId', requireHrDtrFinalizer, generateAndAnchorDTR);
router.post('/anchor/:dtrId', requireDtrAnchorRole, recordDTROnBlockchain);
router.get('/verify/:dtrId', requireSystemAdministrator, verifyDTRIntegrity);
router.get('/audit/:dtrId', requireDtrViewer, getDTRAuditTrail);
router.post('/adjustment/:dtrId', requireHrDtrFinalizer, createDTRAdjustment);

router.get('/ledger/:dtrId', requireSystemAdministrator, readDTRLedgerRecord);
router.get('/ledger/:dtrId/history', requireSystemAdministrator, getDTRLedgerHistory);

module.exports = router;
