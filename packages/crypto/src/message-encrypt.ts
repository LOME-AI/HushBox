import { eciesEncrypt, eciesDecrypt } from './ecies.js';
import { encodeForEncryption, decodeFromDecryption } from './message-codec.js';

export function encryptMessageForStorage(
  epochPublicKey: Uint8Array,
  plaintext: string
): Uint8Array {
  const payload = encodeForEncryption(plaintext);
  return eciesEncrypt(epochPublicKey, payload);
}

export function decryptMessage(epochPrivateKey: Uint8Array, blob: Uint8Array): string {
  const payload = eciesDecrypt(epochPrivateKey, blob);
  return decodeFromDecryption(payload);
}
