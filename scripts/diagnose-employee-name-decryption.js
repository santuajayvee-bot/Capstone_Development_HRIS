/*
 * Reports whether the current AWS/local environment can decrypt employee names.
 * This prints counts and key-shape checks only. It never prints secrets or names.
 */

require('dotenv').config();

const pool = require('../config/db');
const { decryptColumnValue, isEncryptedValue } = require('../server/data-protection');

function keyShapeStatus() {
  const hexKey = String(process.env.AES_ENCRYPTION_KEY || '').trim();
  const base64Key = String(process.env.AES_256_SECRET_KEY || '').trim();
  let base64Bytes = 0;
  try {
    base64Bytes = base64Key ? Buffer.from(base64Key, 'base64').length : 0;
  } catch (_error) {
    base64Bytes = -1;
  }
  return {
    aesEncryptionKeyConfigured: Boolean(hexKey),
    aesEncryptionKeyValidHex32Bytes: /^[a-f0-9]{64}$/i.test(hexKey),
    aes256SecretKeyConfigured: Boolean(base64Key),
    aes256SecretKeyDecodedBytes: base64Bytes,
    jwtSecretConfigured: Boolean(String(process.env.JWT_SECRET || '').trim()),
  };
}

function tryDecrypt(value) {
  if (!value) return { state: 'empty', value: '' };
  if (!isEncryptedValue(String(value))) return { state: 'plaintext', value: String(value) };
  try {
    return { state: 'decrypted', value: decryptColumnValue(value) || '' };
  } catch (_error) {
    return { state: 'failed', value: '' };
  }
}

async function main() {
  const [rows] = await pool.query(
    `SELECT id, employee_code, first_name, middle_name, last_name
       FROM employees
      ORDER BY id DESC
      LIMIT 100`
  );

  const summary = {
    checkedEmployees: rows.length,
    employeesWithReadableName: 0,
    employeesUsingEmployeeCodeFallback: 0,
    encryptedNameValues: 0,
    decryptedNameValues: 0,
    failedEncryptedNameValues: 0,
    plaintextNameValues: 0,
    emptyNameValues: 0,
    sampleFailedEmployeeCodes: [],
    keyShape: keyShapeStatus(),
  };

  for (const row of rows) {
    const parts = ['first_name', 'middle_name', 'last_name'].map(column => {
      const result = tryDecrypt(row[column]);
      if (result.state === 'decrypted') {
        summary.encryptedNameValues += 1;
        summary.decryptedNameValues += 1;
      } else if (result.state === 'failed') {
        summary.encryptedNameValues += 1;
        summary.failedEncryptedNameValues += 1;
      } else if (result.state === 'plaintext') {
        summary.plaintextNameValues += 1;
      } else {
        summary.emptyNameValues += 1;
      }
      return result.value;
    });

    if (parts.filter(Boolean).join(' ').trim()) {
      summary.employeesWithReadableName += 1;
    } else {
      summary.employeesUsingEmployeeCodeFallback += 1;
      if (summary.sampleFailedEmployeeCodes.length < 10) {
        summary.sampleFailedEmployeeCodes.push(row.employee_code || `id:${row.id}`);
      }
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (summary.failedEncryptedNameValues > 0) {
    process.exitCode = 2;
  }
}

main()
  .catch(error => {
    console.error(`Employee-name decryption diagnostic failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
