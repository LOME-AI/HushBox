/**
 * Recovery restores a verifiable chain: after a hostile member's rotations and
 * an honest member's recovery from its last good epoch, the honest member's
 * whole reachable path verifies, every hostile epoch is still reported, and
 * every direct wrap it was given honestly still opens.
 *
 * The generator is `operationsArb`: a random sequence of honest rotations,
 * hostile rotations (each drawing one way to be hostile, an all-zero epoch key
 * among them) and recoveries from the last good epoch. The model plays the
 * server — it keeps every wrap of a live seat, as the store does — and the
 * honest member acts only on what `verifyKeyChain` tells it: it rotates only
 * from a verified current key and recovers only when the rotation verdict is
 * bad.
 *
 * Verification is total: for any keychain `hostileKeyChainArb` generates it
 * returns a verdict rather than throwing. That generator serves epoch numbers
 * with and without an encoding, records committing to keys of any length (all
 * zero included) or to arbitrary bytes, and wraps and links that are either
 * arbitrary bytes or sealed around such a key — so the checks after an open
 * are reached, not only the open.
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { fromBase64, toBase64 } from '@hushbox/shared';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { at } from '@hushbox/shared/test-utilities';
import { verifyKeyChain } from './key-chain.js';
import {
  createFirstEpoch,
  epochWrapAad,
  openEpochWrap,
  performEpochRotation,
} from './epoch-lifecycle.js';
import { computeEpochConfirmation } from './epoch.js';
import {
  KEY_BYTES,
  asAccountPublicKey,
  asEpochPrivateKey,
  getPublicKeyFromPrivate,
} from '../primitives/keys.js';
import { wrapSecretTo } from '../wrap/wrap.js';
import { WRAP_LABELS } from '../wrap/labels.js';
import type { KeyChainEpoch, KeyChainResponse, KeyChainWrap } from '@hushbox/shared';
import type { KeyChainVerdict } from './key-chain.js';
import type { KeyPair } from '../primitives/keys.js';

/*
 * A hostile member builds with its own encoder, which neither refuses an
 * all-zero key nor draws its keys at random. This package's encoder does both,
 * so a hostile build runs it with the zero-key refusal lifted and, when asked,
 * the generated epoch key fixed. Rebuilding the encoder here instead would be a
 * second implementation of the wrap. Verification always runs with both
 * restored.
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

const CONVERSATION_ID = testUuidV7(8);
const ZERO_KEY = new Uint8Array(KEY_BYTES);
// Every step pays several curve operations per epoch in the chain, so this
// property is dear and states a smaller count than the repository default.
const RUNS = 60;
const MAX_OPERATIONS = 7;
// Sealing a served epoch and verifying the chain pay curve operations per
// epoch, so the fuzz is dear too and states its own count.
const FUZZ_RUNS = 500;
const JUNK_BYTES = 89;

type HostileVariant = 'junk-wrap' | 'foreign-key' | 'junk-link' | 'spliced-link' | 'zero-key';

type Operation =
  | { readonly kind: 'honest' }
  | {
      readonly kind: 'hostile';
      readonly variant: HostileVariant;
      readonly junk: Uint8Array;
      readonly foreignKey: Uint8Array;
    }
  | { readonly kind: 'recover' };

interface ModelEpoch {
  readonly record: KeyChainEpoch;
  readonly hostile: boolean;
  /** The true private key, as its builder holds it. */
  readonly privateKey: Uint8Array;
}

interface Model {
  readonly honestKey: Uint8Array;
  readonly epochs: ModelEpoch[];
  readonly wraps: KeyChainWrap[];
  current: number;
}

const keyBytesArb = fc.uint8Array({ minLength: KEY_BYTES, maxLength: KEY_BYTES });

// Only the honest principal's key excludes all-zero bytes: the openers refuse a
// zeroed caller key by throwing, which is the caller's defect. Every key the
// hostile side supplies is drawn unfiltered.
const privateKeyArb = keyBytesArb.filter((bytes) => bytes.some((byte) => byte !== 0));

const operationArb: fc.Arbitrary<Operation> = fc.oneof(
  fc.constant({ kind: 'honest' } as const),
  fc.record({
    kind: fc.constant('hostile' as const),
    variant: fc.constantFrom<HostileVariant>(
      'junk-wrap',
      'foreign-key',
      'junk-link',
      'spliced-link',
      'zero-key'
    ),
    junk: fc.uint8Array({ minLength: JUNK_BYTES, maxLength: JUNK_BYTES }),
    foreignKey: keyBytesArb,
  }),
  fc.constant({ kind: 'recover' } as const)
);

const operationsArb = fc.array(operationArb, { minLength: 1, maxLength: MAX_OPERATIONS });

