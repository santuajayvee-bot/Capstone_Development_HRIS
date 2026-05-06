require('dotenv').config();
const pool = require('./config/db');
async function check() {
  const [rows] = await pool.execute("DESCRIBE employee_wage_rates");
  rows.forEach(r => console.log(`${r.Field} - ${r.Type}`));
  process.exit(0);
}
check();
