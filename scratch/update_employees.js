const mysql = require('mysql2/promise');
const config = { host: 'localhost', user: 'root', password: '', database: 'lgsv_hr_db' };
async function run() {
  const conn = await mysql.createConnection(config);
  await conn.execute("UPDATE employees SET onboarding_status = 'completed' WHERE first_name LIKE '%Ed%' OR first_name LIKE '%Kristine%'");
  console.log('Successfully updated Ed and Kristine to Newly Hired');
  process.exit(0);
}
run();