function chainOf(model: Model): KeyChainResponse {
  return {
    epochs: model.epochs.map((epoch) => epoch.record),
    wraps: model.wraps,
    currentEpoch: model.current,
    rotationPending: false,
  };
}

function verify(model: Model): KeyChainVerdict {
  return verifyKeyChain(chainOf(model), model.honestKey, CONVERSATION_ID);
}

function modelEpoch(model: Model, epochNumber: number): ModelEpoch {
  const found = model.epochs.find((epoch) => epoch.record.epochNumber === epochNumber);
  if (found === undefined) throw new Error(`No epoch ${String(epochNumber)} in the model`);
  return found;
}

function startModel(honestKey: Uint8Array): Model {
  const epoch = createFirstEpoch([getPublicKeyFromPrivate(honestKey)], CONVERSATION_ID, 1);
  return {
    honestKey,
    epochs: [
      {
        record: {
          epochNumber: 1,
          epochPublicKey: toBase64(epoch.epochPublicKey),
          confirmationHash: toBase64(epoch.confirmationHash),
          previousEpochNumber: null,
          chainLink: null,
        },
        hostile: false,
        privateKey: epoch.epochPrivateKey,
      },
    ],
    wraps: [{ epochNumber: 1, wrap: toBase64(at(epoch.memberWraps, 0).wrap) }],
    current: 1,
  };
}

function appendRotation(
  model: Model,
  predecessor: { epochNumber: number; privateKey: Uint8Array },
  shape: (built: {
    epochNumber: number;
    record: KeyChainEpoch;
    wrap: Uint8Array;
    epochPrivateKey: Uint8Array;
  }) => { record: KeyChainEpoch; wrap: Uint8Array },
  hostile: boolean
): void {
  const epochNumber = model.current + 1;
  const rotation = performEpochRotation({
    predecessor: {
      epochNumber: predecessor.epochNumber,
      privateKey: predecessor.privateKey,
      publicKey: getPublicKeyFromPrivate(predecessor.privateKey),
    },
    memberPublicKeys: [getPublicKeyFromPrivate(model.honestKey)],
    conversationId: CONVERSATION_ID,
    epochNumber,
  });
  const shaped = shape({
    epochNumber,
    record: {
      epochNumber,
      epochPublicKey: toBase64(rotation.epochPublicKey),
      confirmationHash: toBase64(rotation.confirmationHash),
      previousEpochNumber: predecessor.epochNumber,
      chainLink: toBase64(rotation.chainLink),
    },
    wrap: at(rotation.memberWraps, 0).wrap,
    epochPrivateKey: rotation.epochPrivateKey,
  });
  model.epochs.push({ record: shaped.record, hostile, privateKey: rotation.epochPrivateKey });
  model.wraps.push({ epochNumber, wrap: toBase64(shaped.wrap) });
  model.current = epochNumber;
}

function honestRotate(model: Model): void {
  const verdict = verify(model);
  const currentKey = verdict.keys.get(model.current);
  if (verdict.rotation === 'bad' || currentKey === undefined) return;
  appendRotation(
    model,
    { epochNumber: model.current, privateKey: currentKey },
    (built) => built,
    false
  );
}

function hostileRotate(model: Model, operation: Extract<Operation, { kind: 'hostile' }>): void {
  // The hostile member is seated too, so it holds the current epoch's true key.
  const current = modelEpoch(model, model.current);
  const epochKey = operation.variant === 'zero-key' ? ZERO_KEY : undefined;
  buildHostile(() => {
    appendRotation(
      model,
      { epochNumber: model.current, privateKey: current.privateKey },
      (built) => {
        switch (operation.variant) {
          case 'junk-wrap': {
            return { record: built.record, wrap: operation.junk };
          }
          case 'foreign-key': {
            // The honest member is handed the rotation's true key, with its true
            // confirmation, sealed under a public key the hostile member chose:
            // everything it opens is self-consistent except that public key.
            const foreignPublicKey = getPublicKeyFromPrivate(operation.foreignKey);
            return {
              record: { ...built.record, epochPublicKey: toBase64(foreignPublicKey) },
              wrap: wrapSecretTo(
                asAccountPublicKey(getPublicKeyFromPrivate(model.honestKey)),
                built.epochPrivateKey,
                WRAP_LABELS.epochKeyMember,
                epochWrapAad({
                  conversationId: CONVERSATION_ID,
                  epochNumber: built.epochNumber,
                  epochPublicKey: foreignPublicKey,
                })
              ),
            };
          }
          case 'junk-link': {
            return {
              record: { ...built.record, chainLink: toBase64(operation.junk) },
              wrap: built.wrap,
            };
          }
          case 'spliced-link': {
            return {
              record: {
                ...built.record,
                chainLink: current.record.chainLink ?? toBase64(operation.junk),
              },
              wrap: built.wrap,
            };
          }
          case 'zero-key': {
            return built;
          }
        }
      },
      true
    );
  }, epochKey);
}

