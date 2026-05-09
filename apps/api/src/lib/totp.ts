export {
  deriveTotpEncryptionKey,
  encryptTotpSecret,
  decryptTotpSecret,
  generateTotpSecret,
  generateTotpUri,
  verifyTotpCode,
} from '@hushbox/crypto';
import { verifyTotpCode } from '@hushbox/crypto';
import { redisGet, redisSet } from './redis-registry.js';
import type { Redis } from '@upstash/redis';

export async function verifyTotpWithReplayProtection(
  redis: Redis,
  userId: string,
  code: string,
  secret: string
): Promise<{ valid: boolean; error?: string }> {
  const alreadyUsed = await redisGet(redis, 'totpUsedCode', userId, code);
  if (alreadyUsed) {
    return { valid: false, error: 'CODE_ALREADY_USED' };
  }

  const isValid = await verifyTotpCode(code, secret);

  if (isValid) {
    await redisSet(redis, 'totpUsedCode', '1', userId, code);
  }

  return { valid: isValid };
}
