import { z } from 'zod';
import { rotateEpochOutcomeSchema } from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { refusalSchema } from '../outcomes.js';
import { applyRotation, epochRowId, planEpochWraps } from './rotation.js';
import type { RotateEpochBody } from '@hushbox/shared';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { ConversationRecord, ConversationsStores } from '../../ports/index.js';

export const rotateEpochDomainOutcomeSchema = z.union([rotateEpochOutcomeSchema, refusalSchema]);

type RotateOutcome = z.infer<typeof rotateEpochDomainOutcomeSchema>;

interface RotateEpochParams {
  readonly conversationId: string;
  readonly callerUserId: string;
  readonly body: RotateEpochBody;
}

/**
 * The standalone rotation any active session member runs: a maintenance
 * rotation that excludes departed seats, or a recovery that chains the new
 * epoch to an earlier `predecessorEpoch` whose keys verified, skipping a bad
 * one. Every gate runs under the conversation `FOR UPDATE` lock before the
 * first write. The server sees no key, so recovery is authorized by what it
 * can check: the caller holds a wrap in the predecessor, and the wrap set is
 * exactly the live seats. A maintenance rotation with nothing pending answers
 * as already done, which is how a client that lost the race stops.
 */
export function rotateEpoch(
  stores: ConversationsStores,
  params: RotateEpochParams
): ResultAsync<RotateOutcome, DomainError> {
  const { conversationId, callerUserId, body } = params;
  return stores.conversations.lockForUpdate(conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<RotateOutcome>({ refusal: 'not-found' });
    return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
      if (caller === null) return okAsync<RotateOutcome>({ refusal: 'not-found' });
      const context = { stores, params, conversation };
      return body.predecessorEpoch === undefined
        ? maintenance(context)
        : recovery(context, body.predecessorEpoch);
    });
  });
}

interface RotateContext {
  readonly stores: ConversationsStores;
  readonly params: RotateEpochParams;
  readonly conversation: ConversationRecord;
}

function staleEpoch(conversation: ConversationRecord): RotateOutcome {
  return { refusal: 'stale-epoch', currentEpoch: conversation.currentEpoch };
}

function maintenance(context: RotateContext): ResultAsync<RotateOutcome, DomainError> {
  const { stores, params, conversation } = context;
  return stores.epochs
    .conversationsWithDepartedHolders([params.conversationId])
    .andThen((pending) => {
      if (!pending.has(params.conversationId)) {
        return okAsync<RotateOutcome>({ rotated: false, currentEpoch: conversation.currentEpoch });
      }
      if (params.body.expectedEpoch !== conversation.currentEpoch) {
        return okAsync(staleEpoch(conversation));
      }
      return planAndApply(context, params.body.expectedEpoch);
    });
}

function recovery(
  context: RotateContext,
  predecessorEpoch: number
): ResultAsync<RotateOutcome, DomainError> {
  const { stores, params, conversation } = context;
  if (params.body.expectedEpoch !== conversation.currentEpoch) {
    return okAsync(staleEpoch(conversation));
  }
  if (predecessorEpoch >= conversation.currentEpoch) {
    return okAsync<RotateOutcome>({ refusal: 'validation' });
  }
  return stores.users.byId(params.callerUserId).andThen((user) => {
    if (user === null) {
      throw new Error('conversations: users row missing for an active member');
    }
    return stores.epochs
      .memberInEpoch({
        conversationId: params.conversationId,
        epochNumber: predecessorEpoch,
        memberPublicKey: user.publicKey,
      })
      .andThen((holdsPredecessor) =>
        holdsPredecessor
          ? planAndApply(context, predecessorEpoch)
          : okAsync<RotateOutcome>({ refusal: 'forbidden' })
      );
  });
}

function planAndApply(
  context: RotateContext,
  predecessorEpoch: number
): ResultAsync<RotateOutcome, DomainError> {
  const { stores, params, conversation } = context;
  return stores.members.activeVisibilityByKey(params.conversationId).andThen((visibility) => {
    const plan = planEpochWraps(visibility, params.body.memberWraps);
    if (plan === null) return okAsync<RotateOutcome>({ refusal: 'wrap-set-mismatch' });
    return epochRowId(stores, params.conversationId, predecessorEpoch)
      .andThen((predecessorEpochId) =>
        applyRotation(stores, {
          conversationId: params.conversationId,
          rotation: params.body,
          plan,
          predecessorEpochId,
          writeTitle: conversation.ownerUserId === params.callerUserId,
        })
      )
      .map((rotated): RotateOutcome => ({ rotated: true, newEpochNumber: rotated.newEpochNumber }));
  });
}
