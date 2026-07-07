const dotenv = require('dotenv');
dotenv.config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const sql = fs.readFileSync(path.join(process.cwd(), 'migrations', 'sqls', '20260704093000_add_totp_mfa_enrollment-up.sql'), 'utf8');
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await conn.query(statement);
  }

  console.log('Applied TOTP MFA migration');
  await conn.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
