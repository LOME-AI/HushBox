import { argon2id } from 'hash-wasm';
import { randomBytes } from '@noble/hashes/utils.js';
import { deriveKeyPairFromSeed, type KeyPair } from './sharing.js';

export const KDF_PARAMS = {
  memory: 65_536, // 64MB
  iterations: 3,
  parallelism: 4,
  keyLength: 32,
} as const;

export function generateSalt(length = 16): Uint8Array {
  return randomBytes(length);
}

export function deriveWrappingKeyPair(opaqueExportKey: Uint8Array): KeyPair {
  return deriveKeyPairFromSeed(opaqueExportKey, 'account-wrap-v1');
}

export async function deriveRecoveryKeyPair(seed: Uint8Array): Promise<KeyPair> {
  const intermediate = await argon2id({
    password: seed,
    salt: new TextEncoder().encode('recovery-kek-v1'),
    parallelism: KDF_PARAMS.parallelism,
    memorySize: KDF_PARAMS.memory,
    iterations: KDF_PARAMS.iterations,
    hashLength: KDF_PARAMS.keyLength,
    outputType: 'binary',
  });
  return deriveKeyPairFromSeed(intermediate, 'recovery-wrap-v1');
}
