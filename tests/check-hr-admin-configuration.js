const { findUserByEmail } = require('../db/authQueries');

async function run() {
  const user = await findUserByEmail('hr.admin');
  if (!user) throw new Error('hr.admin user record was not found.');
  console.table([{
    username: user.username,
    user_id: user.id,
    employee_table_id: user.employee_table_id,
    employee_id: user.Employee_ID,
    role: user.role_name,
    active: user.is_active,
    account_status: user.account_status,
    mfa_enabled: user.mfa_enabled,
    has_phone: Boolean(user.phone_number),
  }]);
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
