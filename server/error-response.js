const DEFAULT_BAD_REQUEST_MESSAGE = 'Unable to process request. Please check the submitted information and try again.';
const DEFAULT_SERVER_MESSAGE = 'The request could not be completed. Please try again later.';

const STATUS_MESSAGES = {
  401: 'Authentication is required.',
  403: 'You are not allowed to perform this action.',
  404: 'Requested resource was not found.',
  413: 'Submitted data is too large.',
  429: 'Too many requests. Please try again later.',
};

const SENSITIVE_MESSAGE_PATTERNS = [
  /<[^>]*>/,
  /\bon[a-z]+\s*=/i,
  /\b(?:javascript|vbscript|data)\s*:/i,
  /\b(?:select|insert|update|delete|drop|alter|truncate)\b[\s\S]{0,80}\b(?:from|into|table|set|where)\b/i,
  /\b(?:ER_[A-Z_]+|SQL|mysql|stack trace|password|token|secret|private key|aes|jwt)\b/i,
];

function normalizeStatusCode(err) {
  const status = Number(err?.status || err?.statusCode || 500);
  if (!Number.isInteger(status) || status < 400 || status > 599) return 500;
  return status;
}

function isSafeClientMessage(message) {
  const text = String(message || '').trim();
  if (!text || text.length > 240) return false;
  return !SENSITIVE_MESSAGE_PATTERNS.some(pattern => pattern.test(text));
}

function clientErrorMessage(err, status) {
  if (status >= 500) return DEFAULT_SERVER_MESSAGE;
  const message = String(err?.message || '').trim();
  if (status === 400) {
    return isSafeClientMessage(message) ? message : DEFAULT_BAD_REQUEST_MESSAGE;
  }
  return isSafeClientMessage(message) ? message : STATUS_MESSAGES[status] || DEFAULT_BAD_REQUEST_MESSAGE;
}

function clientErrorResponse(err) {
  const status = normalizeStatusCode(err);
  const message = clientErrorMessage(err, status);
  return {
    status,
    body: {
      success: false,
      error: message,
      message,
    },
  };
}

module.exports = {
  DEFAULT_BAD_REQUEST_MESSAGE,
  DEFAULT_SERVER_MESSAGE,
  clientErrorResponse,
  clientErrorMessage,
  isSafeClientMessage,
  normalizeStatusCode,
};
