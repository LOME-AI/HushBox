import { opaqueStepUpFinish, opaqueStepUpInit, openServerMaterial } from '@hushbox/crypto';
import { fromPromise, okAsync } from '../../../../lib/result/index.js';
import { clear, consume } from '../../../../lib/rate-limit/index.js';
import { redisGetDel, redisSet } from '../../../../lib/redis/index.js';
import { IDENTITY_KEYS } from '../keys.js';
import { openUnderLiveKey } from '../open-under-live-key.js';
import { opaqueProtocolError } from '../opaque/opaque.js';
import type { z } from 'zod';
import type { OpaqueKek } from '@hushbox/crypto';
import type { RedisKeyDefinition } from '../../../../lib/redis/index.js';
import type { ReservationLimit } from '../../../../lib/rate-limit/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { OpaqueFinishFlow } from '../opaque/opaque.js';
import type { RedisClient, passwordRotationPinSchema, stepUpPendingSchema } from '../keys.js';

/** Any step-up handshake registry entry; all share `stepUpPendingSchema`'s shape. */
type StepUpKeyDefinition = RedisKeyDefinition<typeof stepUpPendingSchema, [string]>;
export type StepUpPending = z.infer<typeof stepUpPendingSchema>;
/** The rotation a record-rewriting step-up pins at init for its finish to write. */
type StepUpRotationPin = z.infer<typeof passwordRotationPinSchema>;

/**
 * A step-up flow's two coupled halves in one value: the handshake key its
 * rounds share, and the guessing gate its init spends and its finish clears.
 *
 * They travel together so that a wrong pairing is unrepresentable via the
 * registry below — now the single line where one could be written. It is not
 * unrepresentable absolutely: this interface is structural, so a hand-built
 * gate pairing one flow's handshake key with another's lockout type-checks,
 * and a finish carrying it refunds the wrong counter silently. Narrowing the
 * parameter to the registry's own value type does not close that either, since
 * the lockouts have identical literal types; the registry, not the compiler,
 * is what keeps a flow's spend and clear on one counter.
 */
interface StepUpGate {
  readonly definition: StepUpKeyDefinition;
  readonly lockout: ReservationLimit;
}

/**
 * Every step-up flow's gate. Change-password, 2FA-disable and recovery-save
 * share one counter for one secret; deletion carries its own, so that only its
 * own failures can arm the 24-hour freeze it guards.
 */
export const STEP_UP_GATES = {
  changePassword: {
    definition: IDENTITY_KEYS.opaquePendingChangePassword,
    lockout: IDENTITY_KEYS.stepUpLockout,
  },
  twoFactorDisable: {
    definition: IDENTITY_KEYS.opaquePending2FADisable,
    lockout: IDENTITY_KEYS.stepUpLockout,
  },
  recoverySave: {
    definition: IDENTITY_KEYS.opaquePendingRecoverySave,
    lockout: IDENTITY_KEYS.stepUpLockout,
  },
  deleteAccount: {
    definition: IDENTITY_KEYS.opaquePendingDeleteAccount,
    lockout: IDENTITY_KEYS.deleteAccountInitLockout,
  },
} as const satisfies Record<string, StepUpGate>;

interface StartStepUpArgs {
  readonly redis: RedisClient;
  readonly gate: StepUpGate;
  readonly ke1: number[];
  readonly userId: string;
  readonly opaqueRegistration: Uint8Array;
  /** The caller's sealed server material, opened under the KEK for the AKE init. */
  readonly opaqueServerMaterial: Uint8Array;
  readonly opaqueKek: OpaqueKek;
  /**
   * Runs once the gate admits and the handshake is computed, before the entry
   * is stored: what it yields is pinned in that entry, so the finish round
   * writes exactly what this round produced (a password change's fresh
   * material) and never re-derives it.
   */
  readonly pin?: () => ResultAsync<StepUpRotationPin, DomainError>;
}

