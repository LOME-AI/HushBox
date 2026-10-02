import { describe, it, expect } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils.js';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { recoverAccountFromMnemonic, unwrapAccountKeyWithPassword } from '../account.js';
import { openServerMaterial } from '../opaque/server-material.js';
import { decryptContentEnvelope } from '../wrap/envelope.js';
import { computeEpochConfirmation, unwrapContentKeyFromEpoch } from '../content/epoch.js';
import { openChainLink, openEpochWrap } from '../content/epoch-lifecycle.js';
import { fingerprintOf } from './fingerprint.js';
import {
  asContentKey,
  asEpochPrivateKey,
  asOpaqueKek,
  asShareSecret,
  asWrappingPrivateKey,
} from './keys.js';
import {
  deriveKeysFromLinkSecret,
  deriveLinkAuthToken,
  hashLinkAuthToken,
} from '../content/link.js';
import { decryptCustomInstructions, decryptTextFromEpoch } from '../content/message-encrypt.js';
import { openShare } from '../content/message-share.js';
import { openResetChallenge } from '../recovery/challenge.js';
import { decryptTotpSecret, deriveTotpEncryptionKey } from '../totp.js';
import { unwrapSecret } from '../wrap/wrap.js';
import { DERIVE_LABELS, WRAP_LABELS } from '../wrap/labels.js';
import type { ContentLocation } from '../wrap/envelope.js';
import type { SealedSecret } from '../wrap/seal.js';
import type { WrappedSecret } from '../wrap/wrap.js';

/**
 * Format vectors: the frozen on-the-wire shape of the blob scheme.
 *
 * Every blob below is a literal, produced once by an encoder written against
 * the format description independently of this package, and never recomputed
 * from the code under test — a vector derived from the implementation cannot
 * detect the implementation changing.
 *
 * What they freeze is not only the byte layout but which fields each AAD tuple
 * carries, in which order. Reordering two fields of an AAD builder keeps every
 * field present, compiles, and passes every round-trip test in this package,
 * while making every blob written before the change permanently unreadable.
 * These vectors are the only thing that catches that.
 *
 * So a failure here means one thing: a change to this package moved the format.
 * Once real data exists the move is a compatibility break, and it is the change
 * that must be reverted — never these bytes. Until the first account stores a
 * blob the format is still free to move, but moving it means regenerating these
 * vectors as that change's own deliberate decision. Regenerating them to make a
 * red test green is never the fix.
 *
 * `account-key.recovery` carries two vectors. One passes the label in from the
 * test, so it freezes the constant's value; the other opens its blob through
 * `recoverAccountFromMnemonic`, which supplies the label itself and so covers
 * the phrase derivation too. Every change that reddens the first reddens the
 * second as well — the second's kill set is a strict superset. The first is
 * kept as the diagnostic half: it fails on the label alone, without the
 * Argon2id path, so which of the two goes red says which half moved.
 *
 * Not every vector is a blob: `computeEpochConfirmation`'s output is stored,
 * so its HKDF info tuple is frozen for the same reason an AAD tuple is —
 * reorder it and every stored confirmation stops verifying — and a key
 * fingerprint is stored on every users row and at the head of every TOTP and
 * server-material blob, so its derivation is frozen the same way.
 */

const EPOCH_PRIVATE_KEY = hexToBytes(
  '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'
);
const ACCOUNT_PRIVATE_KEY = hexToBytes(
  '6162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f80'
);
const CONTENT_KEY = hexToBytes('4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60');
const TOTP_MASTER_SECRET = hexToBytes(
  '8182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0'
);

/*
 * These ids are bound into the AAD or the HKDF info of the vectors that carry a
 * location, so moving the shared factory's anchor reddens those vectors without
 * the format having moved. Regenerate them from the recorded independent
 * encoders, never from this package.
 */