/** Returns whether a recovery rotation was made. */
function recover(model: Model): boolean {
  const verdict = verify(model);
  if (verdict.rotation === 'ok' || verdict.lastGoodEpoch === null) return false;
  const lastGoodKey = verdict.keys.get(verdict.lastGoodEpoch);
  if (lastGoodKey === undefined) throw new Error('The last good epoch has no verified key');
  appendRotation(
    model,
    { epochNumber: verdict.lastGoodEpoch, privateKey: lastGoodKey },
    (built) => built,
    false
  );
  return true;
}

function expectPathVerifies(model: Model, verdict: KeyChainVerdict): void {
  expect(verdict.rotation).toBe('ok');
  let epochNumber: number | null = model.current;
  while (epochNumber !== null) {
    const epochVerdict = verdict.epochs.get(epochNumber);
    expect(epochVerdict?.key).toEqual({ status: 'ok' });
    expect(['ok', 'absent']).toContain(epochVerdict?.link);
    const record: KeyChainEpoch = modelEpoch(model, epochNumber).record;
    epochNumber = record.chainLink === null ? null : record.previousEpochNumber;
  }
}

function expectHostileEpochsReported(model: Model, verdict: KeyChainVerdict): void {
  for (const epoch of model.epochs.filter((candidate) => candidate.hostile)) {
    const epochVerdict = verdict.epochs.get(epoch.record.epochNumber);
    expect(epochVerdict?.key.status !== 'ok' || epochVerdict.link === 'bad').toBe(true);
  }
}

function expectHonestWrapsOpen(model: Model): void {
  for (const epoch of model.epochs.filter((candidate) => !candidate.hostile)) {
    const wrap = model.wraps.find((each) => each.epochNumber === epoch.record.epochNumber);
    expect(
      openEpochWrap(model.honestKey, fromBase64(wrap?.wrap ?? ''), {
        conversationId: CONVERSATION_ID,
        epochNumber: epoch.record.epochNumber,
        epochPublicKey: fromBase64(epoch.record.epochPublicKey),
        confirmationHash: fromBase64(epoch.record.confirmationHash),
      })
    ).toEqual({ ok: true, key: epoch.privateKey });
  }
}

interface ServedEpochPlan {
  readonly epochNumber: number;
  readonly previousEpochNumber: number | null;
  /** The key the record commits to; any length, all zero included. */
  readonly key: Uint8Array;
  /** Served in place of the key's own public key, confirmation or wrap when set. */
  readonly publicKey: Uint8Array | null;
  readonly confirmationHash: Uint8Array | null;
  readonly wrap: Uint8Array | null;
  /** `sealed`: a link the hostile encoder builds to the named predecessor. */
  readonly chainLink: Uint8Array | 'sealed' | null;
}

interface ServedKeyChainPlan {
  readonly epochs: readonly ServedEpochPlan[];
  readonly currentEpoch: number;
}

const epochNumberArb = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: 1, max: 4 }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(0, -1, 0.5, 2 ** 53, Number.POSITIVE_INFINITY, Number.NaN),
  }
);

const servedBytesArb = fc.uint8Array({ maxLength: 120 });

function servedInstead(arbitrary: fc.Arbitrary<Uint8Array>): fc.Arbitrary<Uint8Array | null> {
  return fc.oneof({ weight: 3, arbitrary: fc.constant(null) }, { weight: 1, arbitrary });
}

const servedEpochArb: fc.Arbitrary<ServedEpochPlan> = fc.record({
  epochNumber: epochNumberArb,
  previousEpochNumber: fc.oneof(fc.constant(null), epochNumberArb),
  key: fc.oneof(keyBytesArb, fc.constant(ZERO_KEY), fc.uint8Array({ maxLength: KEY_BYTES + 8 })),
  publicKey: servedInstead(servedBytesArb),
  confirmationHash: servedInstead(servedBytesArb),
  wrap: servedInstead(servedBytesArb),
  chainLink: fc.oneof(fc.constant(null), fc.constant('sealed' as const), servedBytesArb),
});

const hostileKeyChainArb: fc.Arbitrary<ServedKeyChainPlan> = fc.record({
  epochs: fc.array(servedEpochArb, { maxLength: 5 }),
  currentEpoch: epochNumberArb,
});

function encodable(epochNumber: number): boolean {
  return Number.isSafeInteger(epochNumber) && epochNumber >= 0;
}

function publicKeyOf(plan: ServedEpochPlan): Uint8Array {
  if (plan.publicKey !== null) return plan.publicKey;
  return plan.key.length === KEY_BYTES ? getPublicKeyFromPrivate(plan.key) : plan.key;
}

