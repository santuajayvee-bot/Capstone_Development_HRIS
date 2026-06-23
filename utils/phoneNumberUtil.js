/* Philippine mobile formatting shared by MFA providers. */

function normalizePhilippineMobileNumber(value) {
  let phoneNumber = String(value || '').trim().replace(/[\s().-]/g, '');
  if (phoneNumber.startsWith('+')) phoneNumber = phoneNumber.slice(1);
  if (phoneNumber.startsWith('00')) phoneNumber = phoneNumber.slice(2);

  if (/^09\d{9}$/.test(phoneNumber)) return phoneNumber;
  if (/^639\d{9}$/.test(phoneNumber)) return `0${phoneNumber.slice(2)}`;
  if (/^9\d{9}$/.test(phoneNumber)) return `0${phoneNumber}`;
  return null;
}

function maskPhoneNumber(phoneNumber) {
  const normalized = normalizePhilippineMobileNumber(phoneNumber);
  return normalized ? `*******${normalized.slice(-4)}` : '';
}

module.exports = {
  maskPhoneNumber,
  normalizePhilippineMobileNumber,
};
