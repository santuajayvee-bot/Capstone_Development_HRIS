const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { decryptAES256, encryptAES256 } = require('./crypto');

const VAULT_ROOT = path.resolve(process.env.SECURE_UPLOAD_ROOT || path.join(__dirname, '..', 'secure_uploads'));

function safeScope(scope) {
  const value = String(scope || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(value)) throw new Error('Invalid encrypted file scope.');
  return value;
}

function assertVaultPath(filePath) {
  const stored = String(filePath || '');
  const resolved = path.isAbsolute(stored) ? path.resolve(stored) : path.resolve(VAULT_ROOT, stored);
  if (resolved !== VAULT_ROOT && !resolved.startsWith(`${VAULT_ROOT}${path.sep}`)) {
    throw new Error('Encrypted file path is outside the secure vault.');
  }
  return resolved;
}

async function storeEncryptedBuffer(scope, buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Encrypted file content is required.');
  const directory = path.join(VAULT_ROOT, safeScope(scope));
  await fs.promises.mkdir(directory, { recursive: true });
  const storedPath = path.join(safeScope(scope), `${crypto.randomUUID()}.enc`);
  const filePath = path.join(VAULT_ROOT, storedPath);
  await fs.promises.writeFile(filePath, encryptAES256(buffer.toString('base64')), { encoding: 'utf8', mode: 0o600 });
  return storedPath.replace(/\\/g, '/');
}

async function readEncryptedBuffer(filePath) {
  const resolved = assertVaultPath(filePath);
  const payload = await fs.promises.readFile(resolved, 'utf8');
  return Buffer.from(decryptAES256(payload), 'base64');
}

async function deleteEncryptedFile(filePath) {
  if (!filePath) return;
  const resolved = assertVaultPath(filePath);
  await fs.promises.unlink(resolved).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

module.exports = {
  VAULT_ROOT,
  deleteEncryptedFile,
  readEncryptedBuffer,
  storeEncryptedBuffer,
};
