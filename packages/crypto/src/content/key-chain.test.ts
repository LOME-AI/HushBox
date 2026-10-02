import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { toBase64 } from '@hushbox/shared';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { at } from '@hushbox/shared/test-utilities';
import { verifyKeyChain } from './key-chain.js';
import { createFirstEpoch, epochWrapAad, performEpochRotation } from './epoch-lifecycle.js';
import { computeEpochConfirmation } from './epoch.js';
import {
  KEY_BYTES,
  asAccountPublicKey,
  asEpochPrivateKey,
  generateKeyPair,
} from '../primitives/keys.js';
import { BLOB_FORMAT_VERSION } from '../primitives/format.js';
import { wrapSecretTo } from '../wrap/wrap.js';
import { WRAP_LABELS } from '../wrap/labels.js';
import type { KeyChainEpoch, KeyChainResponse, KeyChainWrap } from '@hushbox/shared';
import type { KeyPair } from '../primitives/keys.js';

/*
 * A hostile member builds its rotations with its own encoder, which neither
 * refuses an all-zero key nor draws its keys at random. This package's encoder
 * does both, so a hostile build runs it with the zero-key refusal lifted and,
 * when asked, the generated epoch key fixed. Rebuilding the encoder here instead
 * would be a second implementation of the wrap. Verification always runs with
 * both restored.
 */
const hostileEncoder = vi.hoisted((): { active: boolean; epochKey: Uint8Array | undefined } => ({
  active: false,
  epochKey: undefined,
}));

vi.mock('../primitives/keys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../primitives/keys.js')>();
  return {
    ...actual,
    generateKeyPair: (): KeyPair => {
      const key = hostileEncoder.epochKey;
      if (key === undefined) return actual.generateKeyPair();
      return { privateKey: key, publicKey: actual.getPublicKeyFromPrivate(key) };
    },
    assertNotZeroed: (role: string, bytes: Uint8Array): void => {
      if (!hostileEncoder.active) actual.assertNotZeroed(role, bytes);
    },
  };
});

function buildHostile<T>(build: () => T, epochKey?: Uint8Array): T {
  const enclosing = { ...hostileEncoder };
  hostileEncoder.active = true;
  hostileEncoder.epochKey = epochKey;
  try {
    return build();
  } finally {
    Object.assign(hostileEncoder, enclosing);
  }
}

const CONVERSATION_ID = testUuidV7(7);
const ZERO_KEY = new Uint8Array(KEY_BYTES);

interface BuiltEpoch {
  epochNumber: number;
  epochPrivateKey: Uint8Array;
  epochPublicKey: Uint8Array;
  confirmationHash: Uint8Array;
  wrap: Uint8Array;
  chainLink: Uint8Array | null;
  previousEpochNumber: number | null;
}

/** An honest first epoch seating the principal. */
function first(principal: KeyPair, epochNumber: number): BuiltEpoch {
  const epoch = createFirstEpoch([principal.publicKey], CONVERSATION_ID, epochNumber);
  return {
    epochNumber,
    epochPrivateKey: epoch.epochPrivateKey,
    epochPublicKey: epoch.epochPublicKey,
    confirmationHash: epoch.confirmationHash,
    wrap: at(epoch.memberWraps, 0).wrap,
    chainLink: null,
    previousEpochNumber: null,
  };
}

/** An honest rotation from `predecessor`, seating the principal. */
function rotateFrom(predecessor: BuiltEpoch, principal: KeyPair, epochNumber: number): BuiltEpoch {
  const epoch = performEpochRotation({
    predecessor: {
      epochNumber: predecessor.epochNumber,
      privateKey: predecessor.epochPrivateKey,
      publicKey: predecessor.epochPublicKey,
    },
    memberPublicKeys: [principal.publicKey],
    conversationId: CONVERSATION_ID,
    epochNumber,
  });
  return {
    epochNumber,
    epochPrivateKey: epoch.epochPrivateKey,
    epochPublicKey: epoch.epochPublicKey,
    confirmationHash: epoch.confirmationHash,
    wrap: at(epoch.memberWraps, 0).wrap,
    chainLink: epoch.chainLink,
    previousEpochNumber: predecessor.epochNumber,
  };
}