function confirmationOf(plan: ServedEpochPlan): Uint8Array {
  if (plan.confirmationHash !== null) return plan.confirmationHash;
  if (plan.key.length !== KEY_BYTES || !encodable(plan.epochNumber)) return plan.key;
  return computeEpochConfirmation(asEpochPrivateKey(plan.key), CONVERSATION_ID, plan.epochNumber);
}

function wrapOf(plan: ServedEpochPlan, principalPublicKey: Uint8Array): Uint8Array {
  if (plan.wrap !== null) return plan.wrap;
  if (!encodable(plan.epochNumber)) return plan.key;
  return wrapSecretTo(
    asAccountPublicKey(principalPublicKey),
    plan.key,
    WRAP_LABELS.epochKeyMember,
    epochWrapAad({
      conversationId: CONVERSATION_ID,
      epochNumber: plan.epochNumber,
      epochPublicKey: publicKeyOf(plan),
    })
  );
}

/** A link sealed from the plan's key to its predecessor's, where the encoder can express one. */
function sealedLinkOf(plan: ServedEpochPlan, plans: readonly ServedEpochPlan[]): Uint8Array {
  const previous = plan.previousEpochNumber;
  const predecessor = plans.find((each) => each.epochNumber === previous);
  if (
    previous === null ||
    predecessor === undefined ||
    plan.key.length !== KEY_BYTES ||
    predecessor.key.length !== KEY_BYTES ||
    !encodable(plan.epochNumber) ||
    !encodable(previous) ||
    previous >= plan.epochNumber
  ) {
    return plan.key;
  }
  const epochKey = plan.key;
  return buildHostile(
    () =>
      performEpochRotation({
        predecessor: {
          epochNumber: previous,
          privateKey: predecessor.key,
          publicKey: getPublicKeyFromPrivate(predecessor.key),
        },
        memberPublicKeys: [],
        conversationId: CONVERSATION_ID,
        epochNumber: plan.epochNumber,
      }).chainLink,
    epochKey
  );
}

function chainLinkOf(plan: ServedEpochPlan, plans: readonly ServedEpochPlan[]): string | null {
  if (plan.chainLink === null) return null;
  if (plan.chainLink === 'sealed') return toBase64(sealedLinkOf(plan, plans));
  return toBase64(plan.chainLink);
}

function serve(plan: ServedKeyChainPlan, principalPublicKey: Uint8Array): KeyChainResponse {
  return buildHostile(() => ({
    epochs: plan.epochs.map((epoch) => ({
      epochNumber: epoch.epochNumber,
      epochPublicKey: toBase64(publicKeyOf(epoch)),
      confirmationHash: toBase64(confirmationOf(epoch)),
      previousEpochNumber: epoch.previousEpochNumber,
      chainLink: chainLinkOf(epoch, plan.epochs),
    })),
    wraps: plan.epochs.map((epoch) => ({
      epochNumber: epoch.epochNumber,
      wrap: toBase64(wrapOf(epoch, principalPublicKey)),
    })),
    currentEpoch: plan.currentEpoch,
    rotationPending: false,
  }));
}

/** Runs the generated operations, handing the model to `check` after every recovery. */
function afterEachRecovery(check: (model: Model, verdict: KeyChainVerdict) => void): void {
  fc.assert(
    fc.property(privateKeyArb, operationsArb, (honestKey, operations) => {
      const model = startModel(honestKey);
      for (const operation of operations) {
        if (operation.kind === 'honest') honestRotate(model);
        else if (operation.kind === 'hostile') hostileRotate(model, operation);
        else if (recover(model)) check(model, verify(model));
      }
    }),
    { numRuns: RUNS }
  );
}

describe('verifying a key chain through hostile rotations and recoveries', () => {
  it('verifies every epoch on the honest path after a recovery', () => {
    afterEachRecovery((model, verdict) => {
      expectPathVerifies(model, verdict);
    });
  });

  it('still reports every hostile epoch after a recovery', () => {
    afterEachRecovery((model, verdict) => {
      expectHostileEpochsReported(model, verdict);
    });
  });

  it('keeps every honestly given direct wrap openable after a recovery', () => {
    afterEachRecovery((model) => {
      expectHonestWrapsOpen(model);
    });
  });
});

describe('verifying any keychain a hostile server serves', () => {
  it('returns a verdict without throwing', () => {
    fc.assert(
      fc.property(privateKeyArb, hostileKeyChainArb, (principalKey, plan) => {
        const keyChain = serve(plan, getPublicKeyFromPrivate(principalKey));

        expect(() => verifyKeyChain(keyChain, principalKey, CONVERSATION_ID)).not.toThrow();
      }),
      { numRuns: FUZZ_RUNS }
    );
  });
});
