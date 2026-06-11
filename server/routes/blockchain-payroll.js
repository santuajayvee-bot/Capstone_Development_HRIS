const express = require('express');
const { requireAuth } = require('../middleware');
const { authorizeLevel } = require('../middleware/authorize-level');
const {
  createPayrollAdjustmentRecord,
  finalizePayrollAndRecordOnBlockchain,
  getPayrollLedgerHistory,
  readPayrollLedgerRecord,
  verifyPayrollIntegrity,
} = require('../controllers/blockchainPayrollController');

const router = express.Router();

const requireSystemAdministrator = authorizeLevel(4, {
  exact: true,
  allowedRoles: ['system_admin', 'admin'],
});

router.post('/payroll/:payrollId/finalize-blockchain', requireAuth, requireSystemAdministrator, finalizePayrollAndRecordOnBlockchain);
router.post('/payroll/:payrollId/blockchain-adjustments', requireAuth, requireSystemAdministrator, createPayrollAdjustmentRecord);
router.get('/admin/verify-integrity/:payrollId', requireAuth, requireSystemAdministrator, verifyPayrollIntegrity);
router.get('/admin/payroll-ledger/:payrollId', requireAuth, requireSystemAdministrator, readPayrollLedgerRecord);
router.get('/admin/payroll-ledger/:payrollId/history', requireAuth, requireSystemAdministrator, getPayrollLedgerHistory);

module.exports = router;
