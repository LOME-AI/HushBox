import { eciesEncrypt } from './ecies.js';

export function wrapEpochKeyForNewMember(
  epochPrivateKey: Uint8Array,
  memberPublicKey: Uint8Array
): Uint8Array {
  return eciesEncrypt(memberPublicKey, epochPrivateKey);
}
