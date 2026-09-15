/* eslint-disable prettier/prettier */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * AES-256-GCM encrypt/decrypt for OAuth refresh tokens and API credentials
 * stored on `SeoIntegration` documents. This is a new capability for this
 * codebase — nothing else here encrypts secrets at rest today (Stripe's key
 * is a plain env var). Introduced specifically because GSC/GA4/Merchant
 * Center/Bing OAuth refresh tokens must not sit in MongoDB in plaintext.
 *
 * Key material comes from SEO_TOKEN_ENCRYPTION_KEY (any length string — run
 * through scrypt to derive a proper 32-byte key, so the env var doesn't have
 * to be exactly 32 bytes). Each ciphertext carries its own random IV + auth
 * tag so the same plaintext never produces the same ciphertext twice.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended IV length for GCM

function deriveKey(): Buffer {
  const secret = process.env.SEO_TOKEN_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      'SEO_TOKEN_ENCRYPTION_KEY is not set — refusing to encrypt/decrypt SEO integration credentials without a real key.',
    );
  }
  // Static salt is acceptable here: the secret itself is the actual entropy
  // source (an env var, not a user password), and scrypt is only being used
  // as a KDF to normalize arbitrary-length input into a 32-byte key.
  return scryptSync(secret, 'edudeen-seo-integration-salt', 32);
}

export function encryptSeoCredential(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:ciphertext, all base64 — self-describing, no separate metadata needed.
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSeoCredential(payload: string): string {
  const [ivB64, authTagB64, dataB64] = payload.split(':');
  if (!ivB64 || !authTagB64 || !dataB64) {
    throw new Error('Malformed encrypted SEO credential payload.');
  }
  const key = deriveKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}
