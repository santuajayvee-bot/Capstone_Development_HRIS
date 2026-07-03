require('dotenv').config();

const crypto = require('crypto');
const { decryptAES256, encryptAES256 } = require('../server/crypto');

function result(label, passed, detail = '') {
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}${suffix}`);
  if (!passed) process.exitCode = 1;
}

const configuredKey = String(process.env.AES_ENCRYPTION_KEY || '').trim();
const validKey = /^[a-f0-9]{64}$/i.test(configuredKey)
  && Buffer.from(configuredKey, 'hex').length === 32;

console.log('LGSV HR AES-256-GCM DEFENSE DEMO');
console.log('Uses dummy data only; the encryption key is never printed.\n');

result('Node.js supports aes-256-gcm', crypto.getCiphers().includes('aes-256-gcm'));
result('Dedicated AES_ENCRYPTION_KEY is configured', validKey, '32 bytes / 256 bits');

if (!validKey) {
  console.error('\nConfigure AES_ENCRYPTION_KEY as exactly 64 hexadecimal characters before running this production demo.');
  process.exit(1);
}

const plaintext = 'LGSV-HR-DEFENSE-DEMO';
const encryptedA = encryptAES256(plaintext);
const encryptedB = encryptAES256(plaintext);
const [iv, authTag, ciphertext] = encryptedA.split(':');

console.log(`\nDummy plaintext: ${plaintext}`);
console.log(`Stored payload: ${encryptedA}`);
console.log(`Payload format: IV (${iv.length / 2} bytes) : Auth Tag (${authTag.length / 2} bytes) : Ciphertext (${ciphertext.length / 2} bytes)\n`);

result('Plaintext is absent from stored payload', !encryptedA.includes(plaintext));
result('Same plaintext produces different ciphertext', encryptedA !== encryptedB, 'random IV per encryption');
result('Authorized decryption restores original value', decryptAES256(encryptedA) === plaintext);

const replacement = ciphertext.at(-1) === '0' ? '1' : '0';
const tamperedPayload = `${iv}:${authTag}:${ciphertext.slice(0, -1)}${replacement}`;
let tamperingRejected = false;
try {
  decryptAES256(tamperedPayload);
} catch {
  tamperingRejected = true;
}
result('Modified ciphertext is rejected', tamperingRejected, 'GCM authentication tag validation');

if (!process.exitCode) {
  console.log('\nAES-256-GCM implementation demonstration: PASS');
}
