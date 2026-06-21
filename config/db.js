/* ============================================================
   config/db.js — MySQL connection pool
   ============================================================ */

const mysql  = require('mysql2/promise');
const fs     = require('fs');
require('dotenv').config();

function readOptionalFile(filePath) {
  return filePath ? fs.readFileSync(filePath) : undefined;
}

function getSslConfig() {
  if (process.env.DB_SSL !== 'true') return undefined;
  return {
    minVersion: 'TLSv1.3',
    ca: readOptionalFile(process.env.DB_SSL_CA_PATH),
    cert: readOptionalFile(process.env.DB_SSL_CERT_PATH),
    key: readOptionalFile(process.env.DB_SSL_KEY_PATH),
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
  };
}

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               process.env.DB_PORT     || 3306,
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASSWORD || '',
  database:           process.env.DB_NAME     || 'lgsv_hr_db',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  timezone:           '+08:00', // Philippine Standard Time
  ssl:                getSslConfig(),
});

// Test connection on startup. Unit tests that only exercise validators/helpers
// can import modules without requiring a live MySQL service.
if (process.env.NODE_ENV !== 'test') {
  pool.getConnection()
    .then(conn => {
      console.log('✅  MySQL connected:', conn.config.database);
      conn.release();
    })
    .catch(err => {
      console.error('❌  MySQL connection failed:', err.message);
      process.exit(1);
    });
}

module.exports = pool;
