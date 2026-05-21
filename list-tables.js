require('dotenv').config();
const pool = require('./config/db');
async function check() {
  const [rows] = await pool.execute("SHOW TABLES");
  console.log(JSON.stringify(rows.map(r => Object.values(r)[0]), null, 2));
  process.exit(0);
}
check();
