'use strict';

const fs = require('fs');
const path = require('path');
const { backupError } = require('./backupErrors');

const MANIFEST_FILE_NAME = '_lgsv_backup_manifest.json';
const DEFAULT_MAX_FILES = 100000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024 * 1024;

function assertSafeBackupReference(value) {
  const reference = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(reference)) {
    throw backupError('Backup reference is invalid.', 'INVALID_BACKUP_REFERENCE');
  }
  return reference;
}

function safeLabel(value, fallback = 'artifact') {
  const label = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!label || label === '.' || label === '..') return fallback;
  return label.slice(0, 80);
}

function isInside(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveInside(rootPath, ...segments) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(root, ...segments);
  if (!isInside(root, candidate)) {
    throw backupError('Artifact path escaped its configured storage root.', 'UNSAFE_BACKUP_PATH');
  }
  return candidate;
}

function normalizeRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    segments.some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw backupError('Artifact contains an unsafe relative path.', 'UNSAFE_ARTIFACT_ENTRY');
  }
  return normalized;
}

function createBudget(options = {}) {
  return {
    files: 0,
    bytes: 0,
    maxFiles: Number(options.maxFiles || DEFAULT_MAX_FILES),
    maxBytes: Number(options.maxBytes || DEFAULT_MAX_BYTES),
  };
}

function accountForFile(budget, size) {
  budget.files += 1;
  budget.bytes += Number(size || 0);
  if (budget.files > budget.maxFiles) {
    throw backupError('Artifact exceeds the configured file-count limit.', 'BACKUP_FILE_LIMIT_EXCEEDED');
  }
  if (budget.bytes > budget.maxBytes) {
    throw backupError('Artifact exceeds the configured size limit.', 'BACKUP_SIZE_LIMIT_EXCEEDED');
  }
}

async function walkRegularFiles(rootPath, options = {}) {
  const root = path.resolve(rootPath);
  const rootStat = await fs.promises.lstat(root).catch(error => {
    if (error.code === 'ENOENT') throw backupError('Backup source does not exist.', 'BACKUP_SOURCE_MISSING');
    throw error;
  });
  if (rootStat.isSymbolicLink()) {
    throw backupError('Symbolic links are not allowed in backup artifacts.', 'BACKUP_SYMLINK_REJECTED');
  }
  const budget = options.budget || createBudget(options);
  if (rootStat.isFile()) {
    accountForFile(budget, rootStat.size);
    return [{ absolutePath: root, relativePath: 'payload', size: rootStat.size }];
  }
  if (!rootStat.isDirectory()) {
    throw backupError('Backup sources must be regular files or directories.', 'UNSUPPORTED_BACKUP_SOURCE');
  }

  const files = [];
  async function visit(directory) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw backupError('Symbolic links are not allowed in backup artifacts.', 'BACKUP_SYMLINK_REJECTED');
      }
      if (stat.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        throw backupError('Backup artifacts may contain regular files only.', 'UNSUPPORTED_BACKUP_SOURCE');
      }
      const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
      if (relativePath === MANIFEST_FILE_NAME) {
        throw backupError('Backup source uses a reserved manifest filename.', 'RESERVED_BACKUP_FILENAME');
      }
      accountForFile(budget, stat.size);
      files.push({ absolutePath, relativePath, size: stat.size });
    }
  }
  await visit(root);
  return files;
}