const CONVERSATION_ID = testUuidV7(0xc0_de);
const MESSAGE_ID = testUuidV7(0xbe_ef);
const CONTENT_ITEM_ID = testUuidV7(0xfa_ce);
const SENDER_ID = testUuidV7(0x15_ea);
const INSTRUCTIONS_USER_ID = testUuidV7(0x0a_11);
const TOTP_USER_ID = testUuidV7(0x70_72);
const MATERIAL_USER_ID = testUuidV7(0x0e_4c);
const POSITION = 3;
const EPOCH_NUMBER = 9;

/** A content key wrapped to an epoch key under `content-key.epoch`, no context AAD. */
const WRAPPED_CONTENT_KEY = hexToBytes(
  '025869aff450549732cbaaed5e5df9b30a6da31cb0e5742bad5ad4a1a768f1a67b' +
    'a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7' +
    '74408aa597253598cf23bc81eed6a3e6b9df74a8ef057dbe8747286c1c7e632e' +
    'cb75150d4d3435b913d1ac9c7bf24715'
) as WrappedSecret;

/** A content envelope bound to the location tuple below and to the wrap above. */
const CONTENT_ENVELOPE = hexToBytes(
  '02' +
    'c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7' +
    '0436f1feac144f95e46b89b9f072960ec1ecb6f9094557a31f03419e1bd2931c' +
    'f9f7df6751d42c5751ab7965e9feff2bf58e936179'
);
const CONTENT_LOCATION: ContentLocation = {
  conversationId: CONVERSATION_ID,
  messageId: MESSAGE_ID,
  contentItemId: CONTENT_ITEM_ID,
  position: POSITION,
  epochNumber: EPOCH_NUMBER,
  senderId: SENDER_ID,
};
/** Long enough to deflate smaller, so the vector carries the deflate codec flag. */
const CONTENT_TEXT =
  'Format vector envelope payload. Format vector envelope payload. Format vector envelope payload.';

/** A conversation title wrapped under `conversation-title.epoch`. */
const TITLE_BLOB = hexToBytes(
  '02' +
    'c15d2265459455c9ff156e6c1da6bfb7910bb8af50f2b2f9f853ea9325259d4d' +
    'd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7' +
    '29754b55f2f647add7ccfde67e98035fa5333df901226abe5cdd584624'
);
const TITLE_TEXT = 'Vector title';

/** Custom instructions wrapped under `custom-instructions.account`. */
const INSTRUCTIONS_BLOB = hexToBytes(
  '02' +
    '5c914f0f2835f62117ad4a3fe4e44319a61205f5b0461b41da5595f7bb48ef28' +
    'e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7' +
    'd9608f16a96536dbe1b86defb3074b96c7859cf804e764d295d0472a3fc29799fcf9'
);
const INSTRUCTIONS_TEXT = 'Answer concisely.';

/** A TOTP secret at rest: the key's fingerprint, then a seal under `totp-secret.server`. */
const TOTP_BLOB = hexToBytes(
  '0fb366019060b4ac' +
    '02' +
    '707172737475767778797a7b7c7d7e7f8081828384858687' +
    'c7785f2fd5cd1ad4b7ea139921f7beef28652cca0ac91034dbc0b861f17eabca'
);
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

/** The fingerprint of a fixed input under the KEK fingerprint label. */
const FINGERPRINT_INPUT = hexToBytes(
  'b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0'
);
const FINGERPRINT = hexToBytes('3aa7758bd623d57e');

/**
 * A user's OPAQUE server material at rest: the KEK's fingerprint, then a seal
 * under `opaque-server-material.kek` whose AAD binds the user id and that same
 * fingerprint, over `oprfSeed ‖ akePrivateKey ‖ akePublicKey`.
 */
