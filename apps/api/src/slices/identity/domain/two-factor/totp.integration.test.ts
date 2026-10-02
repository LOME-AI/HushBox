import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import {
  deriveTotpEncryptionKey,
  encryptTotpSecret,
  generateTotpCodeSync,
  generateTotpSecret,
} from '@hushbox/crypto';
import { textEncoder } from '@hushbox/shared';
import { IDENTITY_KEYS } from '../keys.js';
import { verifyStoredTotp } from './totp.js';
import type { VerifyStoredTotpArgs } from './totp.js';
import type { Result } from '../../../../lib/result/index.js';

/** Awaits a Result-producing call and unwraps its value; a failure throws. */
async function unwrap<T, E>(pending: PromiseLike<Result<T, E>>): Promise<T> {
  const result = await pending;
  return result._unsafeUnwrap();
}

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const TOTP_SECRET = textEncoder.encode('totp-secret-at-least-32-characters-long!');
const FOREIGN_TOTP_SECRET = textEncoder.encode('foreign-totp-at-least-32-characters-long');

function verifyArgs(
  sealedUnder: Uint8Array = TOTP_SECRET
): VerifyStoredTotpArgs & { readonly code: string } {
  const secret = generateTotpSecret();
  const userId = `totp-race-${crypto.randomUUID()}`;
  const encryptedSecret = encryptTotpSecret(deriveTotpEncryptionKey(sealedUnder), userId, secret);
  return {
    redis,
    encryptedSecret,
    secrets: { totpEncryptionSecret: TOTP_SECRET },
    userId,
    code: generateTotpCodeSync(secret),
    now: new Date(),
  };
}

describe('verifyStoredTotp on a blob sealed under a foreign key', () => {
  it('answers the typed stranded verdict instead of throwing', async () => {
    const args = verifyArgs(FOREIGN_TOTP_SECRET);
    const verdict = await verifyStoredTotp(args);
    expect(verdict._unsafeUnwrap()).toEqual({ kind: 'stranded' });
  });

  it('claims no used-code marker, so the code is not burned', async () => {
    const args = verifyArgs(FOREIGN_TOTP_SECRET);
    expect(await unwrap(verifyStoredTotp(args))).toEqual({ kind: 'stranded' });
    const marker = await redis.get(IDENTITY_KEYS.totpUsedCode.buildKey(args.userId, args.code));
    expect(marker).toBeNull();
  });

  it('still accepts the same code once the blob opens under the live key', async () => {
    const stranded = verifyArgs(FOREIGN_TOTP_SECRET);
    expect(await unwrap(verifyStoredTotp(stranded))).toEqual({ kind: 'stranded' });
    const reachable = {
      ...stranded,
      secrets: { totpEncryptionSecret: FOREIGN_TOTP_SECRET },
    };
    expect(await unwrap(verifyStoredTotp(reachable))).toEqual({ kind: 'ok' });
  });
});

describe('verifyStoredTotp single-use replay claim', () => {
  it('accepts exactly one of two concurrent submissions of the same valid code', async () => {
    const args = verifyArgs();
    const [first, second] = await Promise.all([verifyStoredTotp(args), verifyStoredTotp(args)]);
    const kinds = [first._unsafeUnwrap().kind, second._unsafeUnwrap().kind].toSorted((a, b) =>
      a.localeCompare(b)
    );
    expect(kinds).toEqual(['invalid', 'ok']);
  });

  it('rejects a sequential replay of an accepted code as invalid', async () => {
    const args = verifyArgs();
    const first = await verifyStoredTotp(args);
    expect(first._unsafeUnwrap().kind).toBe('ok');
    const replay = await verifyStoredTotp(args);
    expect(replay._unsafeUnwrap().kind).toBe('invalid');
  });
});
