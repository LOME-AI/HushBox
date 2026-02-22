import { generateKeyPair } from './sharing.js';
import { eciesEncrypt, eciesDecrypt } from './ecies.js';
import { deriveWrappingKeyPair, deriveRecoveryKeyPair } from './key-derivation.js';
import { generateRecoveryPhrase, phraseToSeed } from './recovery-phrase.js';

export interface CreateAccountResult {
  publicKey: Uint8Array;
  passwordWrappedPrivateKey: Uint8Array;
  recoveryWrappedPrivateKey: Uint8Array;
  recoveryPhrase: string;
}

export async function createAccount(opaqueExportKey: Uint8Array): Promise<CreateAccountResult> {
  const account = generateKeyPair();

  const wrappingKeyPair = deriveWrappingKeyPair(opaqueExportKey);
  const passwordWrappedPrivateKey = eciesEncrypt(wrappingKeyPair.publicKey, account.privateKey);

  const recoveryPhrase = generateRecoveryPhrase();
  const seed = await phraseToSeed(recoveryPhrase);
  const recoveryKeyPair = await deriveRecoveryKeyPair(seed);
  const recoveryWrappedPrivateKey = eciesEncrypt(recoveryKeyPair.publicKey, account.privateKey);

  return {
    publicKey: account.publicKey,
    passwordWrappedPrivateKey,
    recoveryWrappedPrivateKey,
    recoveryPhrase,
  };
}

export function unwrapAccountKeyWithPassword(
  opaqueExportKey: Uint8Array,
  passwordWrappedPrivateKey: Uint8Array
): Uint8Array {
  const wrappingKeyPair = deriveWrappingKeyPair(opaqueExportKey);
  return eciesDecrypt(wrappingKeyPair.privateKey, passwordWrappedPrivateKey);
}

export async function recoverAccountFromMnemonic(
  mnemonic: string,
  recoveryWrappedPrivateKey: Uint8Array
): Promise<Uint8Array> {
  const seed = await phraseToSeed(mnemonic);
  const recoveryKeyPair = await deriveRecoveryKeyPair(seed);
  return eciesDecrypt(recoveryKeyPair.privateKey, recoveryWrappedPrivateKey);
}

export function rewrapAccountKeyForPasswordChange(
  accountPrivateKey: Uint8Array,
  newOpaqueExportKey: Uint8Array
): Uint8Array {
  const newWrappingKeyPair = deriveWrappingKeyPair(newOpaqueExportKey);
  return eciesEncrypt(newWrappingKeyPair.publicKey, accountPrivateKey);
}

export interface RegenerateRecoveryResult {
  recoveryPhrase: string;
  recoveryWrappedPrivateKey: Uint8Array;
}

export async function regenerateRecoveryPhrase(
  accountPrivateKey: Uint8Array
): Promise<RegenerateRecoveryResult> {
  const recoveryPhrase = generateRecoveryPhrase();
  const seed = await phraseToSeed(recoveryPhrase);
  const recoveryKeyPair = await deriveRecoveryKeyPair(seed);
  const recoveryWrappedPrivateKey = eciesEncrypt(recoveryKeyPair.publicKey, accountPrivateKey);

  return { recoveryPhrase, recoveryWrappedPrivateKey };
}