const MATERIAL_KEK = hexToBytes('c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0');
const MATERIAL_OPRF_SEED = hexToBytes(
  'e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff00'
);
const MATERIAL_AKE_PRIVATE_KEY = hexToBytes(
  '7616c767b8d65741e9b9586e01e0d4085612c56014082c5d78fd817390a0346f'
);
const MATERIAL_AKE_PUBLIC_KEY = hexToBytes(
  '0237be24dfeead715e20453e1459d20eaa414c6fe47f2260699180e2cd41b536ba'
);
const MATERIAL_BLOB = hexToBytes(
  'd0b50efb25d7c4dd' +
    '02' +
    'a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7' +
    '083a8f1df6823d3a0772bcf0c8d93179dd7296974d997ee595b187d1a5435b60' +
    'aa68796a6825f88db68ab7ab41d5594a5143d7958800aaaae9dda75cddaa41f8' +
    'b232f68af4426b633fa8955b264c5886e433e1ca36b4cd6cdbb9942b0657a58b' +
    '55f140a5b4c481b047441db5999fb4816c'
);

/**
 * An epoch key wrapped to a member's account key under `epoch-key.member`,
 * bound to the conversation, the epoch number and the epoch public key, and
 * checked against that epoch's public key and confirmation on open.
 */
const MEMBER_PRIVATE_KEY = hexToBytes(
  'b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0'
);
const MEMBER_EPOCH_SECRET = hexToBytes(
  'd1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0'
);
const MEMBER_EPOCH_NUMBER = 5;
const MEMBER_EPOCH_PUBLIC_KEY = hexToBytes(
  '21c3332b61be6a7b6ab8461e155651b17501b6e07532ecf9ab6661bd5a2ca575'
);
const MEMBER_EPOCH_CONFIRMATION = hexToBytes(
  '68fe57efccec0c89721f7ba0f93c00530c1aaf64d708f65a159aadbe4dc9f072'
);
const MEMBER_WRAP = hexToBytes(
  '02' +
    '5869aff450549732cbaaed5e5df9b30a6da31cb0e5742bad5ad4a1a768f1a67b' +
    '404142434445464748494a4b4c4d4e4f5051525354555657' +
    'ec18e8d9977a2882de74c0a632861367a4d4b7c73a1662efad37bb5622b1ad23' +
    '4a5880203d4023c36fe6d7a7339ce5fc'
);

/**
 * An epoch key wrapped to the keypair a share link's secret derives, and
 * opened by re-deriving that keypair. An editor who repointed both `link.ts`
 * call sites at a different derive label, or pre-hashed the seed, would keep
 * every link round-trip green — both halves move together — while permanently
 * orphaning every link already sent to someone; only this vector fails. The
 * wrap carries `epoch-key.member` and the member location binding because a
 * link guest is read back as an ordinary member principal.
 */
const LINK_SECRET = hexToBytes('a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4');
const LINK_EPOCH_SECRET = hexToBytes(
  '6a6b6c6d6e6f707172737475767778797a7b7c7d7e7f80818283848586878889'
);
const LINK_EPOCH_NUMBER = 6;
const LINK_EPOCH_PUBLIC_KEY = hexToBytes(
  '89fd38a3549527ae6c19e9ceec2647dc107d5aefabe888b826aa1bb67d58242b'
);
const LINK_EPOCH_CONFIRMATION = hexToBytes(
  '02655165150beaf3921f8a4db1fd12d5fc54390c255b5b7afc90c6d4e6c30d75'
);
const LINK_WRAP = hexToBytes(
  '02' +
    '64b101b1d0be5a8704bd078f9895001fc03e8e9f9522f188dd128d9846d48466' +
    '303132333435363738393a3b3c3d3e3f4041424344454647' +
    'a23142dd89d83a1221e9f70e564731445c9a9a70a9903aaba96cb79d82ed8f3d' +
    'ccd97426d356e6642e5a50696f3ad864'
);

/**
 * The auth token `LINK_SECRET` derives, and its hash. The hash is stored on every
 * link row, so a changed derivation orphans every URL already sent. The token is
 * the diagnostic half: it staying green while the hash goes red says the hash step
 * moved, not the derivation.
 */
const LINK_AUTH_TOKEN = hexToBytes(
  '8824f6a50ba523764df4cb7a6a782b2f82774ba9136e589e6aec2d52184c5a9f'
);
const LINK_AUTH_HASH = hexToBytes(
  'dbbe7d51a18d02cfebb7d29ec21228c5275f3e143983ed9ebaaba0ffe4bf167a'
);

