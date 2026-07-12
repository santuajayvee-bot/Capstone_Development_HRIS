'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { backupError } = require('./backupErrors');
const { sha256File } = require('./artifactIntegrity');

const MAGIC = Buffer.from('LGSVBAK1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES;

function normalizeEncryptionKey(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return Buffer.from(value);
  const text = String(value || '').trim();
  let key = null;
  if (/^[a-f0-9]{64}$/i.test(text)) key = Buffer.from(text, 'hex');
  if (!key) {
    try {
      const decoded = Buffer.from(text, 'base64');
      if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === text.replace(/=+$/, '')) key = decoded;
    } catch (_) {}
  }
  if (!key || key.length !== 32) {
    throw backupError('BACKUP_ENCRYPTION_KEY must contain exactly 256 bits.', 'BACKUP_ENCRYPTION_KEY_MISSING');
  }
  return key;
}

function aadBuffer(aad) {
  const value = String(aad || '');
  if (!value || Buffer.byteLength(value, 'utf8') > 1024 || /[\r\n\0]/.test(value)) {
    throw backupError('Backup encryption context is invalid.', 'INVALID_ENCRYPTION_CONTEXT');
  }
  return Buffer.from(value, 'utf8');
}

async function encryptFile(sourcePath, destinationPath, keyValue, aad) {
  const key = normalizeEncryptionKey(keyValue);
  const sourceStat = await fs.promises.lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw backupError('Only regular files can be encrypted into a backup.', 'UNSUPPORTED_BACKUP_SOURCE');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadBuffer(aad));
  await fs.promises.mkdir(require('path').dirname(destinationPath), { recursive: true, mode: 0o700 });
  const output = await fs.promises.open(destinationPath, 'wx', 0o600);
  let position = 0;
  try {
    const header = Buffer.concat([MAGIC, iv]);
    await output.write(header, 0, header.length, position);
    position += header.length;
    for await (const chunk of fs.createReadStream(sourcePath)) {
      const encrypted = cipher.update(chunk);
      if (encrypted.length) {
        await output.write(encrypted, 0, encrypted.length, position);
        position += encrypted.length;
      }
    }
    const final = cipher.final();
    if (final.length) {
      await output.write(final, 0, final.length, position);
      position += final.length;
    }
    const tag = cipher.getAuthTag();
    await output.write(tag, 0, tag.length, position);
    await output.sync();
  } catch (error) {
    await output.close().catch(() => {});
    await fs.promises.rm(destinationPath, { force: true }).catch(() => {});
    throw error;
  }
  await output.close();
  const encryptedStat = await fs.promises.stat(destinationPath);
  return {
    algorithm: 'AES-256-GCM',
    encryptedSize: encryptedStat.size,
    encryptedSha256: await sha256File(destinationPath),
  };
}

async function readEnvelopeHeader(filePath) {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < HEADER_BYTES + TAG_BYTES) {
    throw backupError('Encrypted backup object is invalid.', 'INVALID_ENCRYPTED_BACKUP');
  }
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const header = Buffer.alloc(HEADER_BYTES);
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(header, 0, HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, stat.size - TAG_BYTES);
    if (!crypto.timingSafeEqual(header.subarray(0, MAGIC.length), MAGIC)) {
      throw backupError('Encrypted backup object has an invalid header.', 'INVALID_ENCRYPTED_BACKUP');
    }
    return { stat, iv: header.subarray(MAGIC.length), tag };
  } finally {
    await handle.close();
  }
}

async function decryptFile(sourcePath, destinationPath, keyValue, aad) {
  const key = normalizeEncryptionKey(keyValue);
  const { stat, iv, tag } = await readEnvelopeHeader(sourcePath);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aadBuffer(aad));
  decipher.setAuthTag(tag);
  await fs.promises.mkdir(require('path').dirname(destinationPath), { recursive: true, mode: 0o700 });
  const output = await fs.promises.open(destinationPath, 'wx', 0o600);
  let position = 0;
  try {
    const end = stat.size - TAG_BYTES - 1;
    for await (const chunk of fs.createReadStream(sourcePath, { start: HEADER_BYTES, end })) {
      const decrypted = decipher.update(chunk);
      if (decrypted.length) {
        await output.write(decrypted, 0, decrypted.length, position);
        position += decrypted.length;
      }
    }
    const final = decipher.final();
    if (final.length) {
      await output.write(final, 0, final.length, position);
      position += final.length;
    }
    await output.sync();
  } catch (error) {
    await output.close().catch(() => {});
    await fs.promises.rm(destinationPath, { force: true }).catch(() => {});
    throw backupError('Encrypted backup object failed authentication.', 'BACKUP_DECRYPTION_FAILED', { cause: error });
  }
  await output.close();
  return { sizeBytes: position };
}

async function hashDecryptedFile(filePath, keyValue, aad) {
  const key = normalizeEncryptionKey(keyValue);
  const { stat, iv, tag } = await readEnvelopeHeader(filePath);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aadBuffer(aad));
  decipher.setAuthTag(tag);
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    const end = stat.size - TAG_BYTES - 1;
    for await (const chunk of fs.createReadStream(filePath, { start: HEADER_BYTES, end })) {
      const decrypted = decipher.update(chunk);
      size += decrypted.length;
      hash.update(decrypted);
    }
    const final = decipher.final();
    size += final.length;
    hash.update(final);
  } catch (error) {
    throw backupError('Encrypted backup object failed authentication.', 'BACKUP_DECRYPTION_FAILED', { cause: error });
  }
  return { size, sha256: hash.digest('hex') };
}

function encryptBuffer(buffer, keyValue, aad) {
  const key = normalizeEncryptionKey(keyValue);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadBuffer(aad));
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([MAGIC, iv, encrypted, cipher.getAuthTag()]);
}

function decryptBuffer(envelope, keyValue, aad) {
  const key = normalizeEncryptionKey(keyValue);
  if (!Buffer.isBuffer(envelope) || envelope.length < HEADER_BYTES + TAG_BYTES) {
    throw backupError('Encrypted backup manifest is invalid.', 'INVALID_ENCRYPTED_BACKUP');
  }
  if (!crypto.timingSafeEqual(envelope.subarray(0, MAGIC.length), MAGIC)) {
    throw backupError('Encrypted backup manifest has an invalid header.', 'INVALID_ENCRYPTED_BACKUP');
  }
  const iv = envelope.subarray(MAGIC.length, HEADER_BYTES);
  const tag = envelope.subarray(envelope.length - TAG_BYTES);
  const ciphertext = envelope.subarray(HEADER_BYTES, envelope.length - TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadBuffer(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw backupError('Encrypted backup manifest failed authentication.', 'BACKUP_DECRYPTION_FAILED', { cause: error });
  }
}

module.exports = {
  HEADER_BYTES,
  MAGIC,
  TAG_BYTES,
  decryptBuffer,
  decryptFile,
  encryptBuffer,
  encryptFile,
  hashDecryptedFile,
  normalizeEncryptionKey,
};
