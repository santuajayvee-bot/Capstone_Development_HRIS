require('dotenv').config();
const pool = require('./config/db');
async function check() {
  const [rows] = await pool.execute("SELECT id, name FROM roles");
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}
check();
