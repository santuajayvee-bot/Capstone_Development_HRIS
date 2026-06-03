/* ============================================================
   Repeatable secure onboarding lifecycle integration test.
   Requires the local server and migrated schema.
   ============================================================ */

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const pool = require('./config/db');
const { decryptPII } = require('./server/crypto');

const baseUrl = `http://localhost:${process.env.PORT || 3000}`;
const nonce = String(Date.now()).slice(-8);
const applicantIds = [];
const employeeIds = [];
const documentPaths = [];
let deviceId;

function check(message, condition) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
}

function issueToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, employeeId: user.employee_id },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function jsonHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function api(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data, response };
}

async function run() {
  const [users] = await pool.query(`
    SELECT u.id, u.username, u.employee_id, r.name AS role
      FROM users u
      JOIN roles r ON r.id = u.role_id
  `);
  const hrAdmin = users.find(user => user.role === 'hr_admin');
  const sysAdmin = users.find(user => user.role === 'system_admin');
  const payrollOfficer = users.find(user => user.role === 'payroll_officer');
  check('Required HR, system admin, and payroll roles exist', hrAdmin && sysAdmin && payrollOfficer);
  const hrToken = issueToken(hrAdmin);
  const sysAdminToken = issueToken(sysAdmin);
  const payrollToken = issueToken(payrollOfficer);

  let result = await api('/api/onboarding/dashboard', { headers: jsonHeaders(payrollToken) });
  check('Payroll officer cannot enter HR onboarding', result.status === 403);

  result = await api('/api/onboarding/lookups', { headers: jsonHeaders(hrToken) });
  check('HR admin can load onboarding lookups', result.status === 200 && result.data.wage_types.length > 0);
  const wageTypeId = result.data.wage_types[0].id;

  const [device] = await pool.execute(
    `INSERT INTO biometric_device (device_reference, device_name, vendor, auth_type)
     VALUES (?, 'Temporary Onboarding Test Scanner', 'LGSV Test', 'NONE')`,
    [`TEST-ONB-BIO-${nonce}`]
  );
  deviceId = device.insertId;

  const directEmail = `direct.${nonce}@example.test`;
  const directContact = `0917${nonce}`;
  const directAddress = `Encrypted Direct Address ${nonce}`;
  result = await api('/api/onboarding/applicants', {
    method: 'POST',
    headers: jsonHeaders(hrToken),
    body: JSON.stringify({
      first_name: 'Direct',
      last_name: `Hire${nonce}`,
      email: directEmail,
      contact_number: directContact,
      residential_address: directAddress,
      residential_address_lat: '14.6842',
      residential_address_lng: '120.9744',
      current_address: directAddress,
      current_address_lat: '14.6842',
      current_address_lng: '120.9744',
      current_address_same_as_home: 1,
      mailing_address: directAddress,
      mailing_address_lat: '14.6842',
      mailing_address_lng: '120.9744',
      mailing_address_same_as_home: 1,
      work_email: `work.${nonce}@example.test`,
      nationality: 'Filipino',
      date_of_birth: '1995-02-14',
      place_of_birth: 'Valenzuela City',
      place_of_birth_lat: '14.7011',
      place_of_birth_lng: '120.9830',
      gender: 'Female',
      civil_status: 'Single',
      blood_type: 'O+',
      religion: 'Catholic',
      emergency_contact_name: 'Emergency Contact',
      emergency_contact_relationship: 'Sibling',
      emergency_contact_number: '09171234567',
      desired_employment_type: 'Part-time',
      supervisor: 'Test Supervisor',
      shift_schedule: 'Day Shift (8:00 AM - 5:00 PM)',
      employee_level: 'Manager',
      payroll_schedule: 'Monthly',
      allowances: 500,
      tin: `TIN-${nonce}`,
      sss_number: `SSS-${nonce}`,
      philhealth_number: `PH-${nonce}`,
      pagibig_number: `PI-${nonce}`,
      bank_name: 'BDO',
      bank_account: `BANK-${nonce}`,
      hiring_type: 'Direct Hire',
      applied_position: 'Manager',
      branch: 'Marulas Plant',
      expected_wage_type_id: wageTypeId,
      expected_base_rate: 650,
    }),
  });
  check('Direct-hire applicant enters approval route', result.status === 201 && result.data.workflow_status === 'For Approval');
  const directApplicantId = result.data.applicant_id;
  applicantIds.push(directApplicantId);

  let [employees] = await pool.execute('SELECT id FROM employees WHERE email = ?', [directEmail]);
  check('Applicant stays outside Employee Directory before transfer', employees.length === 0);
  let [[storedApplicant]] = await pool.execute('SELECT * FROM onboarding_applicant WHERE applicant_id = ?', [directApplicantId]);
  check('Applicant email is encrypted off-chain', !storedApplicant.email_encrypted.includes(directEmail));
  check('Applicant contact and address are encrypted off-chain', !storedApplicant.pii_encrypted.includes(directContact) && !storedApplicant.pii_encrypted.includes(directAddress));
  result = await api(`/api/onboarding/applicants/${directApplicantId}`, { headers: jsonHeaders(hrToken) });
  check('Expanded standard HR profile is retrievable by HR only', result.status === 200 && result.data.gender === 'Female' && result.data.shift_schedule === 'Day Shift (8:00 AM - 5:00 PM)' && result.data.bank_name === 'BDO');

  const documentBody = Buffer.from(`%PDF-1.4 secure onboarding test ${nonce}`);
  const upload = new FormData();
  upload.append('document_type', 'Application Form');
  upload.append('file', new Blob([documentBody], { type: 'application/pdf' }), `application-${nonce}.pdf`);
  result = await api(`/api/onboarding/applicants/${directApplicantId}/documents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hrToken}` },
    body: upload,
  });
  check('Prepared 201-file document is accepted', result.status === 201);
  const documentId = result.data.document_id;
  let [[storedDocument]] = await pool.execute('SELECT * FROM onboarding_applicant_document WHERE document_id = ?', [documentId]);
  documentPaths.push(storedDocument.encrypted_file_path);
  check('Prepared document vault is outside the public folder', !storedDocument.encrypted_file_path.includes(`${path.sep}public${path.sep}`));
  const vaultPayload = await fs.promises.readFile(storedDocument.encrypted_file_path, 'utf8');
  check('Prepared document bytes are encrypted at rest', !vaultPayload.includes(`secure onboarding test ${nonce}`));

  let download = await fetch(`${baseUrl}/api/onboarding/applicants/${directApplicantId}/documents/${documentId}/download`, {
    headers: { Authorization: `Bearer ${hrToken}` },
  });
  check('Authorized HR admin can download prepared document', download.status === 200 && Buffer.compare(Buffer.from(await download.arrayBuffer()), documentBody) === 0);

  result = await api(`/api/onboarding/applicants/${directApplicantId}/documents/${documentId}/verify`, {
    method: 'PATCH',
    headers: jsonHeaders(hrToken),
    body: JSON.stringify({ verification_status: 'Verified' }),
  });
  check('HR admin can verify prepared 201-file document', result.status === 200);

  result = await api(`/api/onboarding/applicants/${directApplicantId}/decision`, {
    method: 'PATCH',
    headers: jsonHeaders(hrToken),
    body: JSON.stringify({ approval_status: 'Approved', reason: 'Direct hire requirements verified.' }),
  });
  check('Direct hire can be approved after HR review', result.status === 200);

  result = await api(`/api/onboarding/applicants/${directApplicantId}/transfer`, {
    method: 'POST',
    headers: jsonHeaders(hrToken),
    body: JSON.stringify({ employee_code: `TST-D-${nonce}`, reason: 'Approved direct hire transferred.' }),
  });
  check('Approved direct hire transfers into Employee Directory', result.status === 201);
  const directEmployeeId = result.data.employee_id;
  employeeIds.push(directEmployeeId);

  let [[directEmployee]] = await pool.execute('SELECT * FROM employees WHERE id = ?', [directEmployeeId]);
  check('Official employee receives encrypted PII and payroll identity', directEmployee.encrypted_pii && directEmployee.wage_type_id === wageTypeId);
  const officialPii = decryptPII(directEmployee.encrypted_pii);
  check('Expanded encrypted HR profile survives directory transfer', officialPii.tin === `TIN-${nonce}` && officialPii.bank_account === `BANK-${nonce}` && officialPii.residential_address_lat === '14.6842' && officialPii.place_of_birth_lat === '14.7011' && directEmployee.employment_type === 'Part-time' && directEmployee.supervisor === 'Test Supervisor');
  let [wageRows] = await pool.execute('SELECT * FROM employee_wage_rates WHERE employee_id = ?', [directEmployeeId]);
  check('Transfer creates payroll-ready wage rate', wageRows.length === 1 && Number(wageRows[0].rate) === 650);
  [[storedDocument]] = await pool.execute('SELECT * FROM onboarding_applicant_document WHERE document_id = ?', [documentId]);
  check('Prepared document is linked to official employee 201-file', storedDocument.transferred_employee_id === directEmployeeId);

  result = await api(`/api/onboarding/applicants/${directApplicantId}`, {
    method: 'DELETE',
    headers: jsonHeaders(hrToken),
    body: JSON.stringify({ reason: 'Transferred hire must remain protected.' }),
  });
  check('Transferred hire cannot be deleted from onboarding', result.status === 400);

  result = await api('/api/onboarding/applicants', {
    method: 'POST',
    headers: jsonHeaders(hrToken),
    body: JSON.stringify({
      first_name: 'Archive',
      last_name: `Candidate${nonce}`,
      email: `archive.${nonce}@example.test`,
      contact_number: '09175550123',
      residential_address: 'Temporary archive address',
      hiring_type: 'Direct Hire',
      applied_position: 'Manager',
      branch: 'Marulas Plant',
    }),
  });
  check('Temporary applicant for removal is created', result.status === 201);
  const archivedApplicantId = result.data.applicant_id;
  applicantIds.push(archivedApplicantId);

  const archivedDocumentBody = Buffer.from(`%PDF-1.4 archive cleanup test ${nonce}`);
  const archivedUpload = new FormData();
  archivedUpload.append('document_type', 'Application Form');
  archivedUpload.append('file', new Blob([archivedDocumentBody], { type: 'application/pdf' }), `archive-${nonce}.pdf`);
  result = await api(`/api/onboarding/applicants/${archivedApplicantId}/documents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hrToken}` },
    body: archivedUpload,
  });
  check('Temporary applicant document is prepared before removal', result.status === 201);
  const [[archivedDocument]] = await pool.execute(
    'SELECT encrypted_file_path FROM onboarding_applicant_document WHERE document_id = ?',
    [result.data.document_id]
  );
  check('Temporary applicant encrypted vault file exists', fs.existsSync(archivedDocument.encrypted_file_path));

  result = await api(`/api/onboarding/applicants/${archivedApplicantId}`, {
    method: 'DELETE',
    headers: jsonHeaders(payrollToken),
    body: JSON.stringify({ reason: 'Payroll role must not remove applicants.' }),
  });
  check('Payroll officer cannot delete onboarding applicants', result.status === 403);

  result = await api(`/api/onboarding/applicants/${archivedApplicantId}`, {
    method: 'DELETE',
    headers: jsonHeaders(hrToken),
    body: JSON.stringify({ reason: 'short' }),
  });
  check('Applicant deletion requires an audit reason', result.status === 400);

  result = await api(`/api/onboarding/applicants/${archivedApplicantId}`, {
    method: 'DELETE',
    headers: jsonHeaders(hrToken),
    body: JSON.stringify({ reason: 'Duplicate applicant record removed by HR.' }),
  });
  check('HR admin can remove pre-employment applicant', result.status === 200 && result.data.vault_cleanup_pending === 0);
  check('Applicant removal purges encrypted vault files', !fs.existsSync(archivedDocument.encrypted_file_path));
  const [[archivedApplicant]] = await pool.execute('SELECT deleted_at, deletion_reason FROM onboarding_applicant WHERE applicant_id = ?', [archivedApplicantId]);
  check('Applicant removal retains soft-delete audit metadata', archivedApplicant.deleted_at && archivedApplicant.deletion_reason === 'Duplicate applicant record removed by HR.');
  result = await api(`/api/onboarding/applicants/${archivedApplicantId}`, { headers: jsonHeaders(hrToken) });
  check('Removed applicant is hidden from active detail route', result.status === 404);
  result = await api('/api/onboarding/applicants', { headers: jsonHeaders(hrToken) });
  check('Removed applicant is hidden from active onboarding list', result.status === 200 && !result.data.some(applicant => Number(applicant.applicant_id) === Number(archivedApplicantId)));

  result = await api('/api/onboarding/applicants', {
    method: 'POST',
    headers: jsonHeaders(hrToken),
    body: JSON.stringify({
      first_name: 'Missing',
      last_name: 'Agency',
      email: `missing.${nonce}@example.test`,
      contact_number: '09170000000',
      residential_address: 'Test address',
      hiring_type: 'Agency-Hired',
      applied_position: 'Operator',
      branch: 'Marulas Plant',
    }),
  });
  check('Agency-hired applicant requires agency deployment data', result.status === 400);

  const agencyEmail = `agency.${nonce}@example.test`;
  const biometricReference = `BIO-ONB-${nonce}`;
  result = await api('/api/onboarding/applicants', {
    method: 'POST',
    headers: jsonHeaders(hrToken),
    body: JSON.stringify({
      first_name: 'Agency',
      last_name: `Worker${nonce}`,
      email: agencyEmail,
      contact_number: '09171234567',
      residential_address: 'Encrypted agency address',
      hiring_type: 'Agency-Hired',
      agency_name: 'Temporary Staffing Test',
      agency_contact_person: 'Agency Contact',
      agency_contact_number: '0280000000',
      deployment_status: 'Pending Deployment',
      contract_start_date: '2026-06-01',
      contract_end_date: '2026-12-31',
      applied_position: 'Operator',
      branch: 'Marulas Plant',
      expected_wage_type_id: wageTypeId,
      expected_base_rate: 120,
      biometric_device_id: deviceId,
      biometric_reference: biometricReference,
    }),
  });
  check('Agency operator enters screening route', result.status === 201 && result.data.workflow_status === 'Pending Screening');
  const agencyApplicantId = result.data.applicant_id;
  applicantIds.push(agencyApplicantId);

  result = await api(`/api/onboarding/applicants/${agencyApplicantId}/decision`, {
    method: 'PATCH',
    headers: jsonHeaders(hrToken),
    body: JSON.stringify({ approval_status: 'Approved', reason: 'This should be rejected as premature.' }),
  });
  check('Training-routed applicant cannot be approved early', result.status === 400);

  result = await api(`/api/onboarding/applicants/${agencyApplicantId}/progress`, {
    method: 'PATCH',
    headers: jsonHeaders(hrToken),
    body: JSON.stringify({ screening_status: 'Passed Screening', training_status: 'In Training', reason: 'Screening passed and training started.' }),
  });
  check('Agency operator can enter required training after screening', result.status === 200 && result.data.workflow_status === 'Training');

  result = await api(`/api/onboarding/applicants/${agencyApplicantId}/progress`, {
    method: 'PATCH',
    headers: jsonHeaders(hrToken),
    body: JSON.stringify({ screening_status: 'Passed Screening', training_status: 'Completed Training', reason: 'Required factory training completed.' }),
  });
  check('Completed training advances applicant to approval', result.status === 200 && result.data.workflow_status === 'For Approval');

  result = await api(`/api/onboarding/applicants/${agencyApplicantId}/decision`, {
    method: 'PATCH',
    headers: jsonHeaders(hrToken),
    body: JSON.stringify({ approval_status: 'Approved', reason: 'Agency operator requirements verified.' }),
  });
  check('Qualified agency operator can be approved', result.status === 200);

  result = await api(`/api/onboarding/applicants/${agencyApplicantId}/transfer`, {
    method: 'POST',
    headers: jsonHeaders(hrToken),
    body: JSON.stringify({ employee_code: `TST-A-${nonce}`, reason: 'Approved agency operator transferred.' }),
  });
  check('Approved agency operator transfers into Employee Directory', result.status === 201);
  const agencyEmployeeId = result.data.employee_id;
  employeeIds.push(agencyEmployeeId);

  const [mappings] = await pool.execute('SELECT * FROM biometric_employee_mapping WHERE employee_id = ?', [agencyEmployeeId]);
  check('Transfer activates encrypted biometric reference mapping', mappings.length === 1 && !mappings[0].biometric_user_id_encrypted.includes(biometricReference));

  const [activities] = await pool.execute('SELECT action FROM onboarding_applicant_activity WHERE applicant_id IN (?, ?)', [directApplicantId, agencyApplicantId]);
  check('Applicant lifecycle has audit-ready activity history', activities.length >= 10);
  const [integrityRows] = await pool.execute('SELECT chain_hash FROM onboarding_integrity_chain WHERE applicant_id IN (?, ?)', [directApplicantId, agencyApplicantId]);
  check('Onboarding activity is protected by tamper-evident ledger hashes', integrityRows.length === activities.length);
  result = await api(`/api/onboarding/applicants/${agencyApplicantId}/integrity`, { headers: jsonHeaders(hrToken) });
  check('HR admin can verify onboarding integrity chain', result.status === 200 && result.data.chain_valid === true && result.data.pending_anchor_count > 0);
  result = await api('/api/onboarding/integrity/anchor-pending', { method: 'POST', headers: jsonHeaders(payrollToken) });
  check('Payroll officer cannot anchor onboarding ledger entries', result.status === 403);
  result = await api('/api/onboarding/integrity/anchor-pending', { method: 'POST', headers: jsonHeaders(sysAdminToken) });
  check('System admin can access onboarding ledger handoff', [200, 503].includes(result.status));
  const [systemAudit] = await pool.execute(`SELECT log_id FROM system_audit_log WHERE module = 'ONBOARDING' AND action_performed LIKE ?`, [`%[APPLICANT:${agencyApplicantId}]%`]);
  check('Onboarding actions are mirrored into system audit log', systemAudit.length >= 4);
}

async function cleanup() {
  for (const filePath of documentPaths) {
    await fs.promises.unlink(filePath).catch(() => {});
  }
  for (const applicantId of applicantIds) {
    await pool.execute(`DELETE FROM system_audit_log WHERE module = 'ONBOARDING' AND action_performed LIKE ?`, [`%[APPLICANT:${applicantId}]%`]);
  }
  for (const employeeId of employeeIds) {
    await pool.execute('DELETE FROM biometric_employee_mapping WHERE employee_id = ?', [employeeId]);
    await pool.execute('DELETE FROM employee_wage_rates WHERE employee_id = ?', [employeeId]);
  }
  await pool.execute(`DELETE FROM onboarding_applicant WHERE applicant_id IN (${applicantIds.map(() => '?').join(',') || 'NULL'})`, applicantIds);
  for (const employeeId of employeeIds) {
    await pool.execute('DELETE FROM employees WHERE id = ?', [employeeId]);
  }
  if (deviceId) await pool.execute('DELETE FROM biometric_device WHERE device_id = ?', [deviceId]);
  await pool.end();
}

run()
  .then(() => console.log('Secure onboarding lifecycle integration test completed.'))
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
