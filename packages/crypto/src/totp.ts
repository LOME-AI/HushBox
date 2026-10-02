import { generateSecret as otpGenerateSecret, generateURI, verify, generateSync } from 'otplib';
import { concatBytes } from '@noble/hashes/utils.js';
import { MalformedBlobError, UnknownKeyVersionError } from './errors.js';
import { constantTimeCompare } from './primitives/constant-time.js';
import { FINGERPRINT_BYTES, fingerprintOf } from './primitives/fingerprint.js';
import { utf8Field } from './primitives/format.js';
import { hkdfSha256 } from './primitives/hash.js';
import { asTotpEncryptionKey } from './primitives/keys.js';
import { sealWithKey, openSealed } from './wrap/seal.js';
import { DERIVE_LABELS, SEAL_LABELS } from './wrap/labels.js';
import type { TotpEncryptionKey } from './primitives/keys.js';
import type { SealedSecret } from './wrap/seal.js';

const TOTP_SALT = new TextEncoder().encode(DERIVE_LABELS.totpEncryptionKey);

/** The key id a stored secret carries: which key encrypted this row. */
export function totpKeyFingerprint(key: TotpEncryptionKey): Uint8Array {
  return fingerprintOf(key, DERIVE_LABELS.totpKeyFingerprint);
}

/**
 * Length-prefixed userId then the fixed-width fingerprint: both fields are
 * self-delimiting, so no two (userId, fingerprint) pairs share AAD bytes. The
 * fingerprint rides the AAD so substituting it fails authentication instead
 * of selecting another key.
 */
function totpAad(userId: string, fingerprint: Uint8Array): Uint8Array {
  return concatBytes(utf8Field(userId), fingerprint);
}

export function deriveTotpEncryptionKey(encryptionSecret: Uint8Array): TotpEncryptionKey {
  return asTotpEncryptionKey(
    hkdfSha256({ ikm: encryptionSecret, salt: TOTP_SALT, info: undefined, length: 32 })
  );
}

/** `fingerprint ‖ sealed`: the key id in the clear, then the seal that also authenticates it. */
export function encryptTotpSecret(
  encryptionKey: TotpEncryptionKey,
  userId: string,
  secret: string
): Uint8Array {
  const fingerprint = totpKeyFingerprint(encryptionKey);
  const sealed = sealWithKey(
    encryptionKey,
    new TextEncoder().encode(secret),
    SEAL_LABELS.totpSecretServer,
    totpAad(userId, fingerprint)
  );
  return concatBytes(fingerprint, sealed);
}

export function decryptTotpSecret(
  encryptionKey: TotpEncryptionKey,
  userId: string,
  blob: Uint8Array
): string {
  if (blob.length < FINGERPRINT_BYTES) {
    throw new MalformedBlobError(
      `TOTP blob too short: ${String(blob.length)} bytes, missing the key fingerprint`
    );
  }
  const fingerprint = blob.subarray(0, FINGERPRINT_BYTES);
  if (!constantTimeCompare(fingerprint, totpKeyFingerprint(encryptionKey))) {
    throw new UnknownKeyVersionError(fingerprint);
  }
  const decrypted = openSealed(
    encryptionKey,
    blob.subarray(FINGERPRINT_BYTES) as SealedSecret,
    SEAL_LABELS.totpSecretServer,
    totpAad(userId, fingerprint)
  );
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

type VerifyTotpTokenResult = { ok: true } | { ok: false; reason: 'invalid-code' };

type DecryptAndVerifyTotpResult =
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
  encryptionSecret: Uint8Array;
  userId: string;
  encryptedSecret: Uint8Array;
  code: string;
  now: Date;
  window?: number;
}): Promise<DecryptAndVerifyTotpResult> {
  const key = deriveTotpEncryptionKey(args.encryptionSecret);

  let secret: string;
  try {
    secret = decryptTotpSecret(key, args.userId, args.encryptedSecret);
  } catch (error) {
    // A blob under a key this build does not hold is an operator condition
    // (the key and the row disagree), never a wrong code; the caller must be
    // able to tell it apart from a blob that failed to open.
    if (error instanceof UnknownKeyVersionError) throw error;
    return { ok: false, reason: 'decrypt-failed' };
  }

  return verifyTotpToken({
    secret,
    code: args.code,
    now: args.now,
    ...(args.window !== undefined && { window: args.window }),
  });
}
