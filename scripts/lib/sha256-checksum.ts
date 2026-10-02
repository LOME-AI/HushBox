import { createHash } from 'node:crypto';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Throws unless `bytes` hash to the pinned `expectedSha`, naming `archive` in
 * the refusal. Every pinned tool release the scripts download and install is
 * checked here before anything unpacks it, so a corrupted or substituted
 * archive fails closed.
 */
export function verifySha256(bytes: Uint8Array, expectedSha: string, archive: string): void {
  const actual = sha256Hex(bytes);
  if (actual !== expectedSha) {
    throw new Error(`checksum mismatch for ${archive} (expected ${expectedSha}, got ${actual}).`);
  }
}
