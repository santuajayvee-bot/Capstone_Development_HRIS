'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { backupError } = require('./backupErrors');
const { walkRegularFiles } = require('./fileTree');

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

async function sha256File(filePath) {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw backupError('Checksum input must be a regular file.', 'INVALID_CHECKSUM_INPUT');
  }
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

function directoryChecksum(entries) {
  const canonicalEntries = entries.map(entry => ({
    path: entry.path,
    size: Number(entry.size),
    sha256: entry.sha256,
  }));
  return sha256Text(JSON.stringify({ formatVersion: 1, entries: canonicalEntries }));
}

async function describeArtifact(artifactPath, options = {}) {
  const resolved = path.resolve(artifactPath);
  const stat = await fs.promises.lstat(resolved).catch(error => {
    if (error.code === 'ENOENT') throw backupError('Backup artifact is missing.', 'BACKUP_ARTIFACT_MISSING');
    throw error;
  });
  if (stat.isSymbolicLink()) {
    throw backupError('Symbolic links are not allowed in backup artifacts.', 'BACKUP_SYMLINK_REJECTED');
  }
  if (stat.isFile()) {
    return {
      kind: 'FILE',
      checksumAlgorithm: 'SHA-256',
      checksum: await sha256File(resolved),
      sizeBytes: stat.size,
      fileCount: 1,
      entries: null,
    };
  }
  if (!stat.isDirectory()) {
    throw backupError('Backup artifact must be a regular file or directory.', 'UNSUPPORTED_BACKUP_ARTIFACT');
  }

  const files = await walkRegularFiles(resolved, options);
  const entries = [];
  for (const file of files) {
    entries.push({
      path: file.relativePath,
      size: file.size,
      sha256: await sha256File(file.absolutePath),
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return {
    kind: 'DIRECTORY',
    checksumAlgorithm: 'SHA-256',
    checksum: directoryChecksum(entries),
    sizeBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    fileCount: entries.length,
    entries,
  };
}

function validateExpectedChecksum(expectedChecksum) {
  const checksum = String(expectedChecksum || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw backupError('Expected checksum must be a SHA-256 hex digest.', 'INVALID_EXPECTED_CHECKSUM');
  }
  return checksum;
}

async function verifyArtifact(artifactPath, expectedChecksum, options = {}) {
  const expected = validateExpectedChecksum(expectedChecksum);
  const descriptor = await describeArtifact(artifactPath, options);
  return {
    valid: crypto.timingSafeEqual(Buffer.from(descriptor.checksum, 'hex'), Buffer.from(expected, 'hex')),
    expectedChecksum: expected,
    actualChecksum: descriptor.checksum,
    descriptor,
  };
}

module.exports = {
  describeArtifact,
  directoryChecksum,
  sha256File,
  sha256Text,
  validateExpectedChecksum,
  verifyArtifact,
};
