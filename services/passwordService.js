const argon2 = require('argon2');

const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
};

const COMMON_WEAK_PASSWORDS = new Set([
  'password123!',
  'admin123!',
  'welcome123!',
  'qwerty123!',
  'marulas123!',
  'lgsvhr123!',
  'lgsv123!',
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validatePasswordStrength(password) {
  const errors = [];

  if (!isNonEmptyString(password)) {
    return {
      valid: false,
      errors: ['Password is required.'],
    };
  }

  if (password.length < 12) {
    errors.push('Password must be at least 12 characters long.');
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('Password must include at least one uppercase letter.');
  }

  if (!/[a-z]/.test(password)) {
    errors.push('Password must include at least one lowercase letter.');
  }

  if (!/[0-9]/.test(password)) {
    errors.push('Password must include at least one number.');
  }

  if (!/[^A-Za-z0-9]/.test(password)) {
    errors.push('Password must include at least one special character.');
  }

  if (COMMON_WEAK_PASSWORDS.has(password.trim().toLowerCase())) {
    errors.push('Password is too common and must not be used.');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

async function hashPassword(password) {
  if (!isNonEmptyString(password)) {
    throw new Error('Password is required.');
  }

  const strength = validatePasswordStrength(password);
  if (!strength.valid) {
    throw new Error('Password does not meet security requirements.');
  }

  // Argon2id is used because it combines resistance to side-channel attacks
  // with strong protection against GPU/password-cracking attacks.
  // Only this irreversible hash is returned for storage; plaintext passwords
  // must never be saved in the database, logs, tokens, or audit records.
  return argon2.hash(password, ARGON2ID_OPTIONS);
}

async function verifyPassword(hash, password) {
  if (!isNonEmptyString(hash) || !isNonEmptyString(password)) {
    return false;
  }

  try {
    // Verification intentionally returns only true/false. Generic results
    // avoid leaking whether the hash, account, or supplied password failed.
    return await argon2.verify(hash, password);
  } catch (error) {
    return false;
  }
}

async function isPasswordReused(newPassword, previousPasswordHashes) {
  if (!isNonEmptyString(newPassword) || !Array.isArray(previousPasswordHashes)) {
    return false;
  }

  // Reuse checks prevent weak rotation patterns where users cycle back to a
  // known old password after a reset or forced password change.
  for (const previousHash of previousPasswordHashes) {
    if (!isNonEmptyString(previousHash)) continue;

    const reused = await verifyPassword(previousHash, newPassword);
    if (reused) return true;
  }

  return false;
}

module.exports = {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  isPasswordReused,
};

