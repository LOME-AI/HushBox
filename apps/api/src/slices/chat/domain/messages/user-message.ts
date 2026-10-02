import { asEpochPublicKey } from '@hushbox/crypto';
import { createEvent } from '@hushbox/realtime/events';
import {
  advanceForkTipWithinTx,
  assertNoPendingDeparture,
  createConversationsStores,
  reserveSequenceBlockWithinTx,
  resolveForkTipWithinTx,
} from '../../../conversations/index.js';
import { notFoundError, unavailableError } from '../../../../lib/errors/index.js';
import { fromPromise } from '../../../../lib/result/index.js';
import { persistEncryptedMessage } from './message-write.js';
import type { RealtimeBroadcast } from '../../../conversations/index.js';
import type { DbTransaction } from '../../../../lib/idempotency/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { ChatStores } from '../../ports/stores.js';
import type { EpochPublicKeyReader } from '../settlement/settlement.js';

/**
 * The runless user-only send (no run, no charge): lock the conversation row,
 * resolve the parent tip, reserve ONE sequence through the same monotonic
 * counter the run settlement uses (disjoint blocks under concurrency, so a
 * send during a live run never collides), then insert the message + text
 * content item through the shared `persistEncryptedMessage` primitive. The
 * send is free: it is the legacy group-chat "AI toggle off" send.
 *
 * The message id is minted here, never taken from a client, so no send can
 * name a row that exists or that a live run will settle under. Idempotency is
 * the caller's `Idempotency-Key`: the route runs this inside the key row's
 * transaction, and a resend replays the stored response.
 */

type ConversationsStoresHandle = ReturnType<typeof createConversationsStores>;

export interface SaveUserOnlyMessageDeps {
  /**
   * The transaction the save writes in. The caller owns it, so the key row's
   * flip commits with the message or neither does.
   */
  readonly tx: DbTransaction;
  /** chat's single-writer content persister (`messages` + `content_items`). */
  readonly stores: ChatStores;
  /** The `epochs` wrap-key read the conversations slice publishes (single writer). */
  readonly readEpochPublicKey: EpochPublicKeyReader;
  readonly newId: () => string;
  /**
   * Builds the conversations read/counter stores bound to this transaction.
   * Defaults to the real single-writer factory; injectable so fault tests can
   * drive the read/reservation failure arms.
   */
  readonly conversationsStores?: (tx: DbTransaction) => ConversationsStoresHandle;
}

interface SaveUserOnlyMessageArgs {
  readonly conversationId: string;
  /** The authenticated sender's userId — persisted as `messages.senderId`. */
  readonly senderId: string;
  readonly content: string;
  /**
   * The branch being viewed when the message was sent. When present, the send
   * chains onto the fork's tip (resolved under a fork-row lock) and advances
   * that tip to this message — both inside this transaction, mirroring a paid
   * turn. Absent is a linear send onto the conversation's high-sequence tip.
   */
  readonly forkId?: string;
}

interface UserOnlyMessageOutcome {
  readonly messageId: string;
  readonly sequenceNumber: number;
  readonly epochNumber: number;
}

/** Carrier for expected domain refusals thrown out of the write. */
class UserMessageWriteError extends Error {
  constructor(readonly domainError: DomainError) {
    super('chat user message: write refused');
    this.name = 'UserMessageWriteError';
  }
}

export function saveUserOnlyMessage(
  deps: SaveUserOnlyMessageDeps,
  args: SaveUserOnlyMessageArgs
): ResultAsync<UserOnlyMessageOutcome, DomainError> {
  return fromPromise(writeUserOnlyMessage(deps, args), (cause) =>
    cause instanceof UserMessageWriteError
      ? cause.domainError
      : unavailableError('chat user message: write failed', cause)
  );
}