async function copyRegularTree(sourcePath, destinationPath, options = {}) {
  const source = path.resolve(sourcePath);
  const stat = await fs.promises.lstat(source).catch(error => {
    if (error.code === 'ENOENT') throw backupError('Backup source does not exist.', 'BACKUP_SOURCE_MISSING');
    throw error;
  });
  if (stat.isSymbolicLink()) {
    throw backupError('Symbolic links are not allowed in backup artifacts.', 'BACKUP_SYMLINK_REJECTED');
  }
  const budget = options.budget || createBudget(options);

  if (stat.isFile()) {
    accountForFile(budget, stat.size);
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    await fs.promises.copyFile(source, destinationPath, fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(destinationPath, 0o600).catch(() => {});
    return budget;
  }
  if (!stat.isDirectory()) {
    throw backupError('Backup sources must be regular files or directories.', 'UNSUPPORTED_BACKUP_SOURCE');
  }

  await fs.promises.mkdir(destinationPath, { recursive: true, mode: 0o700 });
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    if (entry.name === MANIFEST_FILE_NAME) {
      throw backupError('Backup source uses a reserved manifest filename.', 'RESERVED_BACKUP_FILENAME');
    }
    const sourceEntry = path.join(source, entry.name);
    const destinationEntry = path.join(destinationPath, entry.name);
    const entryStat = await fs.promises.lstat(sourceEntry);
    if (entryStat.isSymbolicLink()) {
      throw backupError('Symbolic links are not allowed in backup artifacts.', 'BACKUP_SYMLINK_REJECTED');
    }
    if (entryStat.isDirectory()) {
      await copyRegularTree(sourceEntry, destinationEntry, { ...options, budget });
    } else if (entryStat.isFile()) {
      accountForFile(budget, entryStat.size);
      await fs.promises.copyFile(sourceEntry, destinationEntry, fs.constants.COPYFILE_EXCL);
      await fs.promises.chmod(destinationEntry, 0o600).catch(() => {});
    } else {
      throw backupError('Backup artifacts may contain regular files only.', 'UNSUPPORTED_BACKUP_SOURCE');
    }
  }
  return budget;
}

async function removeTemporaryTree(rootPath, candidatePath) {
  if (!isInside(rootPath, candidatePath) || path.resolve(rootPath) === path.resolve(candidatePath)) {
    throw backupError('Refusing to remove a path outside the backup workspace.', 'UNSAFE_CLEANUP_PATH');
  }
  await fs.promises.rm(candidatePath, { recursive: true, force: true, maxRetries: 2 });
}

async function secureRemoveTemporaryTree(rootPath, candidatePath) {
  if (!isInside(rootPath, candidatePath) || path.resolve(rootPath) === path.resolve(candidatePath)) {
    throw backupError('Refusing to remove a path outside the backup workspace.', 'UNSAFE_CLEANUP_PATH');
  }
  const candidate = path.resolve(candidatePath);
  const stat = await fs.promises.lstat(candidate).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return;
  const files = stat.isFile() ? [candidate] : await walkRegularFiles(candidate, {
    maxFiles: DEFAULT_MAX_FILES,
    maxBytes: Number.MAX_SAFE_INTEGER,
  }).then(entries => entries.map(entry => entry.absolutePath)).catch(() => []);
  const zeroBlock = Buffer.alloc(1024 * 1024, 0);
  for (const filePath of files) {
    const fileStat = await fs.promises.lstat(filePath).catch(() => null);
    if (!fileStat?.isFile() || fileStat.isSymbolicLink()) continue;
    let handle;
    try {
      handle = await fs.promises.open(filePath, 'r+');
      let offset = 0;
      while (offset < fileStat.size) {
        const length = Math.min(zeroBlock.length, fileStat.size - offset);
        await handle.write(zeroBlock, 0, length, offset);
        offset += length;
      }
      await handle.sync();
    } catch (_) {
      // Best-effort overwrite. The restricted workspace is still removed even
      // when the filesystem or platform does not support deterministic wiping.
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  await fs.promises.rm(candidate, { recursive: true, force: true, maxRetries: 2 });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  MANIFEST_FILE_NAME,
  assertSafeBackupReference,
  copyRegularTree,
  createBudget,
  isInside,
  normalizeRelativePath,
  removeTemporaryTree,
  secureRemoveTemporaryTree,
  resolveInside,
  safeLabel,
  walkRegularFiles,
};
