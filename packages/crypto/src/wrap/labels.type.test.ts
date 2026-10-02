import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { expectCompileTimeProof } from '@hushbox/shared/test-assertions';
import { asShareSecret, deriveKeyPairFromSeed, generateEpochKeyPair } from '../primitives/keys.js';
import { sealWithKey } from './seal.js';
import { wrapSecretTo } from './wrap.js';
import { DERIVE_LABELS, SEAL_LABELS, WRAP_LABELS } from './labels.js';
import type { KeyPair } from '../primitives/keys.js';
import type { SealedSecret } from './seal.js';
import type { WrappedSecret } from './wrap.js';

/**
 * Type tests: each @ts-expect-error line asserts that the marked call DOES NOT
 * compile. If a bare string ever became assignable to a label, or a label
 * became assignable outside the namespace it was registered in, the directive
 * would be flagged unused and `pnpm typecheck` would fail — a mistyped or
 * reused label is blocked at the type level, not at runtime.
 */

describe('label namespaces (compile-time)', () => {
  const recipient = generateEpochKeyPair();
  const sealKey = asShareSecret(randomBytes(32));

  it('rejects a bare string where a wrap label is expected', () => {
    const bareStringAsWrapLabel = (): WrappedSecret =>
      // @ts-expect-error — a bare string is not a registered WrapLabel
      wrapSecretTo(recipient.publicKey, randomBytes(32), 'account-key.password');
    expectCompileTimeProof(bareStringAsWrapLabel);
  });

  it('rejects a seal label where a wrap label is expected', () => {
    const sealLabelAsWrapLabel = (): WrappedSecret =>
      // @ts-expect-error — SealLabel is not assignable to WrapLabel
      wrapSecretTo(recipient.publicKey, randomBytes(32), SEAL_LABELS.totpSecretServer);
    expectCompileTimeProof(sealLabelAsWrapLabel);
  });

  it('rejects a wrap label where a seal label is expected', () => {
    const wrapLabelAsSealLabel = (): SealedSecret =>
      // @ts-expect-error — WrapLabel is not assignable to SealLabel
      sealWithKey(sealKey, randomBytes(32), WRAP_LABELS.contentKeyEpoch);
    expectCompileTimeProof(wrapLabelAsSealLabel);
  });

  it('rejects a wrap label where a derivation label is expected', () => {
    const wrapLabelAsDeriveLabel = (): KeyPair =>
      // @ts-expect-error — WrapLabel is not assignable to DeriveLabel
      deriveKeyPairFromSeed(randomBytes(32), WRAP_LABELS.accountKeyRecovery);
    expectCompileTimeProof(wrapLabelAsDeriveLabel);
  });

  it('rejects a bare string where a derivation label is expected', () => {
    const bareStringAsDeriveLabel = (): KeyPair =>
      // @ts-expect-error — a bare string is not a registered DeriveLabel
      deriveKeyPairFromSeed(randomBytes(32), 'link-keypair-v1');
    expectCompileTimeProof(bareStringAsDeriveLabel);
  });

  it('accepts each registry label at its own primitive', () => {
    expect(
      wrapSecretTo(recipient.publicKey, randomBytes(32), WRAP_LABELS.epochKeyMember)
    ).toBeInstanceOf(Uint8Array);
    expect(sealWithKey(sealKey, randomBytes(32), SEAL_LABELS.totpSecretServer)).toBeInstanceOf(
      Uint8Array
    );
    expect(
      deriveKeyPairFromSeed(randomBytes(32), DERIVE_LABELS.linkKeyPair).publicKey
    ).toHaveLength(32);
  });
});
