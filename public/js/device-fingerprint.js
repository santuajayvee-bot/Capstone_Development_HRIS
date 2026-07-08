/* Trusted-device fingerprint helpers. The server hashes this payload before storage. */

let trustedDeviceSocket = null;
let trustedDeviceSocketMetadata = null;
let trustedDeviceSocketMetadataPromise = null;

function getTrustedDeviceClientId() {
  const storageKey = 'lgsv_trusted_device_id';
  try {
    const existing = window.localStorage?.getItem(storageKey);
    if (/^[a-f0-9-]{24,80}$/i.test(existing || '')) return existing;
    const generated = window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
    window.localStorage?.setItem(storageKey, generated);
    return generated;
  } catch (_) {
    return '';
  }
}

function connectTrustedDeviceSocket() {
  if (trustedDeviceSocketMetadataPromise) return trustedDeviceSocketMetadataPromise;
  const clientDeviceId = getTrustedDeviceClientId();
  if (!clientDeviceId || typeof window.io !== 'function') {
    trustedDeviceSocketMetadataPromise = Promise.resolve(null);
    return trustedDeviceSocketMetadataPromise;
  }

  trustedDeviceSocketMetadataPromise = new Promise(resolve => {
    let settled = false;
    const finish = metadata => {
      if (settled) return;
      settled = true;
      trustedDeviceSocketMetadata = metadata || null;
      resolve(trustedDeviceSocketMetadata);
    };

    trustedDeviceSocket = window.io({
      auth: { clientDeviceId },
      query: { clientDeviceId },
      transports: ['websocket', 'polling'],
    });
    trustedDeviceSocket.on('device:metadata', finish);
    trustedDeviceSocket.on('connect_error', () => finish(null));
    window.setTimeout(() => finish(trustedDeviceSocketMetadata), 1200);
  });

  return trustedDeviceSocketMetadataPromise;
}

async function buildTrustedDeviceFingerprint() {
  const screenSize = window.screen
    ? `${window.screen.width || 0}x${window.screen.height || 0}x${window.screen.colorDepth || 0}`
    : 'unknown';
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const languages = Array.isArray(navigator.languages) ? navigator.languages.join(',') : navigator.language || '';
  const socketMetadata = await connectTrustedDeviceSocket();

  return {
    userAgent: navigator.userAgent || '',
    platform: navigator.platform || '',
    browser: socketMetadata?.browser || '',
    operatingSystem: socketMetadata?.operatingSystem || '',
    deviceType: socketMetadata?.deviceType || '',
    deviceModel: socketMetadata?.deviceModel || '',
    deviceVendor: socketMetadata?.deviceVendor || '',
    clientDeviceId: getTrustedDeviceClientId(),
    screenSize,
    timezone,
    language: navigator.language || '',
    languages,
    hardwareConcurrency: String(navigator.hardwareConcurrency || ''),
    deviceMemory: String(navigator.deviceMemory || ''),
    touchPoints: String(navigator.maxTouchPoints || 0),
    cookieEnabled: String(navigator.cookieEnabled === true),
  };
}

function trustedDeviceDefaultName(fingerprint = {}) {
  return `${fingerprint.deviceModel || fingerprint.operatingSystem || 'Device'} ${fingerprint.browser || 'Browser'}`.trim();
}

connectTrustedDeviceSocket();

window.buildTrustedDeviceFingerprint = buildTrustedDeviceFingerprint;
window.trustedDeviceDefaultName = trustedDeviceDefaultName;

async function promptRegisterTrustedDeviceAfterLogin() {
  const shouldRegister = typeof showConfirm === 'function'
    ? await showConfirm('Register this browser and computer as a trusted device for future sign-ins?', 'Register Trusted Device', 'Continue', 'Not Now')
    : window.confirm('Would you like to register this device as a trusted device?');
  if (!shouldRegister) return;
  try {
    const fingerprint = await buildTrustedDeviceFingerprint();
    const defaultName = trustedDeviceDefaultName(fingerprint);
    const registration = typeof showTrustedDeviceRegistrationModal === 'function'
      ? await showTrustedDeviceRegistrationModal(defaultName)
      : { password: window.prompt('Confirm your account password to register this device:') || '', deviceName: defaultName };
    if (!registration?.password) return;
    const response = await apiFetch('/api/trusted-devices/register', {
      method: 'POST',
      body: JSON.stringify({
        password: registration.password,
        fingerprint,
        deviceName: registration.deviceName || defaultName,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Device could not be registered.');
    if (typeof showToast === 'function') showToast(data.message || 'Device registered.', 'success');
  } catch (error) {
    if (typeof showToast === 'function') showToast(error.message, 'error');
    else alert(error.message);
  }
}

window.promptRegisterTrustedDeviceAfterLogin = promptRegisterTrustedDeviceAfterLogin;
