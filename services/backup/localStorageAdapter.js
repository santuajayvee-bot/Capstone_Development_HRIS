'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeArtifact, directoryChecksum, sha256File, validateExpectedChecksum, verifyArtifact } = require('./artifactIntegrity');
const { backupError } = require('./backupErrors');
const { decryptBuffer, decryptFile, encryptBuffer, encryptFile, hashDecryptedFile, normalizeEncryptionKey } = require('./envelopeEncryption');
const {
  assertSafeBackupReference,
  isInside,
  normalizeRelativePath,
  removeTemporaryTree,
  resolveInside,
  walkRegularFiles,
} = require('./fileTree');

const MANIFEST_FORMAT_VERSION = 2;
const ENCRYPTED_MANIFEST_NAME = '_lgsv_backup_manifest.enc';
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

function privateDevelopmentBackupRoot() {
  return path.join(os.homedir(), '.lgsv-hr', 'backups');
}

function locationForReference(reference) {
  return `local-backup:///${encodeURIComponent(reference)}`;
}

function referenceFromLocation(location) {
  let parsed;
  try {
    parsed = new URL(String(location || ''));
  } catch (_) {
    throw backupError('Local backup location is invalid.', 'INVALID_BACKUP_LOCATION');
  }
  if (parsed.protocol !== 'local-backup:' || parsed.host || parsed.search || parsed.hash) {
    throw backupError('Local backup location is invalid.', 'INVALID_BACKUP_LOCATION');
  }
  const rawPath = parsed.pathname.replace(/^\/+/, '');
  let reference;
  try {
    reference = decodeURIComponent(rawPath);
  } catch (_) {
    throw backupError('Local backup location is invalid.', 'INVALID_BACKUP_LOCATION');
  }
  return assertSafeBackupReference(reference);
}

function safeManifestMetadata(metadata) {
  const json = JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {});
  if (Buffer.byteLength(json, 'utf8') > 64 * 1024) {
    throw backupError('Backup metadata exceeds the allowed size.', 'BACKUP_METADATA_TOO_LARGE');
  }
  return JSON.parse(json);
}

function manifestAad(reference) {
  return `LGSV-HR:LOCAL:${reference}:MANIFEST`;
}

function objectAad(reference, objectName) {
  return `LGSV-HR:LOCAL:${reference}:${objectName}`;
}

class LocalStorageAdapter {
  constructor(options = {}) {
    this.provider = 'LOCAL';
    this.rootPath = path.resolve(options.rootPath || privateDevelopmentBackupRoot());
    this.encryptionKey = options.encryptionKey || null;
    this.maxFiles = options.maxFiles;
    this.maxBytes = options.maxBytes;
  }

  requireEncryptionKey() {
    return normalizeEncryptionKey(this.encryptionKey);
  }

  async initialize() {
    this.requireEncryptionKey();
    await fs.promises.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(this.rootPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw backupError('Local backup root must be a regular directory.', 'UNSAFE_LOCAL_BACKUP_ROOT');
    }
    await fs.promises.chmod(this.rootPath, 0o700).catch(() => {});
  }

  manifestPath(reference) {
    return resolveInside(this.rootPath, assertSafeBackupReference(reference), ENCRYPTED_MANIFEST_NAME);
  }

