/*
 * Safe employee encryption-key diagnostic.
 *
 * Prints only key shape/fingerprint and decrypt counts. It never prints secret
 * keys or decrypted employee PII.
 */
require('dotenv').config();

const crypto = require('crypto');
const pool = require('../config/db');
const { decryptColumnValue, isEncryptedValue } = require('../server/data-protection');

function keyFingerprint(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12);
}

async function currentDatabaseName() {
  const [rows] = await pool.query('SELECT DATABASE() AS database_name');
  return rows[0]?.database_name || null;
}

async function main() {
  const aesKey = String(process.env.AES_ENCRYPTION_KEY || '').trim();
  const [rows] = await pool.query('SELECT * FROM employees ORDER BY id ASC');

  const summary = {
    database: await currentDatabaseName(),
    employeeRows: rows.length,
    keyShape: {
      aesEncryptionKeyConfigured: Boolean(aesKey),
      aesEncryptionKeyValidHex32Bytes: /^[a-f0-9]{64}$/i.test(aesKey),
      aesEncryptionKeyFingerprint: keyFingerprint(aesKey),
    },
    encryptedValues: 0,
    decryptedValues: 0,
    failedValues: 0,
    firstFailed: null,
  };

  for (const row of rows) {
    for (const [column, value] of Object.entries(row)) {
      if (!isEncryptedValue(value)) continue;
      summary.encryptedValues += 1;
      try {
        decryptColumnValue(value);
        summary.decryptedValues += 1;
      } catch (_error) {
        summary.failedValues += 1;
        if (!summary.firstFailed) summary.firstFailed = { employeeId: row.id, column };
      }
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (summary.failedValues > 0) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(`Employee encryption-key diagnostic failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
