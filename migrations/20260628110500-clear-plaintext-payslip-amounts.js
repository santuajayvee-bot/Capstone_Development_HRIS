require('dotenv').config();
const fs = require('fs');
const mysql = require('mysql2/promise');
const { decryptColumnValue, encryptColumnValue } = require('../server/data-protection');

function readOptionalFile(filePath) {
  return filePath ? fs.readFileSync(filePath) : undefined;
}

function sslConfig() {
  if (process.env.DB_SSL !== 'true') return undefined;
  return {
    minVersion: 'TLSv1.3',
    ca: readOptionalFile(process.env.DB_SSL_CA_PATH),
    cert: readOptionalFile(process.env.DB_SSL_CERT_PATH),
    key: readOptionalFile(process.env.DB_SSL_KEY_PATH),
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
  };
}

async function createConnection() {
  return mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.MIGRATION_DB_USER || process.env.DB_USER,
    password: process.env.MIGRATION_DB_PASSWORD || process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: sslConfig(),
  });
}

async function hasColumn(connection, table, column) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function ensureEncryptedPayslipColumns(connection) {
  const required = [
    'total_earning_encrypted',
    'total_deduction_encrypted',
    'net_pay_encrypted',
  ];
  for (const column of required) {
    if (!(await hasColumn(connection, 'payslips', column))) {
      throw new Error(`payslips.${column} is missing. Run the payslip encryption column migration first.`);
    }
  }
}

function amountText(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : String(value);
}

exports.up = async function up() {
  const connection = await createConnection();
  try {
    await ensureEncryptedPayslipColumns(connection);
    const [rows] = await connection.execute(
      `SELECT id,
              total_earning,
              total_deduction,
              net_pay,
              total_earning_encrypted,
              total_deduction_encrypted,
              net_pay_encrypted
         FROM payslips
        WHERE total_earning IS NOT NULL
           OR total_deduction IS NOT NULL
           OR net_pay IS NOT NULL`
    );

    for (const row of rows) {
      await connection.execute(
        `UPDATE payslips
            SET total_earning_encrypted = COALESCE(total_earning_encrypted, ?),
                total_deduction_encrypted = COALESCE(total_deduction_encrypted, ?),
                net_pay_encrypted = COALESCE(net_pay_encrypted, ?),
                total_earning = NULL,
                total_deduction = NULL,
                net_pay = NULL,
                payslip_storage_encrypted_at = COALESCE(payslip_storage_encrypted_at, NOW())
          WHERE id = ?`,
        [
          encryptColumnValue(amountText(row.total_earning)),
          encryptColumnValue(amountText(row.total_deduction)),
          encryptColumnValue(amountText(row.net_pay)),
          row.id,
        ]
      );
    }
  } finally {
    await connection.end();
  }
};

exports.down = async function down() {
  const connection = await createConnection();
  try {
    await ensureEncryptedPayslipColumns(connection);
    const [rows] = await connection.execute(
      `SELECT id,
              total_earning_encrypted,
              total_deduction_encrypted,
              net_pay_encrypted
         FROM payslips
        WHERE total_earning IS NULL
          AND total_deduction IS NULL
          AND net_pay IS NULL
          AND (total_earning_encrypted IS NOT NULL
            OR total_deduction_encrypted IS NOT NULL
            OR net_pay_encrypted IS NOT NULL)`
    );

    for (const row of rows) {
      await connection.execute(
        `UPDATE payslips
            SET total_earning = COALESCE(total_earning, ?),
                total_deduction = COALESCE(total_deduction, ?),
                net_pay = COALESCE(net_pay, ?)
          WHERE id = ?`,
        [
          decryptColumnValue(row.total_earning_encrypted),
          decryptColumnValue(row.total_deduction_encrypted),
          decryptColumnValue(row.net_pay_encrypted),
          row.id,
        ]
      );
    }
  } finally {
    await connection.end();
  }
};