  async readManifest(reference) {
    const manifestPath = this.manifestPath(reference);
    const stat = await fs.promises.lstat(manifestPath).catch(error => {
      if (error.code === 'ENOENT') throw backupError('Local backup artifact was not found.', 'BACKUP_ARTIFACT_MISSING');
      throw error;
    });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) {
      throw backupError('Local backup manifest is invalid.', 'INVALID_BACKUP_MANIFEST');
    }
    let manifest;
    try {
      const encrypted = await fs.promises.readFile(manifestPath);
      manifest = JSON.parse(decryptBuffer(encrypted, this.requireEncryptionKey(), manifestAad(reference)).toString('utf8'));
    } catch (error) {
      if (error?.code === 'BACKUP_DECRYPTION_FAILED') throw error;
      throw backupError('Local backup manifest is unreadable.', 'INVALID_BACKUP_MANIFEST', { cause: error });
    }
    if (
      manifest?.formatVersion !== MANIFEST_FORMAT_VERSION ||
      manifest?.provider !== this.provider ||
      manifest?.backupReference !== reference ||
      !['FILE', 'DIRECTORY'].includes(manifest?.artifact?.kind) ||
      !/^[a-f0-9]{64}$/.test(String(manifest?.artifact?.checksum || '')) ||
      !Array.isArray(manifest?.encryptedObjects)
    ) {
      throw backupError('Local backup manifest failed validation.', 'INVALID_BACKUP_MANIFEST');
    }
    return manifest;
  }

  sourceEntries(artifactPath, descriptor, sourceFiles) {
    if (descriptor.kind === 'FILE') {
      return [{
        path: 'payload',
        size: descriptor.sizeBytes,
        sha256: descriptor.checksum,
        absolutePath: sourceFiles[0].absolutePath,
      }];
    }
    const sourceByPath = new Map(sourceFiles.map(file => [file.relativePath, file]));
    return descriptor.entries.map(entry => {
      const source = sourceByPath.get(entry.path);
      if (!source) throw backupError('Backup source changed during encryption.', 'BACKUP_SOURCE_CHANGED');
      return { ...entry, absolutePath: source.absolutePath };
    });
  }

  async storeArtifact({ artifactPath, backupReference, metadata = {} }) {
    await this.initialize();
    const reference = assertSafeBackupReference(backupReference);
    const descriptor = await describeArtifact(artifactPath, {
      maxFiles: this.maxFiles,
      maxBytes: this.maxBytes,
    });
    const finalDirectory = resolveInside(this.rootPath, reference);
    const existingStat = await fs.promises.lstat(finalDirectory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existingStat) {
      if (!existingStat.isDirectory() || existingStat.isSymbolicLink()) {
        throw backupError('Existing local backup target is unsafe.', 'UNSAFE_LOCAL_BACKUP_TARGET');
      }
      const existing = await this.readManifest(reference);
      if (existing.artifact.checksum !== descriptor.checksum) {
        throw backupError('Backup reference already belongs to a different artifact.', 'BACKUP_IDEMPOTENCY_CONFLICT');
      }
      const verification = await this.verifyStoredArtifact(locationForReference(reference), descriptor.checksum);
      if (!verification.valid) {
        throw backupError('Existing backup artifact failed integrity verification.', 'BACKUP_INTEGRITY_MISMATCH');
      }
      return { provider: this.provider, location: locationForReference(reference), descriptor: existing.artifact, idempotent: true };
    }

    const sourceFiles = await walkRegularFiles(artifactPath, { maxFiles: this.maxFiles, maxBytes: this.maxBytes });
    const entries = this.sourceEntries(artifactPath, descriptor, sourceFiles);
    const stagingDirectory = await fs.promises.mkdtemp(path.join(this.rootPath, '.staging-'));
    try {
      const encryptedObjects = [];
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const objectName = `objects/${String(index + 1).padStart(8, '0')}.bin`;
        const destination = path.join(stagingDirectory, ...objectName.split('/'));
        const encrypted = await encryptFile(entry.absolutePath, destination, this.requireEncryptionKey(), objectAad(reference, objectName));
        if (encrypted.plaintextSha256 !== entry.sha256 || encrypted.plaintextSize !== Number(entry.size)) {
          throw backupError('Backup source changed during local encryption.', 'BACKUP_SOURCE_CHANGED');
        }
        encryptedObjects.push({
          object: objectName,
          path: entry.path,
          size: entry.size,
          sha256: entry.sha256,
          encryptedSize: encrypted.encryptedSize,
          encryptedSha256: encrypted.encryptedSha256,
        });
      }
      const manifest = {
        formatVersion: MANIFEST_FORMAT_VERSION,
        provider: this.provider,
        encryption: 'AES-256-GCM',
        keyFingerprint: crypto.createHash('sha256').update(this.requireEncryptionKey()).digest('hex').slice(0, 16),
        backupReference: reference,
        createdAt: new Date().toISOString(),
        artifact: descriptor,
        encryptedObjects,
        metadata: safeManifestMetadata(metadata),
      };
      const encryptedManifest = encryptBuffer(Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'), this.requireEncryptionKey(), manifestAad(reference));
      if (encryptedManifest.length > MAX_MANIFEST_BYTES) {
        throw backupError('Encrypted local backup manifest is too large.', 'BACKUP_METADATA_TOO_LARGE');
      }
      await fs.promises.writeFile(path.join(stagingDirectory, ENCRYPTED_MANIFEST_NAME), encryptedManifest, { mode: 0o600, flag: 'wx' });
      try {
        await fs.promises.rename(stagingDirectory, finalDirectory);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
        const raced = await this.readManifest(reference);
        if (raced.artifact.checksum !== descriptor.checksum) {
          throw backupError('Backup reference already belongs to a different artifact.', 'BACKUP_IDEMPOTENCY_CONFLICT');
        }
      }
      return { provider: this.provider, location: locationForReference(reference), descriptor, idempotent: false };
    } finally {
      if (isInside(this.rootPath, stagingDirectory)) await removeTemporaryTree(this.rootPath, stagingDirectory).catch(() => {});
    }
  }

  async findStoredArtifact(backupReference) {
    await this.initialize();
    const reference = assertSafeBackupReference(backupReference);
    const directory = resolveInside(this.rootPath, reference);
    const stat = await fs.promises.lstat(directory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw backupError('Existing local backup target is unsafe.', 'UNSAFE_LOCAL_BACKUP_TARGET');
    }
    const manifest = await this.readManifest(reference);
    const location = locationForReference(reference);
    const verification = await this.verifyStoredArtifact(location, manifest.artifact.checksum);
    if (!verification.valid) throw backupError('Existing local backup failed integrity verification.', 'BACKUP_INTEGRITY_MISMATCH');
    return {
      provider: this.provider,
      location,
      descriptor: manifest.artifact,
      metadata: manifest.metadata || {},
      verification,
      idempotent: true,
    };
  }

  async verifyStoredArtifact(location, expectedChecksum) {
    await this.initialize();
    const reference = referenceFromLocation(location);
    const expected = validateExpectedChecksum(expectedChecksum);
    const manifest = await this.readManifest(reference);
    const actualEntries = [];
    for (const object of manifest.encryptedObjects) {
      const relativeObject = normalizeRelativePath(object.object);
      if (!/^objects\/[0-9]{8}\.bin$/.test(relativeObject)) {
        throw backupError('Encrypted backup object path is invalid.', 'INVALID_BACKUP_MANIFEST');
      }
      const encryptedPath = resolveInside(this.rootPath, reference, ...relativeObject.split('/'));
      const encryptedStat = await fs.promises.lstat(encryptedPath);
      if (!encryptedStat.isFile() || encryptedStat.isSymbolicLink()) {
        throw backupError('Encrypted backup object is invalid.', 'INVALID_ENCRYPTED_BACKUP');
      }
      const encryptedHash = await sha256File(encryptedPath);
      if (encryptedHash !== object.encryptedSha256 || encryptedStat.size !== Number(object.encryptedSize)) {
        throw backupError('Encrypted backup bytes failed integrity verification.', 'BACKUP_INTEGRITY_MISMATCH');
      }
      const decrypted = await hashDecryptedFile(encryptedPath, this.requireEncryptionKey(), objectAad(reference, relativeObject));
      actualEntries.push({ path: normalizeRelativePath(object.path), size: decrypted.size, sha256: decrypted.sha256 });
    }
    actualEntries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    const actualChecksum = manifest.artifact.kind === 'FILE' ? actualEntries[0]?.sha256 : directoryChecksum(actualEntries);
    const actualSize = actualEntries.reduce((sum, entry) => sum + entry.size, 0);
    const valid = Boolean(actualChecksum) &&
      crypto.timingSafeEqual(Buffer.from(actualChecksum, 'hex'), Buffer.from(expected, 'hex')) &&
      manifest.artifact.checksum === expected &&
      actualSize === Number(manifest.artifact.sizeBytes);
    const expectedFileCount = Number(manifest.artifact.fileCount);
    return {
      valid: valid && actualEntries.length === expectedFileCount,
      expectedChecksum: expected,
      actualChecksum,
      encryptedAtRest: true,
      encryption: 'AES-256-GCM',
      descriptor: {
        ...manifest.artifact,
        checksum: actualChecksum,
        sizeBytes: actualSize,
        fileCount: actualEntries.length,
        entries: manifest.artifact.kind === 'FILE' ? null : actualEntries,
      },
      manifest,
    };
  }

  async materializeArtifact({ location, expectedChecksum, destinationRoot }) {
    const verification = await this.verifyStoredArtifact(location, expectedChecksum);
    if (!verification.valid) throw backupError('Backup artifact failed integrity verification.', 'BACKUP_INTEGRITY_MISMATCH');
    const destination = path.resolve(destinationRoot);
    const destinationStat = await fs.promises.lstat(destination).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (destinationStat && (!destinationStat.isDirectory() || destinationStat.isSymbolicLink())) {
      throw backupError('Restore workspace is unsafe.', 'UNSAFE_RESTORE_WORKSPACE');
    }
    await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
    if ((await fs.promises.readdir(destination)).length) throw backupError('Restore workspace must be empty.', 'RESTORE_WORKSPACE_NOT_EMPTY');
    const reference = referenceFromLocation(location);
    const payloadPath = path.join(destination, 'payload');
    if (verification.manifest.artifact.kind === 'DIRECTORY') await fs.promises.mkdir(payloadPath, { recursive: true, mode: 0o700 });
    for (const object of verification.manifest.encryptedObjects) {
      const relativeObject = normalizeRelativePath(object.object);
      const relativePayload = normalizeRelativePath(object.path);
      const source = resolveInside(this.rootPath, reference, ...relativeObject.split('/'));
      const output = verification.manifest.artifact.kind === 'FILE'
        ? payloadPath
        : path.resolve(payloadPath, ...relativePayload.split('/'));
      if (verification.manifest.artifact.kind === 'DIRECTORY' && !output.startsWith(`${path.resolve(payloadPath)}${path.sep}`)) {
        throw backupError('Backup manifest contains an unsafe output path.', 'UNSAFE_ARTIFACT_ENTRY');
      }
      await decryptFile(source, output, this.requireEncryptionKey(), objectAad(reference, relativeObject));
    }
    const copied = await verifyArtifact(payloadPath, expectedChecksum, { maxFiles: this.maxFiles, maxBytes: this.maxBytes });
    if (!copied.valid) throw backupError('Decrypted backup failed integrity verification.', 'BACKUP_INTEGRITY_MISMATCH');
    return { artifactPath: payloadPath, descriptor: copied.descriptor, verification: copied };
  }
}

module.exports = {
  ENCRYPTED_MANIFEST_NAME,
  LocalStorageAdapter,
  locationForReference,
  privateDevelopmentBackupRoot,
  referenceFromLocation,
};
