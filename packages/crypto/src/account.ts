import { deriveWrappingKeyPair, deriveRecoveryKeyPair } from './primitives/key-derivation.js';
import { asWrappingPrivateKey, asWrappingPublicKey, generateKeyPair } from './primitives/keys.js';
import { generateRecoveryPhrase, phraseToSeed } from './recovery/phrase.js';
import { wrapSecretTo, unwrapSecret } from './wrap/wrap.js';
import { WRAP_LABELS } from './wrap/labels.js';
import type { WrappingPrivateKey } from './primitives/keys.js';
import type { WrappedSecret } from './wrap/wrap.js';

export interface CreateAccountResult {
  publicKey: Uint8Array;
  /** Public half of the phrase-derived keypair; stored so the server can seal a reset challenge. */
  recoveryPublicKey: Uint8Array;
  passwordWrappedPrivateKey: Uint8Array;
  recoveryWrappedPrivateKey: Uint8Array;
  recoveryPhrase: string;
}

export async function createAccount(opaqueExportKey: Uint8Array): Promise<CreateAccountResult> {
  const account = generateKeyPair();

  const wrappingKeyPair = deriveWrappingKeyPair(opaqueExportKey);
  const passwordWrappedPrivateKey = wrapSecretTo(
    asWrappingPublicKey(wrappingKeyPair.publicKey),
    account.privateKey,
    WRAP_LABELS.accountKeyPassword
  );

  const recoveryPhrase = generateRecoveryPhrase();
  const seed = await phraseToSeed(recoveryPhrase);
  const recoveryKeyPair = await deriveRecoveryKeyPair(seed);
  const recoveryWrappedPrivateKey = wrapSecretTo(
    asWrappingPublicKey(recoveryKeyPair.publicKey),
    account.privateKey,
    WRAP_LABELS.accountKeyRecovery
  );

  return {
    publicKey: account.publicKey,
    recoveryPublicKey: recoveryKeyPair.publicKey,
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
  return unwrapSecret(
    asWrappingPrivateKey(wrappingKeyPair.privateKey),
    passwordWrappedPrivateKey as WrappedSecret,
    WRAP_LABELS.accountKeyPassword
  );
}

interface RecoveredAccount {
  /** The account private key, unwrapped from the recovery blob. */
  accountPrivateKey: Uint8Array;
  /**
   * The phrase-derived private half, returned alongside the key it unwrapped
   * so a caller that also has to open a reset challenge never derives it a
   * second time — the derivation is a 64 MiB Argon2id on the user's device.
   */
  recoveryPrivateKey: WrappingPrivateKey;
}

export async function recoverAccountFromMnemonic(
  mnemonic: string,
  recoveryWrappedPrivateKey: Uint8Array
): Promise<RecoveredAccount> {
  const seed = await phraseToSeed(mnemonic);
  const recoveryKeyPair = await deriveRecoveryKeyPair(seed);
  const recoveryPrivateKey = asWrappingPrivateKey(recoveryKeyPair.privateKey);
  return {
    accountPrivateKey: unwrapSecret(
      recoveryPrivateKey,
      recoveryWrappedPrivateKey as WrappedSecret,
      WRAP_LABELS.accountKeyRecovery
    ),
    recoveryPrivateKey,
  };
}

export function rewrapAccountKeyForPasswordChange(
  accountPrivateKey: Uint8Array,
  newOpaqueExportKey: Uint8Array
): Uint8Array {
  const newWrappingKeyPair = deriveWrappingKeyPair(newOpaqueExportKey);
  return wrapSecretTo(
    asWrappingPublicKey(newWrappingKeyPair.publicKey),
    accountPrivateKey,
    WRAP_LABELS.accountKeyPassword
  );
}

interface RegenerateRecoveryResult {
  recoveryPhrase: string;
  recoveryWrappedPrivateKey: Uint8Array;
  /**
   * Public half of the same keypair the blob is wrapped to. Returned rather
   * than left for the caller to re-derive: the server stores it beside the
   * blob, and a second derivation is the only way the two could diverge —
   * which would leave the account with no reset path at all.
   */
  recoveryPublicKey: Uint8Array;
}

export async function regenerateRecoveryPhrase(
  accountPrivateKey: Uint8Array
): Promise<RegenerateRecoveryResult> {
  const recoveryPhrase = generateRecoveryPhrase();
  const seed = await phraseToSeed(recoveryPhrase);
  const recoveryKeyPair = await deriveRecoveryKeyPair(seed);
  const recoveryWrappedPrivateKey = wrapSecretTo(
    asWrappingPublicKey(recoveryKeyPair.publicKey),
    accountPrivateKey,
    WRAP_LABELS.accountKeyRecovery
  );

  return {
    recoveryPhrase,
    recoveryWrappedPrivateKey,
    recoveryPublicKey: recoveryKeyPair.publicKey,
  };
}