async function writeUserOnlyMessage(
  deps: SaveUserOnlyMessageDeps,
  args: SaveUserOnlyMessageArgs
): Promise<UserOnlyMessageOutcome> {
  const { tx } = deps;
  const messageId = deps.newId();
  const conversationsStores = deps.conversationsStores
    ? deps.conversationsStores(tx)
    : createConversationsStores(tx);
  // Conversation row FIRST, and exclusively. It is the per-conversation
  // serialization point every conversations-scoped transaction takes
  // before any narrower row (the conversations store's `lockForUpdate`
  // states it), and a settling paid turn takes it before the fork row —
  // taking the fork first inverted that order and deadlocked the two paths
  // on a shared fork. Exclusive rather than settlement's FOR SHARE gate:
  // two sends both holding a share lock and both upgrading to the
  // reservation's UPDATE would deadlock each other. The lock also carries
  // epoch-at-persist — a rotation's `currentEpoch` UPDATE either committed
  // before it (the row read here sees it) or blocks until this transaction
  // commits, so the message can never wrap to a superseded epoch.
  const conversation = await conversationsStores.conversations
    .lockForUpdate(args.conversationId)
    .match(
      (row) => row,
      (error) => {
        throw new UserMessageWriteError(error);
      }
    );
  if (conversation === null) {
    throw new UserMessageWriteError(notFoundError('chat user message: conversation not found'));
  }
  // The server encrypts this plaintext to the current epoch, so a departed seat
  // still holding that epoch's key refuses the send.
  await assertNoPendingDeparture(conversationsStores, args.conversationId).match(
    () => {
      // Success token unused — no departed seat holds the current epoch.
    },
    (error) => {
      throw new UserMessageWriteError(error);
    }
  );
  // Fork-aware parent (mirrors paid-turn settlement): with a forkId the
  // send chains onto the fork's tip instead of the linear tip, and advances
  // that tip after persist.
  const lockedForkTip =
    args.forkId === undefined
      ? null
      : await resolveForkTipWithinTx(conversationsStores, {
          conversationId: args.conversationId,
          forkId: args.forkId,
        }).match(
          (resolution) => resolution.tipMessageId,
          (error) => {
            throw new UserMessageWriteError(error);
          }
        );
  const sequences = await reserveSequenceBlockWithinTx(conversationsStores, {
    conversationId: args.conversationId,
    count: 1,
  }).match(
    (block) => block,
    (error) => {
      throw new UserMessageWriteError(error);
    }
  );
  const sequenceNumber = sequences[0];
  /* v8 ignore next 3 -- a count-1 reservation always yields one sequence; guards a would-be reservation invariant break */
  if (sequenceNumber === undefined) {
    throw new Error('chat user message: sequence block yielded no sequence');
  }
  const epochNumber = conversation.currentEpoch;
  const rawKey = await deps.readEpochPublicKey(tx, args.conversationId, epochNumber);
  if (rawKey === null) {
    // A conversation's currentEpoch always has an epochs row (rotation
    // inserts before advancing) — a missing key is a defect, not a state.
    throw new Error(
      `chat user message: conversation ${args.conversationId} has no epoch ${String(epochNumber)} to wrap to`
    );
  }
  const parentMessageId =
    args.forkId === undefined
      ? await deps.stores.latestMessageIdWithinTx(tx, args.conversationId)
      : lockedForkTip;
  await persistEncryptedMessage(
    tx,
    {
      stores: deps.stores,
      conversationId: args.conversationId,
      epochNumber,
      newId: deps.newId,
    },
    {
      messageId,
      epochPublicKey: asEpochPublicKey(rawKey),
      senderType: 'user',
      senderId: args.senderId,
      sequenceNumber,
      parentMessageId,
      batchId: deps.newId(),
      items: [
        {
          text: args.content,
          modelId: null,
          providerName: null,
          cost: null,
          isSmartModel: false,
        },
      ],
    }
  );
  if (args.forkId !== undefined) {
    // CAS the fork tip from the parent we chained onto to this message,
    // under the lock the resolve step holds — the same primitive the paid
    // turn uses. A zero-row outcome (fork moved or vanished) is an expected
    // concurrency refusal here, surfaced as its domain code, not a defect.
    await advanceForkTipWithinTx(conversationsStores, {
      conversationId: args.conversationId,
      forkId: args.forkId,
      expectedTipMessageId: lockedForkTip,
      newTipMessageId: messageId,
    }).match(
      () => {
        // Success token unused — the CAS committed the tip advance.
      },
      (error) => {
        throw new UserMessageWriteError(error);
      }
    );
  }
  return { messageId, sequenceNumber, epochNumber };
}

/**
 * Post-commit `message:new` broadcast for the runless user-only send.
 * Best-effort: the route logs a failure and never unwinds — the message
 * already committed and a client resync recovers.
 *
 * DOCTRINE: runs deliberately deliver via run frames (stream/settled events),
 * never `message:new` — this event is revived ONLY for the runless Pattern-A
 * case, whose frontend handler already exists.
 */
export function broadcastUserMessageNew(
  realtime: RealtimeBroadcast,
  params: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly senderId: string;
    readonly sequenceNumber: number;
  }
): ResultAsync<void, DomainError> {
  return realtime
    .broadcast(
      params.conversationId,
      createEvent('message:new', {
        messageId: params.messageId,
        conversationId: params.conversationId,
        senderType: 'user',
        senderId: params.senderId,
        sequenceNumber: params.sequenceNumber,
      })
    )
    .map((): void => undefined);
}
