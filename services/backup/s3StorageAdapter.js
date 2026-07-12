'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const { describeArtifact, directoryChecksum, validateExpectedChecksum, verifyArtifact } = require('./artifactIntegrity');
const { backupError } = require('./backupErrors');
const {
  assertSafeBackupReference,
  normalizeRelativePath,
  walkRegularFiles,
} = require('./fileTree');

const MANIFEST_FORMAT_VERSION = 1;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function validateBucket(value) {
  const bucket = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) {
    throw backupError('AWS S3 backup bucket is invalid.', 'INVALID_S3_BUCKET');
  }
  return bucket;
}

function normalizePrefix(value) {
  const prefix = String(value || 'lgsv-hr/backups').trim().replace(/^\/+|\/+$/g, '');
  const segments = prefix.split('/');
  if (!prefix || segments.some(segment => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw backupError('AWS S3 backup prefix is invalid.', 'INVALID_S3_PREFIX');
  }
  return prefix;
}

function isNotFound(error) {
  return ['NoSuchKey', 'NotFound', 'NoSuchBucket'].includes(error?.name) || Number(error?.$metadata?.httpStatusCode) === 404;
}

function s3Location(bucket, manifestKey) {
  return `s3://${bucket}/${manifestKey}`;
}

async function *bodyChunks(body) {
  if (!body) return;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === 'string') {
    yield Buffer.from(body);
    return;
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) yield Buffer.from(chunk);
    return;
  }
  if (typeof body.transformToByteArray === 'function') {
    yield Buffer.from(await body.transformToByteArray());
    return;
  }
  throw backupError('AWS S3 returned an unsupported response stream.', 'INVALID_S3_RESPONSE_BODY');
}

async function bodyToBuffer(body, maxBytes = MAX_MANIFEST_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of bodyChunks(body)) {
    size += chunk.length;
    if (size > maxBytes) throw backupError('AWS S3 backup manifest is too large.', 'INVALID_BACKUP_MANIFEST');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function hashS3Body(body) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of bodyChunks(body)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), size };
}

function safeMetadata(metadata) {
  const json = JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {});
  if (Buffer.byteLength(json, 'utf8') > 64 * 1024) {
    throw backupError('Backup metadata exceeds the allowed size.', 'BACKUP_METADATA_TOO_LARGE');
  }
  return JSON.parse(json);
}

function assertS3Encryption(response) {
  if (!['AES256', 'aws:kms', 'aws:kms:dsse'].includes(response?.ServerSideEncryption)) {
    throw backupError('AWS S3 backup object is not encrypted at rest.', 'S3_ENCRYPTION_REQUIRED');
  }
}

class S3StorageAdapter {
  constructor(options = {}) {
    this.provider = 'S3';
    this.bucket = validateBucket(options.bucket);
    this.prefix = normalizePrefix(options.prefix);
    this.region = String(options.region || '').trim() || undefined;
    this.kmsKeyId = String(options.kmsKeyId || '').trim() || null;
    this.client = options.client || new S3Client({ region: this.region });
    this.maxFiles = options.maxFiles;
    this.maxBytes = options.maxBytes;
  }

  keys(reference, checksum = null) {
    const safeReference = assertSafeBackupReference(reference);
    const root = `${this.prefix}/${safeReference}`;
    return {
      root,
      manifest: `${root}/manifest.json`,
      objectRoot: checksum ? `${root}/objects/${validateExpectedChecksum(checksum)}` : null,
    };
  }

  parseLocation(location) {
    let parsed;
    try {
      parsed = new URL(String(location || ''));
    } catch (_) {
      throw backupError('AWS S3 backup location is invalid.', 'INVALID_BACKUP_LOCATION');
    }
    if (parsed.protocol !== 's3:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw backupError('AWS S3 backup location is invalid.', 'INVALID_BACKUP_LOCATION');
    }
    if (parsed.hostname !== this.bucket) {
      throw backupError('AWS S3 backup location uses an unexpected bucket.', 'INVALID_BACKUP_LOCATION');
    }
    let key;
    try {
      key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    } catch (_) {
      throw backupError('AWS S3 backup location is invalid.', 'INVALID_BACKUP_LOCATION');
    }
    if (!key.startsWith(`${this.prefix}/`) || !key.endsWith('/manifest.json')) {
      throw backupError('AWS S3 backup location is outside the configured prefix.', 'INVALID_BACKUP_LOCATION');
    }
    const reference = key.slice(this.prefix.length + 1, -'/manifest.json'.length);
    assertSafeBackupReference(reference);
    if (key !== this.keys(reference).manifest) {
      throw backupError('AWS S3 backup location is invalid.', 'INVALID_BACKUP_LOCATION');
    }
    return { reference, manifestKey: key };
  }