type StartStepUpOutcome =
  | { readonly kind: 'server-material-unreadable' }
  | ({ readonly kind: 'started' } & StartedStepUp);

interface StartedStepUp {
  readonly ke2: number[];
  readonly stepUpSessionId: string;
}

/**
 * Round one of an OPAQUE step-up: re-runs the AKE init against the caller's
 * own stored registration record on their own server material (they are
 * already authenticated), mints a server-side handshake id, and stashes the
 * `expected` result under it. The userId rides in the stored value so the
 * finish round can reject a stolen handshake id bound to another account.
 */
function startStepUp(args: StartStepUpArgs): ResultAsync<StartStepUpOutcome, DomainError> {
  const material = openUnderLiveKey(() =>
    openServerMaterial(args.opaqueKek, args.userId, args.opaqueServerMaterial)
  );
  if (material === null) {
    return okAsync<StartStepUpOutcome, DomainError>({ kind: 'server-material-unreadable' });
  }
  return fromPromise(
    opaqueStepUpInit({
      material,
      opaqueRegistration: args.opaqueRegistration,
      username: args.userId,
      ke1: new Uint8Array(args.ke1),
    }),
    opaqueProtocolError('OPAQUE step-up authInit rejected the request')
  )
    .andThen((init) => {
      const pinned: ResultAsync<StepUpRotationPin | null, DomainError> =
        args.pin === undefined ? okAsync(null) : args.pin();
      return pinned.map((rotation) => ({ init, rotation }));
    })
    .andThen(({ init, rotation }) => {
      const stepUpSessionId = crypto.randomUUID();
      return redisSet(
        args.redis,
        args.gate.definition,
        {
          userId: args.userId,
          expectedSerialized: init.expectedSerialized,
          ...(rotation === null ? {} : { rotation }),
        },
        stepUpSessionId
      ).map((): StartStepUpOutcome => ({ kind: 'started', ke2: [...init.ke2], stepUpSessionId }));
    });
}

/**
 * Resolves and CONSUMES the step-up handshake in one atomic Redis GETDEL —
 * strictly single-use, success or failure. A replayed or racing finish reads
 * null and takes the no-step-up path; a fresh re-auth requires a fresh init.
 */
export function consumeStepUp(
  redis: RedisClient,
  definition: StepUpKeyDefinition,
  stepUpSessionId: string
): ResultAsync<StepUpPending | null, DomainError> {
  return redisGetDel(redis, definition, stepUpSessionId);
}

type GuardedStepUpOutcome =
  | { readonly kind: 'locked'; readonly retryAfterSeconds: number }
  | StartStepUpOutcome;

/**
 * `startStepUp` behind a guessing gate — the entry point every password-only
 * step-up uses, so a flow cannot mint a challenge without spending an attempt.
 *
 * The attempt is spent BEFORE the handshake, because the handshake IS the
 * answer: OPAQUE hands the guess back in KE2 and the client checks it locally,
 * so a wrong password never returns for the finish round. The increment is
 * therefore the gate — at most `maxAttempts` challenges are minted per window
 * even under concurrent issuance.
 *
 * Spending and clearing are a pair, and the `gate` is what holds the pair
 * together: whatever is spent here is what the matching finish clears, because
 * both halves read the same value.
 */