function recordOf(epoch: BuiltEpoch): KeyChainEpoch {
  return {
    epochNumber: epoch.epochNumber,
    epochPublicKey: toBase64(epoch.epochPublicKey),
    confirmationHash: toBase64(epoch.confirmationHash),
    previousEpochNumber: epoch.previousEpochNumber,
    chainLink: epoch.chainLink === null ? null : toBase64(epoch.chainLink),
  };
}

function wrapOf(epoch: BuiltEpoch): KeyChainWrap {
  return { epochNumber: epoch.epochNumber, wrap: toBase64(epoch.wrap) };
}

function chainOf(
  records: KeyChainEpoch[],
  wraps: KeyChainWrap[],
  currentEpoch: number
): KeyChainResponse {
  return { epochs: records, wraps, currentEpoch, rotationPending: false };
}

function junk(): string {
  return toBase64(randomBytes(89));
}

describe('verifyKeyChain', () => {
  it('verifies an epoch through a direct wrap', () => {
    const principal = generateKeyPair();
    const epoch1 = first(principal, 1);

    const verdict = verifyKeyChain(
      chainOf([recordOf(epoch1)], [wrapOf(epoch1)], 1),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.epochs.get(1)).toEqual({ key: { status: 'ok' }, link: 'absent' });
    expect(verdict.keys.get(1)).toEqual(epoch1.epochPrivateKey);
    expect(verdict.rotation).toBe('ok');
    expect(verdict.lastGoodEpoch).toBe(1);
  });

  it('verifies an epoch reached only through a chain link', () => {
    const principal = generateKeyPair();
    const epoch1 = first(principal, 1);
    const epoch2 = rotateFrom(epoch1, principal, 2);

    const verdict = verifyKeyChain(
      chainOf([recordOf(epoch1), recordOf(epoch2)], [wrapOf(epoch2)], 2),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.epochs.get(1)).toEqual({ key: { status: 'ok' }, link: 'absent' });
    expect(verdict.epochs.get(2)).toEqual({ key: { status: 'ok' }, link: 'ok' });
    expect(verdict.keys.get(1)).toEqual(epoch1.epochPrivateKey);
    expect(verdict.lastGoodEpoch).toBe(2);
  });

  it('reports unwrap-failed for a wrap of random bytes', () => {
    const principal = generateKeyPair();
    const epoch1 = first(principal, 1);

    const verdict = verifyKeyChain(
      chainOf([recordOf(epoch1)], [{ epochNumber: 1, wrap: junk() }], 1),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.epochs.get(1)?.key).toEqual({ status: 'bad', reason: 'unwrap-failed' });
    expect(verdict.keys.has(1)).toBe(false);
    expect(verdict.rotation).toBe('bad');
  });

  it('reports public-key-mismatch for a key sealed under a foreign public key', () => {
    const principal = generateKeyPair();
    const honest = first(principal, 1);
    const foreign = generateKeyPair();
    // A self-consistent confirmation for the foreign key, published beside the
    // honest public key: every check but the public-key one passes.
    const hostileRecord: KeyChainEpoch = {
      ...recordOf(honest),
      confirmationHash: toBase64(
        computeEpochConfirmation(asEpochPrivateKey(foreign.privateKey), CONVERSATION_ID, 1)
      ),
    };
    const hostileWrap = wrapSecretTo(
      asAccountPublicKey(principal.publicKey),
      foreign.privateKey,
      WRAP_LABELS.epochKeyMember,
      epochWrapAad({
        conversationId: CONVERSATION_ID,
        epochNumber: 1,
        epochPublicKey: honest.epochPublicKey,
      })
    );

    const verdict = verifyKeyChain(
      chainOf([hostileRecord], [{ epochNumber: 1, wrap: toBase64(hostileWrap) }], 1),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.epochs.get(1)?.key).toEqual({ status: 'bad', reason: 'public-key-mismatch' });
    expect(verdict.keys.has(1)).toBe(false);
    expect(verdict.rotation).toBe('bad');
  });

  it('reports confirmation-mismatch for a confirmation the key does not produce', () => {
    const principal = generateKeyPair();
    const epoch1 = first(principal, 1);

    const verdict = verifyKeyChain(
      chainOf(
        [{ ...recordOf(epoch1), confirmationHash: toBase64(randomBytes(32)) }],
        [wrapOf(epoch1)],
        1
      ),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.epochs.get(1)?.key).toEqual({ status: 'bad', reason: 'confirmation-mismatch' });
    expect(verdict.keys.has(1)).toBe(false);
  });

  it('keeps the key of an epoch whose own chain link is junk', () => {
    const principal = generateKeyPair();
    const epoch1 = first(principal, 1);
    const epoch2 = rotateFrom(epoch1, principal, 2);

    const verdict = verifyKeyChain(
      chainOf(
        [recordOf(epoch1), { ...recordOf(epoch2), chainLink: junk() }],
        [wrapOf(epoch1), wrapOf(epoch2)],
        2
      ),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.epochs.get(2)).toEqual({ key: { status: 'ok' }, link: 'bad' });
    expect(verdict.keys.get(2)).toEqual(epoch2.epochPrivateKey);
  });

  it('reports the rotation bad when the current epoch carries a junk link', () => {
    const principal = generateKeyPair();
    const epoch1 = first(principal, 1);
    const epoch2 = rotateFrom(epoch1, principal, 2);

    const verdict = verifyKeyChain(
      chainOf(
        [recordOf(epoch1), { ...recordOf(epoch2), chainLink: junk() }],
        [wrapOf(epoch1), wrapOf(epoch2)],
        2
      ),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.rotation).toBe('bad');
    expect(verdict.lastGoodEpoch).toBe(1);
  });

  it('reports the rotation bad when a link below the current epoch is junk', () => {
    const principal = generateKeyPair();
    const epoch1 = first(principal, 1);
    const epoch2 = rotateFrom(epoch1, principal, 2);
    const epoch3 = rotateFrom(epoch2, principal, 3);

    const verdict = verifyKeyChain(
      chainOf(
        [recordOf(epoch1), { ...recordOf(epoch2), chainLink: junk() }, recordOf(epoch3)],
        [wrapOf(epoch1), wrapOf(epoch2), wrapOf(epoch3)],
        3
      ),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.epochs.get(3)?.link).toBe('ok');
    expect(verdict.rotation).toBe('bad');
    expect(verdict.lastGoodEpoch).toBe(1);
  });

  it('reports unreachable for an epoch with no wrap and no verified path', () => {
    const principal = generateKeyPair();
    const epoch1 = first(principal, 1);
    const epoch2 = rotateFrom(epoch1, generateKeyPair(), 2);

    const verdict = verifyKeyChain(
      chainOf([recordOf(epoch1), recordOf(epoch2)], [wrapOf(epoch1)], 2),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.epochs.get(2)).toEqual({ key: { status: 'unreachable' }, link: 'unopened' });
    expect(verdict.keys.has(2)).toBe(false);
    expect(verdict.rotation).toBe('ok');
    expect(verdict.lastGoodEpoch).toBe(1);
  });

  it('follows a skip link to a predecessor below the epoch just under it', () => {
    const principal = generateKeyPair();
    const good = first(principal, 2);
    const hostile: BuiltEpoch = { ...rotateFrom(good, principal, 3), chainLink: randomBytes(89) };
    const recovery = rotateFrom(good, principal, 4);

    const verdict = verifyKeyChain(
      chainOf([recordOf(good), recordOf(hostile), recordOf(recovery)], [wrapOf(recovery)], 4),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.epochs.get(4)).toEqual({ key: { status: 'ok' }, link: 'ok' });
    expect(verdict.epochs.get(2)?.key).toEqual({ status: 'ok' });
    expect(verdict.keys.get(2)).toEqual(good.epochPrivateKey);
    expect(verdict.epochs.get(3)).toEqual({ key: { status: 'unreachable' }, link: 'unopened' });
    expect(verdict.rotation).toBe('ok');
    expect(verdict.lastGoodEpoch).toBe(4);
  });

  it('names the last good epoch below a bad current epoch', () => {
    const principal = generateKeyPair();
    const epoch1 = first(principal, 1);
    const epoch2 = rotateFrom(epoch1, principal, 2);
    const epoch3 = rotateFrom(epoch2, principal, 3);

    const verdict = verifyKeyChain(
      chainOf(
        [recordOf(epoch1), recordOf(epoch2), recordOf(epoch3)],
        [wrapOf(epoch1), wrapOf(epoch2), { epochNumber: 3, wrap: junk() }],
        3
      ),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.epochs.get(3)?.key).toEqual({ status: 'bad', reason: 'unwrap-failed' });
    expect(verdict.rotation).toBe('bad');
    expect(verdict.lastGoodEpoch).toBe(2);
  });

  it('names no last good epoch when no epoch verifies', () => {
    const principal = generateKeyPair();
    const epoch1 = first(principal, 1);

    const verdict = verifyKeyChain(
      chainOf([recordOf(epoch1)], [{ epochNumber: 1, wrap: junk() }], 1),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.lastGoodEpoch).toBeNull();
  });

  it('treats a link whose predecessor was withheld below the floor as absent', () => {
    const principal = generateKeyPair();
    const epoch1 = first(generateKeyPair(), 1);
    const epoch2 = rotateFrom(epoch1, principal, 2);

    const verdict = verifyKeyChain(
      chainOf([{ ...recordOf(epoch2), chainLink: null }], [wrapOf(epoch2)], 2),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.epochs.get(2)).toEqual({ key: { status: 'ok' }, link: 'absent' });
    expect(verdict.rotation).toBe('ok');
    expect(verdict.lastGoodEpoch).toBe(2);
  });

  it('reports a link bad when its predecessor record is missing', () => {
    const principal = generateKeyPair();
    const epoch1 = first(principal, 1);
    const epoch2 = rotateFrom(epoch1, principal, 2);

    const verdict = verifyKeyChain(
      chainOf([recordOf(epoch2)], [wrapOf(epoch2)], 2),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.epochs.get(2)).toEqual({ key: { status: 'ok' }, link: 'bad' });
    expect(verdict.rotation).toBe('bad');
  });

  it('refuses a wrap whose base64 does not decode', () => {
    const principal = generateKeyPair();
    const epoch1 = first(principal, 1);

    const verdict = verifyKeyChain(
      chainOf([recordOf(epoch1)], [{ epochNumber: 1, wrap: '!' }], 1),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.epochs.get(1)?.key).toEqual({ status: 'bad', reason: 'unwrap-failed' });
  });

  it('trusts a key from any one wrap that verifies', () => {
    const principal = generateKeyPair();
    const epoch1 = first(principal, 1);

    const verdict = verifyKeyChain(
      chainOf([recordOf(epoch1)], [{ epochNumber: 1, wrap: junk() }, wrapOf(epoch1)], 1),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.epochs.get(1)?.key).toEqual({ status: 'ok' });
  });

  it('gives no verdict for a wrap whose epoch has no record', () => {
    const principal = generateKeyPair();
    const epoch1 = first(principal, 1);
    const epoch2 = rotateFrom(epoch1, principal, 2);

    const verdict = verifyKeyChain(
      chainOf([recordOf(epoch1)], [wrapOf(epoch1), wrapOf(epoch2)], 1),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.epochs.has(2)).toBe(false);
    expect(verdict.keys.has(2)).toBe(false);
  });

  it('reports the rotation ok when the current epoch has no record', () => {
    const principal = generateKeyPair();
    const epoch1 = first(principal, 1);

    const verdict = verifyKeyChain(
      chainOf([recordOf(epoch1)], [wrapOf(epoch1)], 2),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.rotation).toBe('ok');
    expect(verdict.lastGoodEpoch).toBe(1);
  });

  it('keeps an epoch key a verified link yields when its own direct wrap is junk', () => {
    const principal = generateKeyPair();
    const epoch1 = first(principal, 1);
    const epoch2 = rotateFrom(epoch1, principal, 2);

    const verdict = verifyKeyChain(
      chainOf(
        [recordOf(epoch1), recordOf(epoch2)],
        [{ epochNumber: 1, wrap: junk() }, wrapOf(epoch2)],
        2
      ),
      principal.privateKey,
      CONVERSATION_ID
    );

    expect(verdict.epochs.get(1)?.key).toEqual({ status: 'ok' });
    expect(verdict.keys.get(1)).toEqual(epoch1.epochPrivateKey);
  });

  describe('hostile key material', () => {
    it('refuses an all-zero key a rotation carrying a chain link seals to the principal', () => {
      const principal = generateKeyPair();
      const epoch1 = first(principal, 1);
      const hostile = buildHostile(() => rotateFrom(epoch1, principal, 2), ZERO_KEY);

      const verdict = verifyKeyChain(
        chainOf([recordOf(epoch1), recordOf(hostile)], [wrapOf(epoch1), wrapOf(hostile)], 2),
        principal.privateKey,
        CONVERSATION_ID
      );

      expect(verdict.epochs.get(2)?.key).toEqual({ status: 'bad', reason: 'invalid-key' });
      expect(verdict.keys.has(2)).toBe(false);
      expect(verdict.rotation).toBe('bad');
      expect(verdict.lastGoodEpoch).toBe(1);
    });

    it('refuses an all-zero key a rotation without a chain link seals to the principal', () => {
      const principal = generateKeyPair();
      const epoch1 = first(principal, 1);
      const hostile: BuiltEpoch = {
        ...buildHostile(() => rotateFrom(epoch1, principal, 2), ZERO_KEY),
        chainLink: null,
        previousEpochNumber: null,
      };

      const verdict = verifyKeyChain(
        chainOf([recordOf(epoch1), recordOf(hostile)], [wrapOf(epoch1), wrapOf(hostile)], 2),
        principal.privateKey,
        CONVERSATION_ID
      );

      expect(verdict.epochs.get(2)).toEqual({
        key: { status: 'bad', reason: 'invalid-key' },
        link: 'absent',
      });
      expect(verdict.keys.has(2)).toBe(false);
      expect(verdict.rotation).toBe('bad');
      expect(verdict.lastGoodEpoch).toBe(1);
    });

    it('refuses an all-zero key a chain link opens to', () => {
      const principal = generateKeyPair();
      const zeroEpoch = buildHostile(() => first(principal, 1), ZERO_KEY);
      const epoch2 = buildHostile(() => rotateFrom(zeroEpoch, principal, 2));

      const verdict = verifyKeyChain(
        chainOf([recordOf(zeroEpoch), recordOf(epoch2)], [wrapOf(epoch2)], 2),
        principal.privateKey,
        CONVERSATION_ID
      );

      expect(verdict.epochs.get(2)).toEqual({ key: { status: 'ok' }, link: 'bad' });
      expect(verdict.epochs.get(1)?.key).toEqual({ status: 'unreachable' });
      expect(verdict.keys.has(1)).toBe(false);
      expect(verdict.rotation).toBe('bad');
    });

    it('refuses a key of the wrong length as invalid', () => {
      const principal = generateKeyPair();
      const epoch1 = first(principal, 1);
      const shortKey = buildHostile(() =>
        wrapSecretTo(
          asAccountPublicKey(principal.publicKey),
          randomBytes(KEY_BYTES - 1),
          WRAP_LABELS.epochKeyMember,
          epochWrapAad({
            conversationId: CONVERSATION_ID,
            epochNumber: 1,
            epochPublicKey: epoch1.epochPublicKey,
          })
        )
      );

      const verdict = verifyKeyChain(
        chainOf([recordOf(epoch1)], [{ epochNumber: 1, wrap: toBase64(shortKey) }], 1),
        principal.privateKey,
        CONVERSATION_ID
      );

      expect(verdict.epochs.get(1)?.key).toEqual({ status: 'bad', reason: 'invalid-key' });
    });

    const RANDOM_LENGTHS = [0, 1, 56, 57, 89, 1024];

    /** Random bytes that pass the version check, so they reach the blob's parsing. */
    function randomBlob(length: number): string {
      const bytes = randomBytes(length);
      if (length > 0) bytes[0] = BLOB_FORMAT_VERSION;
      return toBase64(bytes);
    }

    it.each(RANDOM_LENGTHS)('judges a wrap of %i random bytes without throwing', (length) => {
      const principal = generateKeyPair();
      const epoch1 = first(principal, 1);

      const verdict = verifyKeyChain(
        chainOf([recordOf(epoch1)], [{ epochNumber: 1, wrap: randomBlob(length) }], 1),
        principal.privateKey,
        CONVERSATION_ID
      );

      expect(verdict.epochs.get(1)?.key).toEqual({ status: 'bad', reason: 'unwrap-failed' });
    });

    it.each(RANDOM_LENGTHS)('judges a link of %i random bytes without throwing', (length) => {
      const principal = generateKeyPair();
      const epoch1 = first(principal, 1);
      const epoch2 = rotateFrom(epoch1, principal, 2);

      const verdict = verifyKeyChain(
        chainOf(
          [recordOf(epoch1), { ...recordOf(epoch2), chainLink: randomBlob(length) }],
          [wrapOf(epoch2)],
          2
        ),
        principal.privateKey,
        CONVERSATION_ID
      );

      expect(verdict.epochs.get(2)).toEqual({ key: { status: 'ok' }, link: 'bad' });
    });

    it.each([0.5, -1, 2 ** 53, Number.POSITIVE_INFINITY, Number.NaN])(
      'judges an epoch served under the number %d, which has no encoding, without throwing',
      (epochNumber) => {
        const principal = generateKeyPair();
        const epoch1 = first(principal, 1);

        const verdict = verifyKeyChain(
          chainOf(
            [recordOf(epoch1), { ...recordOf(epoch1), epochNumber }],
            [wrapOf(epoch1), { ...wrapOf(epoch1), epochNumber }],
            1
          ),
          principal.privateKey,
          CONVERSATION_ID
        );

        expect(verdict.epochs.get(epochNumber)?.key).toEqual({
          status: 'bad',
          reason: 'unwrap-failed',
        });
        expect(verdict.lastGoodEpoch).toBe(1);
      }
    );

    it('terminates on predecessor numbers that do not compare', () => {
      const principal = generateKeyPair();
      const epoch1 = first(principal, 1);
      const epoch2 = rotateFrom(epoch1, principal, 2);

      const verdict = verifyKeyChain(
        chainOf(
          [
            { ...recordOf(epoch1), previousEpochNumber: Number.NaN, chainLink: junk() },
            { ...recordOf(epoch2), epochNumber: Number.NaN, previousEpochNumber: 1 },
          ],
          [],
          1
        ),
        principal.privateKey,
        CONVERSATION_ID
      );

      expect(verdict.epochs.get(1)?.link).toBe('bad');
      expect(verdict.rotation).toBe('bad');
    });
  });

  describe('malformed chains', () => {
    it('reports a link bad when its predecessor number is its own', () => {
      const principal = generateKeyPair();
      const epoch1 = first(principal, 1);
      const epoch2 = rotateFrom(epoch1, principal, 2);

      const verdict = verifyKeyChain(
        chainOf(
          [recordOf(epoch1), { ...recordOf(epoch2), previousEpochNumber: 2 }],
          [wrapOf(epoch2)],
          2
        ),
        principal.privateKey,
        CONVERSATION_ID
      );

      expect(verdict.epochs.get(2)?.link).toBe('bad');
      expect(verdict.epochs.get(1)?.key).toEqual({ status: 'unreachable' });
      expect(verdict.keys.has(1)).toBe(false);
      expect(verdict.rotation).toBe('bad');
    });

    it('reports a link bad when its predecessor number is above its own', () => {
      const principal = generateKeyPair();
      const epoch1 = first(principal, 1);
      const epoch2 = rotateFrom(epoch1, principal, 2);
      const epoch3 = rotateFrom(epoch2, principal, 3);

      const verdict = verifyKeyChain(
        chainOf(
          [recordOf(epoch1), { ...recordOf(epoch2), previousEpochNumber: 3 }, recordOf(epoch3)],
          [wrapOf(epoch2)],
          3
        ),
        principal.privateKey,
        CONVERSATION_ID
      );

      expect(verdict.epochs.get(2)?.link).toBe('bad');
      expect(verdict.epochs.get(1)?.key).toEqual({ status: 'unreachable' });
    });

    it('terminates on a cycle of predecessor numbers', () => {
      const principal = generateKeyPair();
      const epoch1 = first(principal, 1);
      const epoch2 = rotateFrom(epoch1, principal, 2);
      const epoch3 = rotateFrom(epoch2, principal, 3);

      const verdict = verifyKeyChain(
        chainOf(
          [{ ...recordOf(epoch2), previousEpochNumber: 3 }, recordOf(epoch3)],
          [wrapOf(epoch3)],
          3
        ),
        principal.privateKey,
        CONVERSATION_ID
      );

      expect(verdict.epochs.get(3)).toEqual({ key: { status: 'ok' }, link: 'ok' });
      expect(verdict.epochs.get(2)?.link).toBe('bad');
      expect(verdict.rotation).toBe('bad');
    });

    it('trusts no key reached through an epoch number served twice', () => {
      const principal = generateKeyPair();
      const epoch1 = first(principal, 1);
      const epoch2 = rotateFrom(epoch1, principal, 2);
      const impostor = rotateFrom(epoch1, generateKeyPair(), 2);

      const verdict = verifyKeyChain(
        chainOf([recordOf(epoch1), recordOf(epoch2), recordOf(impostor)], [wrapOf(epoch2)], 2),
        principal.privateKey,
        CONVERSATION_ID
      );

      expect(verdict.epochs.get(2)?.link).toBe('bad');
      expect(verdict.keys.has(2)).toBe(false);
      expect(verdict.epochs.get(1)?.key).toEqual({ status: 'unreachable' });
      expect(verdict.keys.has(1)).toBe(false);
      expect(verdict.rotation).toBe('bad');
    });

    it('reports a link bad when it leads into an epoch number served twice', () => {
      const principal = generateKeyPair();
      const epoch1 = first(principal, 1);
      const epoch2 = rotateFrom(epoch1, principal, 2);
      const impostor = first(generateKeyPair(), 1);

      const verdict = verifyKeyChain(
        chainOf([recordOf(epoch1), recordOf(impostor), recordOf(epoch2)], [wrapOf(epoch2)], 2),
        principal.privateKey,
        CONVERSATION_ID
      );

      expect(verdict.epochs.get(2)).toEqual({ key: { status: 'ok' }, link: 'bad' });
      expect(verdict.epochs.get(1)?.key).toEqual({ status: 'unreachable' });
    });

    it('reports a link bad when its record names no predecessor', () => {
      const principal = generateKeyPair();
      const epoch1 = first(principal, 1);
      const epoch2 = rotateFrom(epoch1, principal, 2);

      const verdict = verifyKeyChain(
        chainOf(
          [recordOf(epoch1), { ...recordOf(epoch2), previousEpochNumber: null }],
          [wrapOf(epoch2)],
          2
        ),
        principal.privateKey,
        CONVERSATION_ID
      );

      expect(verdict.epochs.get(2)).toEqual({ key: { status: 'ok' }, link: 'bad' });
      expect(verdict.epochs.get(1)?.key).toEqual({ status: 'unreachable' });
      expect(verdict.rotation).toBe('bad');
    });
  });
});
