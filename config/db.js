/* ============================================================
   config/db.js — MySQL connection pool
   ============================================================ */

const mysql  = require('mysql2/promise');
const fs     = require('fs');
require('dotenv').config();

function requiredDatabaseSetting(name) {
  const value = String(process.env[name] || '').trim();
  if (value) return value;
  if (process.env.NODE_ENV === 'test') return name === 'DB_PASSWORD' ? 'test-only' : 'test';
  throw new Error(`${name} must be configured.`);
}

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
  user:               requiredDatabaseSetting('DB_USER'),
  password:           requiredDatabaseSetting('DB_PASSWORD'),
  database:           requiredDatabaseSetting('DB_NAME'),
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
