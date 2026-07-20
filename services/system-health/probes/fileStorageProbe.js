'use strict';

const crypto = require('crypto');
const { createProbeResult, ProbeFailure } = require('../probeResult');

async function probeFileStorage({ vault } = {}) {
  const encryptedVault = vault || require('../../../server/encrypted-file-vault');
  const payload = crypto.randomBytes(32);
  const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');
  let storedPath = null;
  let cleanupPassed = false;
  try {
    storedPath = await encryptedVault.storeEncryptedBuffer('system-health', payload);
    const restored = await encryptedVault.readEncryptedBuffer(storedPath);
    const actualHash = crypto.createHash('sha256').update(restored).digest('hex');
    if (actualHash !== expectedHash) throw new Error('Read-back checksum mismatch.');
    await encryptedVault.deleteEncryptedFile(storedPath);
    cleanupPassed = true;
  } catch (error) {
    if (storedPath && !cleanupPassed) {
      await encryptedVault.deleteEncryptedFile(storedPath).catch(() => {});
    }
    throw new ProbeFailure('FILE_STORAGE_CANARY_FAILED', 'Encrypted file storage canary failed.', { cause: error });
  }
  return createProbeResult({
    status: cleanupPassed ? 'ONLINE' : 'WARNING',
    remarks: cleanupPassed
      ? 'Dedicated encrypted health-check file was written, read, checksum-validated, and removed.'
      : 'File storage canary completed but cleanup needs review.',
    probeType: 'INTEGRITY',
    probeTarget: 'encrypted-file-vault system-health temporary scope',
    checks: {
      canary_write: { passed: true, message: 'Small encrypted canary file was written to the dedicated health-check scope.' },
      canary_read: { passed: true, message: 'Canary file was read back successfully.' },
      checksum_match: { passed: true, message: 'Read-back canary checksum matched.' },
      cleanup: { passed: cleanupPassed, message: cleanupPassed ? 'Canary file was removed after validation.' : 'Canary cleanup needs review.' },
    },
    dependencies: { encrypted_file_vault: { label: 'Encrypted file vault', available: true, status: 'Dedicated health-check scope validated' } },
    validationPassed: cleanupPassed,
  });
}

module.exports = { probeFileStorage };
