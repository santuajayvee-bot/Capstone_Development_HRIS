const {
  AccountCreationRequestError,
  approveAccountCreationRequest,
  createApprovedTransferredEmployeeAccount,
  createAccountCreationRequest,
  getApprovedTransferredEmployeeAccount,
  getAccountRequestForEmployee,
  listAccountCreationRequests,
  rejectAccountCreationRequest,
} = require('../services/accountCreationRequestService');

function requestErrorResponse(res, error) {
  if (error instanceof AccountCreationRequestError) {
    return res.status(error.statusCode).json({
      success: false,
      error: error.message,
      code: error.code,
    });
  }
  console.error('[accountCreationRequestController]', error.message);
  return res.status(500).json({
    success: false,
    error: 'Account creation request could not be completed.',
  });
}

async function getApprovedTransferredEmployeeAccountStatus(req, res) {
  try {
    const result = await getApprovedTransferredEmployeeAccount(req.params.employeeId);
    return res.json({ success: true, ...result });
  } catch (error) {
    return requestErrorResponse(res, error);
  }
}

async function createApprovedTransferredEmployeeAccountForHr(req, res) {
  try {
    const result = await createApprovedTransferredEmployeeAccount({
      req,
      employeeId: req.params.employeeId,
      body: req.body || {},
    });
    return res.status(201).json({
      success: true,
      message: 'Regular Employee account created. The employee must change the temporary password after login.',
      ...result,
    });
  } catch (error) {
    return requestErrorResponse(res, error);
  }
}

async function requestAccountForEmployee(req, res) {
  try {
    const request = await createAccountCreationRequest({
      req,
      employeeId: req.params.employeeId,
      body: req.body || {},
    });
    return res.status(201).json({
      success: true,
      message: 'Account creation request sent to the System Administrator.',
      request,
    });
  } catch (error) {
    return requestErrorResponse(res, error);
  }
}

async function getEmployeeAccountRequest(req, res) {
  try {
    const request = await getAccountRequestForEmployee(req.params.employeeId);
    return res.json({ success: true, request });
  } catch (error) {
    return requestErrorResponse(res, error);
  }
}

async function listMyAccountRequests(req, res) {
  try {
    const requests = await listAccountCreationRequests({
      requestedBy: req.user.id,
      status: req.query.status || null,
    });
    return res.json({ success: true, requests });
  } catch (error) {
    return requestErrorResponse(res, error);
  }
}

async function listAllAccountRequests(req, res) {
  try {
    const requests = await listAccountCreationRequests({
      status: req.query.status || null,
    });
    return res.json({ success: true, requests });
  } catch (error) {
    return requestErrorResponse(res, error);
  }
}

async function approveRequest(req, res) {
  try {
    const result = await approveAccountCreationRequest({
      req,
      requestId: req.params.requestId,
      body: req.body || {},
    });
    return res.json({
      success: true,
      message: 'Employee account created and activated. The employee must change the temporary password after login.',
      request: result.request,
      generatedTemporaryPassword: result.generatedTemporaryPassword,
    });
  } catch (error) {
    return requestErrorResponse(res, error);
  }
}

async function rejectRequest(req, res) {
  try {
    const request = await rejectAccountCreationRequest({
      req,
      requestId: req.params.requestId,
      body: req.body || {},
    });
    return res.json({
      success: true,
      message: 'Account creation request rejected.',
      request,
    });
  } catch (error) {
    return requestErrorResponse(res, error);
  }
}

module.exports = {
  approveRequest,
  createApprovedTransferredEmployeeAccountForHr,
  getEmployeeAccountRequest,
  getApprovedTransferredEmployeeAccountStatus,
  listAllAccountRequests,
  listMyAccountRequests,
  rejectRequest,
  requestAccountForEmployee,
};
