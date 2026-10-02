/**
 * The domain-separation label registry: every string this package feeds into a
 * key derivation is declared here once, and the branded types make the registry
 * the only producer of one. A caller cannot pass a bare string, and cannot pass
 * a label registered for another primitive — both stop compiling.
 *
 * The brands are casts, not validated constructors: `'' as WrapLabel` compiles.
 * What actually keeps every label non-empty and distinct is that the three
 * constructors below are module-private, so these objects are the only source
 * of a label, plus the registry's own invariant test. Any boundary that ever
 * accepts a caller-supplied label needs its own runtime check.
 *
 * Separation across primitives comes from the disjoint info prefixes each
 * primitive applies (`hushbox/wrap:`, `hushbox/seal:`), never from the label
 * text, so the same text under two primitives still derives incompatible keys.
 *
 * Labels are unversioned: every blob carries `BLOB_FORMAT_VERSION` and every
 * reader asserts it, so a `.v1` suffix would be a second versioning mechanism
 * for one job. The `-v1` suffixes below are the values already baked into
 * derivations and are kept verbatim — the registry is a compile-time guard over
 * the wire format, never a change to it.
 */

/** A label that separates one asymmetric wrap purpose from another. */
export type WrapLabel = string & { readonly __brand: 'crypto.WrapLabel' };
/** A label that separates one symmetric seal purpose from another. */
export type SealLabel = string & { readonly __brand: 'crypto.SealLabel' };
/** A label that separates one key derivation from another. */
export type DeriveLabel = string & { readonly __brand: 'crypto.DeriveLabel' };

function wrapLabel(value: string): WrapLabel {
  return value as WrapLabel;
}

function sealLabel(value: string): SealLabel {
  return value as SealLabel;
}

function deriveLabel(value: string): DeriveLabel {
  return value as DeriveLabel;
}

/** Asymmetric wraps (`wrapSecretTo` / `unwrapSecret`). */
export const WRAP_LABELS = {
  /**
   * The account private key wrapped to the password-derived keypair. Both
   * recipients of that key are wrapping keypairs derived from a user-held
   * secret, so only the label keeps a password wrap from opening as a
   * recovery wrap.
   */
  accountKeyPassword: wrapLabel('account-key.password'),
  /** The account private key wrapped to the recovery-phrase-derived keypair. */
  accountKeyRecovery: wrapLabel('account-key.recovery'),
  /**
   * An epoch private key wrapped to a principal's public key. Shared by every
   * producer of that wrap — epoch creation, a later member join, and a share
   * link — because all three are read back through the same unwrap.
   */
  epochKeyMember: wrapLabel('epoch-key.member'),
  /** The previous epoch key wrapped to the new epoch key. */
  epochKeyChainLink: wrapLabel('epoch-key.chain-link'),
  /** A content key wrapped to an epoch public key. */
  contentKeyEpoch: wrapLabel('content-key.epoch'),
  /** A conversation title wrapped to its epoch key. */
  conversationTitleEpoch: wrapLabel('conversation-title.epoch'),
  /** Custom instructions wrapped to an account key. */
  customInstructionsAccount: wrapLabel('custom-instructions.account'),
  /**
   * A recovery-reset challenge nonce wrapped to a recovery public key. Distinct
   * from `accountKeyRecovery` so the challenge can never be opened as — or
   * substituted for — the account-key wrap held under the same key material.
   */
  resetChallengeRecovery: wrapLabel('reset-challenge.recovery'),
} as const;

/** Symmetric seals (`sealWithKey` / `openSealed`). */
export const SEAL_LABELS = {
  /** A TOTP secret at rest, sealed under the server's TOTP encryption key. */
  totpSecretServer: sealLabel('totp-secret.server'),
  /** A content key sealed to a share link's secret. */
  contentKeyShare: sealLabel('content-key.share'),
  /**
   * A user's OPAQUE server material (OPRF seed + AKE keypair) at rest, sealed
   * under the server's key-encryption key.
   */
  opaqueServerMaterial: sealLabel('opaque-server-material.kek'),
} as const;

/** Key derivations: HKDF info strings, and the salts that act as labels. */
export const DERIVE_LABELS = {
  /** Keyed epoch confirmation over an epoch private key. */
  epochConfirmation: deriveLabel('hushbox/epoch-confirmation'),
  /** The per-identifier dummy wrapped key served for unknown accounts. */
  recoveryDummyWrappedKey: deriveLabel('hushbox/recovery-dummy-wrapped-key/v1'),
  /**
   * The per-identifier dummy reset-challenge recipient for unknown accounts.
   * Distinct from `recoveryDummyWrappedKey`, so the two dummies one unknown
   * identifier can produce are unlinkable to each other.
   */
  recoveryDummyResetChallenge: deriveLabel('hushbox/recovery-dummy-reset-challenge'),
  /** The reset proof derived from a challenge nonce. */
  recoveryResetProof: deriveLabel('hushbox/recovery-reset-proof'),
  /** The wrapping keypair derived from the OPAQUE export key. */
  accountWrapKeyPair: deriveLabel('account-wrap-v1'),
  /** The wrapping keypair derived from the recovery-phrase KEK. */
  recoveryWrapKeyPair: deriveLabel('recovery-wrap-v1'),
  /** The keypair derived from a share link's secret. */
  linkKeyPair: deriveLabel('link-keypair-v1'),
  /** The token a share link's guest authenticates with, derived from the link's secret. */
  linkAuth: deriveLabel('hushbox/link-auth'),
  /** Argon2id salt for the recovery-phrase key-encryption key. */
  recoveryKek: deriveLabel('recovery-kek-v1'),
  /** HKDF salt for the server's TOTP encryption key. */
  totpEncryptionKey: deriveLabel('totp-encryption-v1'),
  /** The key-encryption key over OPAQUE server material, from its env secret. */
  opaqueKek: deriveLabel('hushbox/opaque-kek'),
  /**
   * Key fingerprints: the non-secret key id a sealed blob carries. One label
   * per key class, so the same bytes under two classes never share an id.
   */
  opaqueKekFingerprint: deriveLabel('hushbox/fingerprint/opaque-kek'),
  totpKeyFingerprint: deriveLabel('hushbox/fingerprint/totp-key'),
  /** OPAQUE server-credential derivations — salts at their call site, not info strings. */
  opaqueOprfSeed: deriveLabel('opaque-oprf-seed-v1'),
  opaqueAkeSeed: deriveLabel('opaque-ake-seed-v1'),
  opaqueFakePassword: deriveLabel('opaque-fake-password-v1'),
  opaqueFakeSalt: deriveLabel('opaque-fake-salt-v1'),
} as const;
