const VERIFY_REQUEST_URL = 'https://rest.moceanapi.com/rest/2/verify/req/sms';
const VERIFY_CHECK_URL = 'https://rest.moceanapi.com/rest/2/verify/check';
const REQUEST_TIMEOUT_MS = 10000;

class MoceanServiceError extends Error {
  constructor(message, code = 'MOCEAN_REQUEST_FAILED') {
    super(message);
    this.name = 'MoceanServiceError';
    this.code = code;
  }
}

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

function getMoceanConfig() {
  const requestedCodeLength = Number.parseInt(process.env.MOCEAN_CODE_LENGTH, 10);
  return {
    token: String(process.env.MOCEAN_API_TOKEN || '').trim(),
    brand: String(process.env.MOCEAN_BRAND || 'LGSVHR').trim().slice(0, 30) || 'LGSVHR',
    codeLength: [4, 6].includes(requestedCodeLength) ? requestedCodeLength : 6,
    pinValidity: positiveInteger(process.env.MOCEAN_PIN_VALIDITY, 300, 60, 3600),
  };
}

function responseSucceeded(payload) {
  const status = payload?.status ?? payload?.code ?? payload?.data?.status;
  return payload?.success === true || Number(status) === 0;
}

function extractRequestId(payload) {
  return payload?.request_id
    || payload?.reqid
    || payload?.data?.request_id
    || payload?.data?.reqid
    || payload?.data?.id
    || null;
}

async function postMocean(url, token, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(payload).toString(),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = {}; }

    if (!response.ok) {
      throw new MoceanServiceError('Mocean verification service is unavailable.', 'MOCEAN_HTTP_FAILURE');
    }
    if (!responseSucceeded(data)) {
      throw new MoceanServiceError('Mocean verification request was rejected.', 'MOCEAN_RESPONSE_REJECTED');
    }
    return data;
  } catch (error) {
    if (error instanceof MoceanServiceError) throw error;
    throw new MoceanServiceError('Mocean verification service is unavailable.');
  } finally {
    clearTimeout(timeout);
  }
}

// Mocean receives only a normalized mobile number and verification metadata.
// API tokens and verification codes are never logged or returned to clients.
async function requestSmsVerification(phoneNumber) {
  const config = getMoceanConfig();
  if (!config.token) {
    throw new MoceanServiceError('Mocean MFA is not configured.', 'MOCEAN_NOT_CONFIGURED');
  }

  const response = await postMocean(VERIFY_REQUEST_URL, config.token, {
    'mocean-to': phoneNumber,
    'mocean-brand': config.brand,
    'mocean-code-length': String(config.codeLength),
    'mocean-pin-validity': String(config.pinValidity),
    'mocean-resp-format': 'json',
  });
  const providerRequestId = extractRequestId(response);
  if (!providerRequestId) {
    throw new MoceanServiceError('Mocean did not return a verification request reference.');
  }
  return { providerRequestId: String(providerRequestId) };
}

async function checkSmsVerification(providerRequestId, code) {
  const config = getMoceanConfig();
  if (!config.token) {
    throw new MoceanServiceError('Mocean MFA is not configured.', 'MOCEAN_NOT_CONFIGURED');
  }
  if (!providerRequestId) {
    throw new MoceanServiceError('Verification request is unavailable.', 'MOCEAN_REQUEST_NOT_FOUND');
  }

  try {
    await postMocean(VERIFY_CHECK_URL, config.token, {
      'mocean-reqid': providerRequestId,
      'mocean-code': code,
      'mocean-resp-format': 'json',
    });
    return true;
  } catch (error) {
    if (error instanceof MoceanServiceError && error.code === 'MOCEAN_RESPONSE_REJECTED') return false;
    throw error;
  }
}

module.exports = {
  MoceanServiceError,
  checkSmsVerification,
  getMoceanConfig,
  requestSmsVerification,
};