export function startGuardedStepUp(
  args: StartStepUpArgs
): ResultAsync<GuardedStepUpOutcome, DomainError> {
  return consume(args.redis, args.gate.lockout, args.userId).andThen((decision) => {
    if (!decision.allowed) {
      return okAsync<GuardedStepUpOutcome, DomainError>({
        kind: 'locked',
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
    return startStepUp(args);
  });
}

/**
 * Finishes the OPAQUE exchange over a pinned expected result: true only when
 * the KE3 carries the MAC that result predicts. Every password proof — login
 * and each step-up — ends here, so a malformed KE3 collapses onto the same
 * rejection on every path: junk bytes are indistinguishable from a wrong
 * password, never a 500 on one route and a 401 on another.
 */
export function proofHolds(expectedSerialized: number[], ke3: number[]): boolean {
  try {
    return opaqueStepUpFinish({ ke3: new Uint8Array(ke3), expectedSerialized }).ok;
    // eslint-disable-next-line catch-swallow/no-silent-catch -- malformed KE3 bytes are a rejection verdict, indistinguishable from a wrong password.
  } catch {
    // A malformed KE3 throws in deserialization.
    return false;
  }
}

export type StepUpVerdict = 'ok' | 'bad-proof' | 'session-mismatch';

/**
 * Verifies a consumed step-up handshake against the caller's session user and
 * their KE3. A handshake bound to another account is `session-mismatch`; a
 * malformed KE3 or a failed 3DH MAC is `bad-proof` — the two indistinguishable
 * failure modes never leak which account a stolen handshake id belonged to.
 */
export function verifyStepUp(pending: StepUpPending, userId: string, ke3: number[]): StepUpVerdict {
  if (pending.userId !== userId) return 'session-mismatch';
  return proofHolds(pending.expectedSerialized, ke3) ? 'ok' : 'bad-proof';
}

export type StepUpFinishOutcome<T> =
  // no-pending and session-mismatch collapse together: a stolen handshake id
  // is indistinguishable from a replayed or expired one.
  | { readonly kind: 'no-step-up' }
  | { readonly kind: 'bad-proof' }
  | { readonly kind: 'verified'; readonly value: T };

interface StepUpFinishFlowArgs<T> {
  readonly redis: RedisClient;
  /** The same gate the init round spent — see `StepUpGate`. */
  readonly gate: StepUpGate;
  readonly userId: string;
  readonly stepUpSessionId: string;
  readonly ke3: number[];
  /**
   * Runs only after a verified re-auth, on the handshake the claim consumed
   * (so a pinned rotation reaches the write); carries the feature-specific
   * result.
   */
  readonly onVerified: (pending: StepUpPending) => ResultAsync<T, DomainError>;
}

/**
 * The step-up finish `byEventId` composition shared by every sensitive
 * authenticated op: consuming the handshake is the first-delivery claim, and
 * verification (including the feature effect in `onVerified`) runs only on the
 * claimed state.
 */
export function createStepUpFinishFlow<T>(
  args: StepUpFinishFlowArgs<T>
): OpaqueFinishFlow<StepUpFinishOutcome<T>> {
  let pending: StepUpPending | null = null;
  return {
    claim: () =>
      consumeStepUp(args.redis, args.gate.definition, args.stepUpSessionId).map((state) => {
        pending = state;
        return state !== null;
      }),
    execute: () => executeStepUpFinish(args, pending),
    onDuplicate: () => okAsync<StepUpFinishOutcome<T>, DomainError>({ kind: 'no-step-up' }),
  };
}

function executeStepUpFinish<T>(
  args: StepUpFinishFlowArgs<T>,
  pending: StepUpPending | null
): ResultAsync<StepUpFinishOutcome<T>, DomainError> {
  if (pending === null) {
    // `execute` runs only for the delivery that won the claim; a null consume
    // can never win it.
    throw new Error('identity: step-up finish executed without a claimed handshake');
  }
  const verdict = verifyStepUp(pending, args.userId, args.ke3);
  if (verdict === 'session-mismatch') {
    return okAsync<StepUpFinishOutcome<T>, DomainError>({ kind: 'no-step-up' });
  }
  if (verdict === 'bad-proof') {
    return okAsync<StepUpFinishOutcome<T>, DomainError>({ kind: 'bad-proof' });
  }
  // The proof is the verified success the guessing gate clears on, so it clears
  // ahead of the feature effect: the password is proven either way, and a failed
  // effect must not leave the user's budget spent.
  return clear(args.redis, args.gate.lockout, args.userId)
    .andThen(() => args.onVerified(pending))
    .map((value): StepUpFinishOutcome<T> => ({ kind: 'verified', value }));
}