/**
 * The previous epoch key wrapped to the newer one under `epoch-key.chain-link`,
 * bound to the conversation, both epoch numbers and the older public key. The
 * two numbers are not adjacent, as a recovery's skip link is not, so a builder
 * that swapped them or derived one from the other fails here.
 */
const NEWER_EPOCH_PRIVATE_KEY = hexToBytes(
  '0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a'
);
const NEWER_EPOCH_NUMBER = 8;
const PREVIOUS_EPOCH_SECRET = hexToBytes(
  '5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a'
);
const PREVIOUS_EPOCH_NUMBER = 3;
const PREVIOUS_EPOCH_PUBLIC_KEY = hexToBytes(
  '7ec1365966f726fc171f9cabce9c6121e4f47691f1d745afb23c1ba6371d116f'
);
const PREVIOUS_EPOCH_CONFIRMATION = hexToBytes(
  'c35e5c506e8d112488b68357a5ee3cc5aa240d7a6ad3e33232d3db0d035a6370'
);
const CHAIN_LINK = hexToBytes(
  '02' +
    '244fe3b963e899dd295baffce248d3530f3a9a7479ba063002680ebfe7adad49' +
    '505152535455565758595a5b5c5d5e5f6061626364656667' +
    '2f1dd963d9d10863011013d87bd9f18f114699606fc775afd73b2f7e6c07e434' +
    'fa231c1617b792c2f0caa59b30490d86'
);

/** A reset-challenge nonce wrapped to a recovery key under `reset-challenge.recovery`. */
const RECOVERY_PRIVATE_KEY = hexToBytes(
  '2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c'
);
const RESET_NONCE = hexToBytes('9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbc');
const RESET_CHALLENGE = hexToBytes(
  '02' +
    '5b2316dc2b5c71366ef575388c844d3142aca905dbcbfa0399e12bc4925f5e31' +
    '606162636465666768696a6b6c6d6e6f7071727374757677' +
    'df22cd464841154c9dfe3b528d55b83580d6d47bf86a5cd47a48c1d77af5408e' +
    'ccd4a940963a4254a5de2b5777695ee3'
);

/** The same content key sealed to a share secret under `content-key.share`. */
const SHARE_SECRET = hexToBytes('3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e');
const SHARE_SEAL = hexToBytes(
  '02' +
    '909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7' +
    '35776a2041ee1e654a744982273fbe25aad87c408fc1c798cd67979f2eeb1530' +
    'd97662d131e439426fc5f1be4ab92d04'
) as SealedSecret;

/**
 * The account key wrapped under `account-key.password`. The recipient is the
 * keypair derived from the OPAQUE export key, so this vector also freezes the
 * `account-wrap-v1` derivation, not only the wrap.
 */
const OPAQUE_EXPORT_KEY = hexToBytes(
  '7778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f90919293949596'
);
const ACCOUNT_KEY_SECRET = hexToBytes(
  '4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c'
);
const PASSWORD_WRAPPED_ACCOUNT_KEY = hexToBytes(
  '02' +
    'f78a8a00e93f37413f2119e2ecc75e97b3f04347baa22c76a710d08938637e4e' +
    '808182838485868788898a8b8c8d8e8f9091929394959697' +
    '57ebd1dba4606f16c63ad6f1112684ef8eaed7e4cc710c7036a0cbca3fa6d65a' +
    '9c5e572a42ed921c343cac7e99dab007'
);

/** The same account key wrapped to a recovery keypair under `account-key.recovery`. */
const RECOVERY_WRAP_PRIVATE_KEY = hexToBytes(
  'c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2'
);
const RECOVERY_WRAPPED_ACCOUNT_KEY = hexToBytes(
  '02' +
    '550d58c5525185c41fea3705d517d9b7deb77141b822b85220a82e3f9b295d5c' +
    'b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7' +
    '8f30476798bc13f7fa8c9cc353c46d5547e06090129a18186b06a1a59f6b20dd' +
    'af2d3013a1a6e6c83cdbc1ee5388b7a4'
) as WrappedSecret;

