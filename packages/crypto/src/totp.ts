import { generateSecret as otpGenerateSecret, generateURI, verify, generateSync } from 'otplib';
import { hkdfSha256 } from './hash.js';
import { symmetricEncrypt, symmetricDecrypt } from './symmetric.js';

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
    const result = await verify({ token: code, secret, strategy: 'totp', epochTolerance: 30 });
    return result.valid;
  } catch {
    return false;
  }
}

export function generateTotpCodeSync(secret: string): string {
  return generateSync({ secret });
}

const TOTP_PERIOD_SECONDS = 30;
const DEFAULT_TOTP_WINDOW_STEPS = 1;

export type VerifyTotpTokenResult = { ok: true } | { ok: false; reason: 'invalid-code' };

export type DecryptAndVerifyTotpResult =
  | { ok: true }
  | { ok: false; reason: 'decrypt-failed' | 'invalid-code' };

export async function verifyTotpToken(args: {
  secret: string;
  code: string;
  now: Date;
  window?: number;
}): Promise<VerifyTotpTokenResult> {
  const windowSteps = args.window ?? DEFAULT_TOTP_WINDOW_STEPS;
  const epochTolerance = windowSteps * TOTP_PERIOD_SECONDS;
  const epochSeconds = Math.floor(args.now.getTime() / 1000);

  try {
    const result = await verify({
      token: args.code,
      secret: args.secret,
      strategy: 'totp',
      epoch: epochSeconds,
      epochTolerance,
    });
    return result.valid ? { ok: true } : { ok: false, reason: 'invalid-code' };
  } catch {
    return { ok: false, reason: 'invalid-code' };
  }
}

export async function decryptAndVerifyTotp(args: {
  masterSecret: Uint8Array;
  encryptedSecret: Uint8Array;
  code: string;
  now: Date;
  window?: number;
}): Promise<DecryptAndVerifyTotpResult> {
  const key = deriveTotpEncryptionKey(args.masterSecret);

  let secret: string;
  try {
    secret = decryptTotpSecret(args.encryptedSecret, key);
  } catch {
    return { ok: false, reason: 'decrypt-failed' };
  }

  return verifyTotpToken({
    secret,
    code: args.code,
    now: args.now,
    ...(args.window !== undefined && { window: args.window }),
  });
}
