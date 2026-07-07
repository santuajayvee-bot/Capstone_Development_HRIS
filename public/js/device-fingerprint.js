/* Trusted-device fingerprint helpers. The server hashes this payload before storage. */

function detectClientDeviceType() {
  const ua = navigator.userAgent || '';
  if (/iPad|Tablet|Silk/i.test(ua)) return 'Tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'Mobile';
  return 'Desktop';
}

function detectClientBrowser() {
  const ua = navigator.userAgent || '';
  if (/Edg\//i.test(ua)) return 'Microsoft Edge';
  if (/OPR\//i.test(ua)) return 'Opera';
  if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) return 'Chrome';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return 'Safari';
  return 'Unknown Browser';
}

function detectClientOperatingSystem() {
  const ua = navigator.userAgent || '';
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  if (/Windows NT/i.test(ua) || /Win/i.test(platform)) return 'Windows';
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Mac OS X|Macintosh|Mac/i.test(`${ua} ${platform}`)) return 'macOS';
  if (/Linux/i.test(`${ua} ${platform}`)) return 'Linux';
  return platform || 'Unknown OS';
}

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

async function buildTrustedDeviceFingerprint() {
  const screenSize = window.screen
    ? `${window.screen.width || 0}x${window.screen.height || 0}x${window.screen.colorDepth || 0}`
    : 'unknown';
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const languages = Array.isArray(navigator.languages) ? navigator.languages.join(',') : navigator.language || '';
  const userAgentDataPlatform = navigator.userAgentData?.platform || '';

  return {
    userAgent: navigator.userAgent || '',
    platform: navigator.platform || '',
    userAgentDataPlatform,
    browser: detectClientBrowser(),
    operatingSystem: detectClientOperatingSystem(),
    deviceType: detectClientDeviceType(),
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
  return `${fingerprint.operatingSystem || 'Device'} ${fingerprint.browser || 'Browser'}`.trim();
}

window.buildTrustedDeviceFingerprint = buildTrustedDeviceFingerprint;
window.trustedDeviceDefaultName = trustedDeviceDefaultName;

async function promptRegisterTrustedDeviceAfterLogin() {
  const shouldRegister = window.confirm('Would you like to register this device as a trusted device?');
  if (!shouldRegister) return;
  const password = window.prompt('Confirm your account password to register this device:');
  if (!password) return;
  try {
    const fingerprint = await buildTrustedDeviceFingerprint();
    const response = await apiFetch('/api/trusted-devices/register', {
      method: 'POST',
      body: JSON.stringify({
        password,
        fingerprint,
        deviceName: trustedDeviceDefaultName(fingerprint),
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