/**
 * The same account key again, wrapped to the keypair this phrase derives and
 * opened through the domain function. An editor who repointed both
 * `createAccount` and `recoverAccountFromMnemonic` at a different label would
 * keep every round-trip and the vector above green while orphaning every
 * stored recovery blob; only this vector fails. It is also the one vector that
 * pays the phrase's real 64 MiB Argon2id derivation — about a quarter second,
 * and this file's dominant cost.
 */
const RECOVERY_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PHRASE_RECOVERY_WRAPPED_ACCOUNT_KEY = hexToBytes(
  '02' +
    '4d27bcee3135c4944b28d27dd809b07be10c35160d20131caa7e85575498d07c' +
    '08090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' +
    '76ac43158de8d488ce79a7463c7b4e53326b17c44412ef8e48e4f9a277dc0d04' +
    '793606571fd880a4e91c56bfd582b663'
);

/** The stored epoch confirmation for the epoch key, conversation and epoch above. */
const EPOCH_CONFIRMATION = hexToBytes(
  '14e3ca83bcb520ee96303776d6c977e0edbc62f9df592cbd898b25773eda07af'
);

const decoder = new TextDecoder();

describe('format vectors', () => {
  it('unwraps the frozen content-key wrap', () => {
    const contentKey = unwrapContentKeyFromEpoch(
      asEpochPrivateKey(EPOCH_PRIVATE_KEY),
      WRAPPED_CONTENT_KEY
    );

    expect(contentKey).toEqual(CONTENT_KEY);
  });

  it('decrypts the frozen content envelope at its location tuple', () => {
    const plaintext = decryptContentEnvelope(
      asContentKey(CONTENT_KEY),
      WRAPPED_CONTENT_KEY,
      CONTENT_LOCATION,
      CONTENT_ENVELOPE
    );

    expect(decoder.decode(plaintext)).toBe(CONTENT_TEXT);
  });

  it('decrypts the frozen conversation title at its conversation and epoch', () => {
    const title = decryptTextFromEpoch(EPOCH_PRIVATE_KEY, TITLE_BLOB, {
      conversationId: CONVERSATION_ID,
      epochNumber: EPOCH_NUMBER,
    });

    expect(title).toBe(TITLE_TEXT);
  });

  it('decrypts the frozen custom instructions for their account', () => {
    const instructions = decryptCustomInstructions(
      ACCOUNT_PRIVATE_KEY,
      INSTRUCTIONS_BLOB,
      INSTRUCTIONS_USER_ID
    );

    expect(instructions).toBe(INSTRUCTIONS_TEXT);
  });

  it('decrypts the frozen TOTP secret for its user', () => {
    const secret = decryptTotpSecret(
      deriveTotpEncryptionKey(TOTP_MASTER_SECRET),
      TOTP_USER_ID,
      TOTP_BLOB
    );

    expect(secret).toBe(TOTP_SECRET);
  });

  it('computes the frozen fingerprint for its input', () => {
    expect(fingerprintOf(FINGERPRINT_INPUT, DERIVE_LABELS.opaqueKekFingerprint)).toEqual(
      FINGERPRINT
    );
  });

  it('opens the frozen server material for its user', () => {
    const material = openServerMaterial(asOpaqueKek(MATERIAL_KEK), MATERIAL_USER_ID, MATERIAL_BLOB);

    expect(material).toEqual({
      oprfSeed: [...MATERIAL_OPRF_SEED],
      akeKeyPair: {
        private_key: [...MATERIAL_AKE_PRIVATE_KEY],
        public_key: [...MATERIAL_AKE_PUBLIC_KEY],
      },
    });
  });

  it('opens the frozen member epoch-key wrap at its epoch', () => {
    const opened = openEpochWrap(MEMBER_PRIVATE_KEY, MEMBER_WRAP, {
      conversationId: CONVERSATION_ID,
      epochNumber: MEMBER_EPOCH_NUMBER,
      epochPublicKey: MEMBER_EPOCH_PUBLIC_KEY,
      confirmationHash: MEMBER_EPOCH_CONFIRMATION,
    });

    expect(opened).toEqual({ ok: true, key: MEMBER_EPOCH_SECRET });
  });

  it('opens the frozen link wrap through the keypair its secret derives', () => {
    const linkKeyPair = deriveKeysFromLinkSecret(LINK_SECRET);

    const opened = openEpochWrap(linkKeyPair.privateKey, LINK_WRAP, {
      conversationId: CONVERSATION_ID,
      epochNumber: LINK_EPOCH_NUMBER,
      epochPublicKey: LINK_EPOCH_PUBLIC_KEY,
      confirmationHash: LINK_EPOCH_CONFIRMATION,
    });

    expect(opened).toEqual({ ok: true, key: LINK_EPOCH_SECRET });
  });

  it('derives the frozen link auth token from its secret', () => {
    expect(deriveLinkAuthToken(LINK_SECRET)).toEqual(LINK_AUTH_TOKEN);
  });

  it('hashes the frozen link auth token its secret derives', () => {
    expect(hashLinkAuthToken(deriveLinkAuthToken(LINK_SECRET))).toEqual(LINK_AUTH_HASH);
  });

  it('opens the frozen epoch chain link to its older epoch', () => {
    const opened = openChainLink(NEWER_EPOCH_PRIVATE_KEY, CHAIN_LINK, {
      conversationId: CONVERSATION_ID,
      newerEpochNumber: NEWER_EPOCH_NUMBER,
      older: {
        epochNumber: PREVIOUS_EPOCH_NUMBER,
        epochPublicKey: PREVIOUS_EPOCH_PUBLIC_KEY,
        confirmationHash: PREVIOUS_EPOCH_CONFIRMATION,
      },
    });

    expect(opened).toEqual({ ok: true, key: PREVIOUS_EPOCH_SECRET });
  });

  it('opens the frozen reset challenge', () => {
    const nonce = openResetChallenge(asWrappingPrivateKey(RECOVERY_PRIVATE_KEY), RESET_CHALLENGE);

    expect(nonce).toEqual(RESET_NONCE);
  });

  it('opens the frozen share seal', () => {
    const contentKey = openShare(asShareSecret(SHARE_SECRET), SHARE_SEAL);

    expect(contentKey).toEqual(CONTENT_KEY);
  });

  it('unwraps the frozen password-wrapped account key', () => {
    const accountKey = unwrapAccountKeyWithPassword(
      OPAQUE_EXPORT_KEY,
      PASSWORD_WRAPPED_ACCOUNT_KEY
    );

    expect(accountKey).toEqual(ACCOUNT_KEY_SECRET);
  });

  it('unwraps the frozen recovery-wrapped account key', () => {
    const accountKey = unwrapSecret(
      asWrappingPrivateKey(RECOVERY_WRAP_PRIVATE_KEY),
      RECOVERY_WRAPPED_ACCOUNT_KEY,
      WRAP_LABELS.accountKeyRecovery
    );

    expect(accountKey).toEqual(ACCOUNT_KEY_SECRET);
  });

  it('recovers the frozen account key from its recovery phrase', async () => {
    const recovered = await recoverAccountFromMnemonic(
      RECOVERY_MNEMONIC,
      PHRASE_RECOVERY_WRAPPED_ACCOUNT_KEY
    );

    expect(recovered.accountPrivateKey).toEqual(ACCOUNT_KEY_SECRET);
  });

  it('computes the frozen epoch confirmation for its conversation and epoch', () => {
    const confirmation = computeEpochConfirmation(
      asEpochPrivateKey(EPOCH_PRIVATE_KEY),
      CONVERSATION_ID,
      EPOCH_NUMBER
    );

    expect(confirmation).toEqual(EPOCH_CONFIRMATION);
  });
});
