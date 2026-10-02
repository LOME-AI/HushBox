import { z } from 'zod';
import { requireUser } from '../guards.js';
import { MAX_KE_ARRAY_LENGTH, opaqueByteArray } from '../opaque/opaque.js';
import { saveRecoveryKey } from './recovery.js';
import { STEP_UP_GATES, createStepUpFinishFlow, startGuardedStepUp } from '../session/step-up.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { IdentityUsersStore } from '../../ports/index.js';
import type { IdentitySecrets, OpaqueFinishFlow } from '../opaque/opaque.js';
import type { RedisClient } from '../keys.js';
import type { StepUpFinishOutcome } from '../session/step-up.js';

export const recoverySaveInitBodySchema = z.object({
  ke1: opaqueByteArray(MAX_KE_ARRAY_LENGTH),
});

export const recoverySaveFinishBodySchema = z.object({
  ke3: opaqueByteArray(MAX_KE_ARRAY_LENGTH),
  recoverySaveSessionId: z.uuid(),
  recoveryWrappedPrivateKey: z.string().min(1),
  recoveryPublicKey: z.string().min(1),
});

interface RecoverySaveInitArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly secrets: Pick<IdentitySecrets, 'opaqueKek'>;
  readonly userId: string;
  readonly ke1: number[];
}

type RecoverySaveInitOutcome =
  | { readonly kind: 'locked'; readonly retryAfterSeconds: number }
  | { readonly kind: 'server-material-unreadable' }
  | {
      readonly kind: 'started';
      readonly ke2: number[];
      readonly recoverySaveSessionId: string;
    };

/**
 * Round one of a recovery-material save: an OPAQUE step-up challenge over the
 * caller's live password. A session alone must not be able to replace the
 * recovery keypair — whoever holds the new phrase holds a permanent path back
 * into the account, so the write is priced at the password, not the cookie.
 */
export function startRecoverySave(
  args: RecoverySaveInitArgs
): ResultAsync<RecoverySaveInitOutcome, DomainError> {
  return args.store.findById(args.userId).andThen((found) => {
    const user = requireUser(found);
    return startGuardedStepUp({
      redis: args.redis,
      gate: STEP_UP_GATES.recoverySave,
      ke1: args.ke1,
      userId: args.userId,
      opaqueRegistration: user.opaqueRegistration,
      opaqueServerMaterial: user.opaqueServerMaterial,
      opaqueKek: args.secrets.opaqueKek,
    }).map(
      (stepUp): RecoverySaveInitOutcome =>
        stepUp.kind === 'started'
          ? {
              kind: 'started',
              ke2: stepUp.ke2,
              recoverySaveSessionId: stepUp.stepUpSessionId,
            }
          : stepUp
    );
  });
}

interface RecoverySaveFinishArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly userId: string;
  readonly ke3: number[];
  readonly recoverySaveSessionId: string;
  readonly recoveryWrappedPrivateKey: string;
  readonly recoveryPublicKey: string;
}

interface RecoverySaveResult {
  readonly saved: true;
}

/**
 * Round two: the step-up finish flow verifies the password, and only then does
 * `saveRecoveryKey` run. The effect lives inside `onVerified` rather than beside
 * it, so there is no ordering a caller can get wrong — an unproven request never
 * reaches the UPDATE at all.
 */
export function createRecoverySaveFinishFlow(
  args: RecoverySaveFinishArgs
): OpaqueFinishFlow<StepUpFinishOutcome<RecoverySaveResult>> {
  return createStepUpFinishFlow<RecoverySaveResult>({
    redis: args.redis,
    gate: STEP_UP_GATES.recoverySave,
    userId: args.userId,
    stepUpSessionId: args.recoverySaveSessionId,
    ke3: args.ke3,
    onVerified: () =>
      saveRecoveryKey({
        store: args.store,
        userId: args.userId,
        recoveryWrappedPrivateKey: args.recoveryWrappedPrivateKey,
        recoveryPublicKey: args.recoveryPublicKey,
      }).map((): RecoverySaveResult => ({ saved: true })),
  });
}
