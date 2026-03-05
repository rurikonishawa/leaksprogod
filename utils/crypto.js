/**
 * AES-256-GCM Encryption Utility
 * Shared between Android app and backend for E2E encryption of sensitive data.
 *
 * Format: { encrypted: true, iv: base64, tag: base64, data: base64 }
 * - iv: 12-byte initialization vector (random per message)
 * - tag: 16-byte authentication tag (GCM integrity)
 * - data: AES-256-GCM ciphertext
 */

const crypto = require('crypto');

// Pre-shared 256-bit key (32 bytes) — must match Android CryptoUtil.kt
// This is the SHA-256 hash of the passphrase "LeaksProE2E_2025_SecureKey!"
const PASSPHRASE = 'LeaksProE2E_2025_SecureKey!';
const AES_KEY = crypto.createHash('sha256').update(PASSPHRASE).digest();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;  // GCM recommended IV size
const TAG_LENGTH = 16; // GCM auth tag size

/**
 * Encrypt a JSON object → encrypted envelope
 * @param {Object} data - Plain JSON object to encrypt
 * @returns {Object} - { encrypted: true, iv, tag, data }
 */
function encrypt(data) {
  const plaintext = JSON.stringify(data);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, AES_KEY, iv, { authTagLength: TAG_LENGTH });

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag();

  return {
    encrypted: true,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted
  };
}

/**
 * Decrypt an encrypted envelope → plain JSON object
 * @param {Object} envelope - { encrypted: true, iv, tag, data }
 * @returns {Object|null} - Decrypted JSON object, or null on failure
 */
function decrypt(envelope) {
  try {
    if (!envelope || !envelope.encrypted) return envelope; // Not encrypted, pass through

    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ciphertext = envelope.data;

    const decipher = crypto.createDecipheriv(ALGORITHM, AES_KEY, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return JSON.parse(decrypted);
  } catch (err) {
    console.error('[Crypto] Decryption failed:', err.message);
    return null;
  }
}

/**
 * Try to decrypt data — if it's an encrypted envelope, decrypt it.
 * If it's plain data (not encrypted), return as-is.
 * This provides backward compatibility with unencrypted clients.
 */
function tryDecrypt(data) {
  if (data && data.encrypted === true && data.iv && data.tag && data.data) {
    const decrypted = decrypt(data);
    return decrypted || data; // Fallback to raw if decryption fails
  }
  return data; // Not encrypted, return as-is
}

module.exports = { encrypt, decrypt, tryDecrypt };
