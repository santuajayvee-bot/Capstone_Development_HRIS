'use strict';

class BackupRuntimeError extends Error {
  constructor(message, code = 'BACKUP_RUNTIME_ERROR', options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'BackupRuntimeError';
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.details = options.details || null;
  }
}

function backupError(message, code, options) {
  return new BackupRuntimeError(message, code, options);
}

function safeProcessError(error, operation) {
  const code = error?.code ? String(error.code).slice(0, 80) : null;
  return new BackupRuntimeError(
    `${operation} failed. Check the internal backup logs for details.`,
    'BACKUP_TOOL_FAILED',
    { cause: error, retryable: true, details: code ? { processCode: code } : null }
  );
}

module.exports = {
  BackupRuntimeError,
  backupError,
  safeProcessError,
};
