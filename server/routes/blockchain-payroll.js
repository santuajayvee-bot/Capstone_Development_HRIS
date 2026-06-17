const express = require('express');
const { requireAuth, requireRole } = require('../middleware');
const { authorizeLevel } = require('../middleware/authorize-level');
const {
  createPayrollAdjustment,
  finalizePayrollAndRecordOnBlockchain,
  getBlockchainAuditTrail,
  getFinalizedPayrollLedgerRecords,
  getPayrollLedgerHistory,
  readPayrollLedgerRecord,
  verifyPayrollIntegrity,
} = require('../controllers/blockchainPayrollController');

const router = express.Router();

const requirePayrollManager = authorizeLevel(3, {
  exact: true,
  allowedRoles: ['payroll_manager'],
});

const requireSystemAdministrator = authorizeLevel(4, {
  exact: true,
  allowedRoles: ['system_admin', 'admin'],
});

const requireBlockchainViewer = requireRole([
  'payroll_officer',
  'payroll_manager',
  'system_admin',
  'admin',
]);

const requireAdjustmentRole = requireRole([
  'payroll_manager',
  'system_admin',
  'admin',
]);

router.use(requireAuth);

router.get('/finalized', requireBlockchainViewer, getFinalizedPayrollLedgerRecords);
router.post('/finalize/:payrollId', requirePayrollManager, finalizePayrollAndRecordOnBlockchain);
router.get('/verify/:payrollId', requireSystemAdministrator, verifyPayrollIntegrity);
router.get('/audit/:payrollId', requireBlockchainViewer, getBlockchainAuditTrail);
router.post('/adjustment/:payrollId', requireAdjustmentRole, createPayrollAdjustment);

router.get('/ledger/:payrollId', requireSystemAdministrator, readPayrollLedgerRecord);
router.get('/ledger/:payrollId/history', requireSystemAdministrator, getPayrollLedgerHistory);

module.exports = router;
