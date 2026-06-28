require('dotenv').config();
const pool = require('../config/db');
const { isEncryptedValue } = require('../server/data-protection');

const EMPLOYEE_COLUMNS = [
  'first_name', 'middle_name', 'last_name', 'email', 'contact_number', 'work_email',
  'date_of_birth', 'residential_address', 'current_address', 'mailing_address',
  'sss_number', 'philhealth_number', 'pagibig_number', 'tin', 'bank_name', 'bank_account',
  'emergency_contact_name', 'emergency_contact_num', 'emergency_contact_email',
];

async function scalar(sql) {
  const [[row]] = await pool.query(sql);
  return Number(Object.values(row || {})[0] || 0);
}

(async () => {
  const [employees] = await pool.query(`SELECT ${EMPLOYEE_COLUMNS.join(', ')} FROM employees`);
  let employeePlaintextValues = 0;
  for (const employee of employees) {
    for (const column of EMPLOYEE_COLUMNS) {
      const value = employee[column];
      if (value !== null && value !== undefined && value !== '' && !isEncryptedValue(String(value))) {
        employeePlaintextValues += 1;
      }
    }
  }

  const checks = {
    employee_plaintext_values: employeePlaintextValues,
    users_plaintext_email: await scalar("SELECT COUNT(*) FROM users WHERE email IS NOT NULL AND email <> ''"),
    onboarding_plaintext_names: await scalar("SELECT COUNT(*) FROM onboarding_applicant WHERE first_name IS NOT NULL OR middle_name IS NOT NULL OR last_name IS NOT NULL OR suffix IS NOT NULL"),
    mfa_plaintext_phone: await scalar("SELECT COUNT(*) FROM MFA_CHALLENGE WHERE Phone_Number IS NOT NULL AND Phone_Number <> ''"),
    raw_employee_photos: await scalar('SELECT COUNT(*) FROM employee_photos WHERE photo_data IS NOT NULL OR photo_data_encrypted IS NOT NULL'),
    attendance_plaintext_gps: await scalar('SELECT COUNT(*) FROM attendance_log WHERE clock_in_lat IS NOT NULL OR clock_in_lng IS NOT NULL OR clock_out_lat IS NOT NULL OR clock_out_lng IS NOT NULL'),
    leave_plaintext_details: await scalar('SELECT COUNT(*) FROM leave_requests WHERE reason IS NOT NULL OR remarks IS NOT NULL OR rejection_remarks IS NOT NULL OR approval_remarks IS NOT NULL OR file_path IS NOT NULL'),
    profile_audit_plaintext: await scalar('SELECT COUNT(*) FROM user_profile_audit_logs WHERE old_value IS NOT NULL OR new_value IS NOT NULL'),
    profile_request_plaintext: await scalar('SELECT COUNT(*) FROM user_profile_change_requests WHERE old_value IS NOT NULL OR requested_value IS NOT NULL OR reason IS NOT NULL OR rejection_reason IS NOT NULL'),
    document_plaintext_name: await scalar("SELECT COUNT(*) FROM documents WHERE file_name IS NOT NULL AND file_name <> ''"),
    document_plaintext_path: await scalar("SELECT COUNT(*) FROM documents WHERE file_path IS NOT NULL AND file_path <> ''"),
    deduction_plaintext_notes: await scalar("SELECT COUNT(*) FROM employee_deductions WHERE notes IS NOT NULL AND notes <> ''"),
    deduction_account_plaintext_remarks: await scalar("SELECT COUNT(*) FROM employee_deduction_accounts WHERE remarks IS NOT NULL AND remarks <> ''"),
  };

  console.log(JSON.stringify(checks, null, 2));
  const failures = Object.entries(checks).filter(([, count]) => count !== 0);
  await pool.end();
  if (failures.length) {
    console.error(`Sensitive-data verification failed: ${failures.map(([name, count]) => `${name}=${count}`).join(', ')}`);
    process.exit(1);
  }
  console.log('Sensitive-data hardening verification: PASS');
})().catch(async error => {
  console.error(error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