  encryptionParameters() {
    return this.kmsKeyId
      ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.kmsKeyId }
      : { ServerSideEncryption: 'AES256' };
  }

  async getManifestByKey(manifestKey) {
    let response;
    try {
      response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: manifestKey }));
    } catch (error) {
      if (isNotFound(error)) throw backupError('AWS S3 backup artifact was not found.', 'BACKUP_ARTIFACT_MISSING');
      throw error;
    }
    assertS3Encryption(response);
    let manifest;
    try {
      manifest = JSON.parse((await bodyToBuffer(response.Body)).toString('utf8'));
    } catch (error) {
      if (error?.code === 'INVALID_BACKUP_MANIFEST') throw error;
      throw backupError('AWS S3 backup manifest is unreadable.', 'INVALID_BACKUP_MANIFEST', { cause: error });
    }
    if (
      manifest?.formatVersion !== MANIFEST_FORMAT_VERSION ||
      manifest?.provider !== this.provider ||
      !/^[a-f0-9]{64}$/.test(String(manifest?.artifact?.checksum || '')) ||
      !['FILE', 'DIRECTORY'].includes(manifest?.artifact?.kind) ||
      typeof manifest?.objectRoot !== 'string'
    ) {
      throw backupError('AWS S3 backup manifest failed validation.', 'INVALID_BACKUP_MANIFEST');
    }
    return manifest;
  }

  async findExistingManifest(reference) {
    const manifestKey = this.keys(reference).manifest;
    try {
      return await this.getManifestByKey(manifestKey);
    } catch (error) {
      if (error?.code === 'BACKUP_ARTIFACT_MISSING') return null;
      throw error;
    }
  }

  async putFile(key, filePath, sha256, size) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentLength: Number(size),
      ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
      ContentType: 'application/octet-stream',
      Metadata: { 'artifact-sha256': sha256 },
      ...this.encryptionParameters(),
    }));
  }

  async storeArtifact({ artifactPath, backupReference, metadata = {} }) {
    const reference = assertSafeBackupReference(backupReference);
    const descriptor = await describeArtifact(artifactPath, {
      maxFiles: this.maxFiles,
      maxBytes: this.maxBytes,
    });
    const keys = this.keys(reference, descriptor.checksum);
    const existing = await this.findExistingManifest(reference);
    if (existing) {
      if (existing.artifact.checksum !== descriptor.checksum) {
        throw backupError('Backup reference already belongs to a different artifact.', 'BACKUP_IDEMPOTENCY_CONFLICT');
      }
      const verification = await this.verifyStoredArtifact(s3Location(this.bucket, keys.manifest), descriptor.checksum);
      if (!verification.valid) {
        throw backupError('Existing AWS S3 backup failed integrity verification.', 'BACKUP_INTEGRITY_MISMATCH');
      }
      return {
        provider: this.provider,
        location: s3Location(this.bucket, keys.manifest),
        descriptor: existing.artifact,
        idempotent: true,
      };
    }

    const sourceStat = await fs.promises.lstat(path.resolve(artifactPath));
    const sourceFiles = await walkRegularFiles(artifactPath, {
      maxFiles: this.maxFiles,
      maxBytes: this.maxBytes,
    });
    const descriptorEntries = descriptor.kind === 'FILE'
      ? [{ path: 'payload', size: descriptor.sizeBytes, sha256: descriptor.checksum }]
      : descriptor.entries;
    for (let index = 0; index < sourceFiles.length; index += 1) {
      const source = sourceFiles[index];
      const entry = descriptorEntries[index];
      if (!entry || entry.path !== source.relativePath) {
        throw backupError('Artifact entry ordering changed during AWS S3 upload.', 'BACKUP_SOURCE_CHANGED');
      }
      const objectKey = descriptor.kind === 'FILE'
        ? `${keys.objectRoot}/payload`
        : `${keys.objectRoot}/payload/${entry.path}`;
      await this.putFile(objectKey, source.absolutePath, entry.sha256, entry.size);
    }

    const manifest = {
      formatVersion: MANIFEST_FORMAT_VERSION,
      provider: this.provider,
      backupReference: reference,
      createdAt: new Date().toISOString(),
      objectRoot: keys.objectRoot,
      artifact: descriptor,
      metadata: safeMetadata(metadata),
    };
    const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: keys.manifest,
        Body: manifestBody,
        ContentLength: manifestBody.length,
        ChecksumSHA256: crypto.createHash('sha256').update(manifestBody).digest('base64'),
        ContentType: 'application/json',
        IfNoneMatch: '*',
        ...this.encryptionParameters(),
      }));
    } catch (error) {
      if (Number(error?.$metadata?.httpStatusCode) !== 412 && error?.name !== 'PreconditionFailed') throw error;
      const raced = await this.getManifestByKey(keys.manifest);
      if (raced.artifact.checksum !== descriptor.checksum) {
        throw backupError('Backup reference already belongs to a different artifact.', 'BACKUP_IDEMPOTENCY_CONFLICT');
      }
    }
    return {
      provider: this.provider,
      location: s3Location(this.bucket, keys.manifest),
      descriptor,
      idempotent: false,
      sourceKind: sourceStat.isDirectory() ? 'DIRECTORY' : 'FILE',
    };
  }

  async verifyStoredArtifact(location, expectedChecksum) {
    const expected = validateExpectedChecksum(expectedChecksum);
    const { reference, manifestKey } = this.parseLocation(location);
    const manifest = await this.getManifestByKey(manifestKey);
    if (manifest.backupReference !== reference || manifest.artifact.checksum !== expected) {
      return {
        valid: false,
        expectedChecksum: expected,
        actualChecksum: manifest.artifact.checksum,
        descriptor: manifest.artifact,
        manifest,
      };
    }

    const entries = manifest.artifact.kind === 'FILE'
      ? [{ path: 'payload', size: manifest.artifact.sizeBytes, sha256: manifest.artifact.checksum }]
      : manifest.artifact.entries;
    if (!Array.isArray(entries)) throw backupError('AWS S3 backup manifest has no artifact entries.', 'INVALID_BACKUP_MANIFEST');
    const actualEntries = [];
    for (const entry of entries) {
      const relativePath = normalizeRelativePath(entry.path);
      const key = manifest.artifact.kind === 'FILE'
        ? `${manifest.objectRoot}/payload`
        : `${manifest.objectRoot}/payload/${relativePath}`;
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      assertS3Encryption(response);
      const actual = await hashS3Body(response.Body);
      actualEntries.push({ path: relativePath, size: actual.size, sha256: actual.sha256 });
    }
    const actualChecksum = manifest.artifact.kind === 'FILE'
      ? actualEntries[0]?.sha256
      : directoryChecksum(actualEntries);
    const sizeBytes = actualEntries.reduce((sum, entry) => sum + entry.size, 0);
    const valid = Boolean(actualChecksum) &&
      crypto.timingSafeEqual(Buffer.from(actualChecksum, 'hex'), Buffer.from(expected, 'hex')) &&
      sizeBytes === Number(manifest.artifact.sizeBytes);
    return {
      valid,
      expectedChecksum: expected,
      actualChecksum,
      descriptor: {
        ...manifest.artifact,
        checksum: actualChecksum,
        sizeBytes,
        fileCount: actualEntries.length,
        entries: manifest.artifact.kind === 'FILE' ? null : actualEntries,
      },
      manifest,
    };
  }

  async materializeArtifact({ location, expectedChecksum, destinationRoot }) {
    const verification = await this.verifyStoredArtifact(location, expectedChecksum);
    if (!verification.valid) {
      throw backupError('AWS S3 backup failed integrity verification.', 'BACKUP_INTEGRITY_MISMATCH');
    }
    const destination = path.resolve(destinationRoot);
    const stat = await fs.promises.lstat(destination).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw backupError('Restore workspace is unsafe.', 'UNSAFE_RESTORE_WORKSPACE');
    }
    await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
    if ((await fs.promises.readdir(destination)).length) {
      throw backupError('Restore workspace must be empty.', 'RESTORE_WORKSPACE_NOT_EMPTY');
    }

    const manifest = verification.manifest;
    const payloadPath = path.join(destination, 'payload');
    const entries = manifest.artifact.kind === 'FILE'
      ? [{ path: 'payload', size: manifest.artifact.sizeBytes, sha256: manifest.artifact.checksum }]
      : manifest.artifact.entries;
    if (manifest.artifact.kind === 'DIRECTORY') await fs.promises.mkdir(payloadPath, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      const relativePath = normalizeRelativePath(entry.path);
      const outputPath = manifest.artifact.kind === 'FILE'
        ? payloadPath
        : path.resolve(payloadPath, ...relativePath.split('/'));
      if (manifest.artifact.kind === 'DIRECTORY' && !outputPath.startsWith(`${path.resolve(payloadPath)}${path.sep}`)) {
        throw backupError('AWS S3 manifest contains an unsafe path.', 'UNSAFE_ARTIFACT_ENTRY');
      }
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      const key = manifest.artifact.kind === 'FILE'
        ? `${manifest.objectRoot}/payload`
        : `${manifest.objectRoot}/payload/${relativePath}`;
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      assertS3Encryption(response);
      if (response.Body && typeof response.Body.pipe === 'function') {
        await pipeline(response.Body, fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }));
      } else {
        await fs.promises.writeFile(outputPath, await bodyToBuffer(response.Body, Math.max(Number(entry.size) + 1, MAX_MANIFEST_BYTES)), { flag: 'wx', mode: 0o600 });
      }
    }
    const copied = await verifyArtifact(payloadPath, expectedChecksum, {
      maxFiles: this.maxFiles,
      maxBytes: this.maxBytes,
    });
    if (!copied.valid) {
      throw backupError('Materialized AWS S3 backup failed integrity verification.', 'BACKUP_INTEGRITY_MISMATCH');
    }
    return { artifactPath: payloadPath, descriptor: copied.descriptor, verification: copied };
  }
}

module.exports = {
  S3StorageAdapter,
  assertS3Encryption,
  bodyToBuffer,
  hashS3Body,
  normalizePrefix,
  s3Location,
  validateBucket,
};
