import { hkdfSha256 } from './hash.js';
import { symmetricEncrypt, symmetricDecrypt } from './symmetric.js';
import { generateSecret as otpGenerateSecret, generateURI, verify, generateSync } from 'otplib';

const TOTP_INFO = new TextEncoder().encode('totp-encryption-v1');

export function deriveTotpEncryptionKey(masterSecret: Uint8Array): Uint8Array {
  return hkdfSha256(masterSecret, TOTP_INFO, undefined, 32);
}

export function encryptTotpSecret(secret: string, encryptionKey: Uint8Array): Uint8Array {
  return symmetricEncrypt(encryptionKey, new TextEncoder().encode(secret));
}

export function decryptTotpSecret(blob: Uint8Array, encryptionKey: Uint8Array): string {
  const decrypted = symmetricDecrypt(encryptionKey, blob);
  return new TextDecoder().decode(decrypted);
}

export function generateTotpSecret(): string {
  return otpGenerateSecret();
}

export function generateTotpUri(accountLabel: string, secret: string): string {
  return generateURI({ issuer: 'HushBox', label: accountLabel, secret, strategy: 'totp' });
}

export async function verifyTotpCode(code: string, secret: string): Promise<boolean> {
  try {
    const result = await verify({ token: code, secret, strategy: 'totp' });
    return result.valid;
  } catch {
    return false;
  }
}

export function generateTotpCodeSync(secret: string): string {
  return generateSync({ secret });
}
