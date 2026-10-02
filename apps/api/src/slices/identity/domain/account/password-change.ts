import { z } from 'zod';
import { rotatePasswordCredentials } from '../opaque/credentials.js';
import { requireUser } from '../guards.js';
import {
  MAX_KE_ARRAY_LENGTH,
  opaqueByteArray,
  deserializeRegistrationRequest,
  runNewPasswordRegisterInit,
} from '../opaque/opaque.js';
import { STEP_UP_GATES, createStepUpFinishFlow, startGuardedStepUp } from '../session/step-up.js';
import type { OpaqueKek } from '@hushbox/crypto';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type {
  EvictUserPort,
  IdentityUsersStore,
  PasswordChangedEmailPort,
} from '../../ports/index.js';
import type { IdentitySecrets, OpaqueFinishFlow } from '../opaque/opaque.js';
import type { RedisClient } from '../keys.js';
import type { StepUpFinishOutcome, StepUpPending } from '../session/step-up.js';

export const changePasswordInitBodySchema = z.object({
  ke1: opaqueByteArray(MAX_KE_ARRAY_LENGTH),
  newRegistrationRequest: opaqueByteArray(MAX_KE_ARRAY_LENGTH),
});

export const changePasswordFinishBodySchema = z.object({
  ke3: opaqueByteArray(MAX_KE_ARRAY_LENGTH),
  newRegistrationRecord: opaqueByteArray(MAX_KE_ARRAY_LENGTH),
  newPasswordWrappedPrivateKey: z.string().min(1),
  changePasswordSessionId: z.uuid(),
});

export interface PasswordChangeInitArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly secrets: Pick<IdentitySecrets, 'opaqueKek'>;
  readonly userId: string;
  readonly ke1: number[];
  readonly newRegistrationRequest: number[];
}

export type PasswordChangeInitOutcome =
  | { readonly kind: 'locked'; readonly retryAfterSeconds: number }
  | { readonly kind: 'server-material-unreadable' }
  | {
      readonly kind: 'started';
      readonly ke2: number[];
      readonly newRegistrationResponse: number[];
      readonly changePasswordSessionId: string;
    };

/**
 * Round one of a password change: an OPAQUE step-up challenge over the current
 * password AND a fresh registerInit for the new one, both bound to the user's
 * id. The new registration runs as the step-up's pin — once the guessing gate
 * admits, before the handshake is stored — so the record it observed and the
 * fresh material it minted ride the handshake entry to the finish round. The
 * client proves the old password (KE3) and completes the new registration in
 * the finish round.
 */
export function startPasswordChange(
  args: PasswordChangeInitArgs
): ResultAsync<PasswordChangeInitOutcome, DomainError> {
  return args.store.findById(args.userId).andThen((found) => {
    const user = requireUser(found);
    let newRegistrationResponse: number[] = [];
    return startGuardedStepUp({
      redis: args.redis,
      gate: STEP_UP_GATES.changePassword,
      ke1: args.ke1,
      userId: args.userId,
      opaqueRegistration: user.opaqueRegistration,
      opaqueServerMaterial: user.opaqueServerMaterial,
      opaqueKek: args.secrets.opaqueKek,
      pin: () =>
        deserializeRegistrationRequest(args.newRegistrationRequest)
          .asyncAndThen((request) =>
            runNewPasswordRegisterInit(args.secrets.opaqueKek, args.userId, request)
          )
          .map((init) => {
            newRegistrationResponse = init.registrationResponse;
            return {
              observedRegistration: [...user.opaqueRegistration],
              serverMaterial: [...init.serverMaterial],
              kekFingerprint: [...init.kekFingerprint],
            };
          }),
    }).map(
      (stepUp): PasswordChangeInitOutcome =>
        stepUp.kind === 'started'
          ? {
              kind: 'started',
              ke2: stepUp.ke2,
              newRegistrationResponse,
              changePasswordSessionId: stepUp.stepUpSessionId,
            }
          : stepUp
    );
  });
}

export interface PasswordChangeFinishArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly secrets: Pick<IdentitySecrets, 'opaqueKek'>;
  readonly emailPort: PasswordChangedEmailPort;
  readonly logger: Telemetry;
  readonly userId: string;
  readonly ke3: number[];
  readonly changePasswordSessionId: string;
  readonly newRegistrationRecord: number[];
  readonly newPasswordWrappedPrivateKey: string;
  readonly now: number;
  /**
   * Realtime eviction fan-out, forwarded to `rotatePasswordCredentials` so the
   * pw-changed watermark's staled sessions have their live sockets closed
   * best-effort. Optional: absent until the worker wires it (ARCHITECTURE §Streaming & realtime).
   */
  readonly evictUser?: EvictUserPort;
}

export type PasswordChangeResult =
  | { readonly kind: 'rotated' }
  | { readonly kind: 'kek-rotated' }
  | { readonly kind: 'credential-conflict' };

/**
 * Round two: the step-up finish flow verifies the old password, then rotates
 * the OPAQUE record + password-wrapped key and stamps the pw-changed-at
 * watermark so every session issued before now (this one included) goes stale.
 */
export function createPasswordChangeFinishFlow(
  args: PasswordChangeFinishArgs
): OpaqueFinishFlow<StepUpFinishOutcome<PasswordChangeResult>> {
  return createStepUpFinishFlow<PasswordChangeResult>({
    redis: args.redis,
    gate: STEP_UP_GATES.changePassword,
    userId: args.userId,
    stepUpSessionId: args.changePasswordSessionId,
    ke3: args.ke3,
    onVerified: (pending) => rotatePassword(args, pending, args.secrets.opaqueKek),
  });
}

function rotatePassword(
  args: PasswordChangeFinishArgs,
  pending: StepUpPending,
  opaqueKek: OpaqueKek
): ResultAsync<PasswordChangeResult, DomainError> {
  if (pending.rotation === undefined) {
    // The change-password init always pins its rotation; a handshake without
    // one was minted by another flow's init and can never be claimed here.
    throw new Error('identity: change-password finish claimed a handshake without a rotation pin');
  }
  return rotatePasswordCredentials({
    ...args,
    opaqueKek,
    observedRegistration: new Uint8Array(pending.rotation.observedRegistration),
    serverMaterial: new Uint8Array(pending.rotation.serverMaterial),
    kekFingerprint: new Uint8Array(pending.rotation.kekFingerprint),
    notify: (notice) => args.emailPort.sendPasswordChangedEmail(notice),
  }).map((outcome): PasswordChangeResult => ({ kind: outcome }));
}
