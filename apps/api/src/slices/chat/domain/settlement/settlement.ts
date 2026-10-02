import { asEpochPublicKey } from '@hushbox/crypto';
import { ERROR_CODES, senderPrincipalId, toBase64 } from '@hushbox/shared';
import { charStorageNanoUsd, mediaStorageNanoUsd } from '@hushbox/shared/affordability';
import {
  AllBranchesFailedError,
  InfrastructureUnavailableError,
  SettlementConflictError,
  anchorChargeKey,
  createChargingCommit,
} from '../../../workflows/index.js';
import {
  advanceForkTipWithinTx,
  assertWrapEpochByMemberWithinTx,
  buildParentIndex,
  createConversationsStores,
  regenerableTailIds,
  reserveSequenceBlockWithinTx,
  resolveCallerPublicKey,
  resolveForkTipWithinTx,
} from '../../../conversations/index.js';
import {
  conflictError,
  forbiddenError,
  isAvailabilityCode,
  notFoundError,
} from '../../../../lib/errors/index.js';
import { deleteSetBlockedByOtherUser, linearDeleteSetIds } from '../messages/regenerate-guard.js';
import { persistEncryptedMessage } from '../messages/message-write.js';
import { senderCaller } from '../messages/sender.js';
import { lockPrincipalAccounts } from './principal-accounts.js';
import { runChargeContext } from './run-charge-context.js';
import type { SettlementCommit } from '../../../workflows/index.js';
import type { BillingStores } from '../../../billing/index.js';
import type { ConversationCaller, SenderChainRow } from '../../../conversations/index.js';
import type {
  ErrorCode,
  MediaPersistPlan,
  MediaValue,
  Modality,
  RegenerateAction,
  SenderPrincipal,
  SettlementCharge,
  SettlementRequest,
} from '@hushbox/shared';
import type { WrappedSecret } from '@hushbox/crypto';
import type { DbWriter, SettlementTx } from '../../../../lib/idempotency/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ChatStores } from '../../ports/stores.js';
import type {
  PersistItem,
  PersistMediaItem,
  PersistMessageParams,
} from '../messages/message-write.js';

/**
 * The AAD sender bound into the assistant message's content envelopes. A
 * reserved non-user sentinel (the nil UUID), NOT the initiator's userId:
 * `messages.senderId` is scrubbed to null when a user's account is deleted, so
 * binding the initiator would make the assistant's answers undecryptable for
 * co-members after the initiator leaves. The sentinel matches no user, so
 * deletion never touches it; `senderType='assistant'` disambiguates it, and the
 * anti-splice guarantee is unaffected (the per-item AAD still binds messageId,
 * contentItemId, and position).
 */
export const ASSISTANT_SENDER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Terminal-fails a settling turn on an expected refusal: a precondition this
 * transaction re-establishes under its own locks and reads came back unmet. A
 * concurrent write is the common cause and not the only one; none of them is a
 * defect: the throw rolls back everything the commit wrote (nothing persists,
 * so a stale epoch never wraps, a stale tip never advances and no unvalidated
 * row is deleted), the fenced settlement hook bills the run through the chat
 * refusal commit, `createChatRefusalCommit`, instead, and the engine reroutes it
 * to a friendly `{code}` outcome without a Sentry event (observability
 * doctrine).
 * Each caller passes the chat-specific client wire code, carried on the
 * underlying {@link DomainError} as a {@link wireCode} override, which the engine
 * projects through `domainWireCode`.
 *
 * A precondition left UNPROVED rather than unmet — the read itself did not
 * answer — is not a refusal and takes {@link settlementReadFailure} instead.
 *
 * The genuinely-unreachable-under-lock fork-tip CAS zero-row is deliberately NOT
 * routed here: it throws a plain {@link Error}, so it still surfaces as a defect +
 * Sentry (see {@link advanceForkTip}).
 */
function settlementConflict(
  domainError: DomainError,
  wireCode: ErrorCode,
  message: string
): SettlementConflictError {
  return new SettlementConflictError({ ...domainError, wireCode }, message);
}

/**
 * Classifies a precondition read that failed. An availability code means the
 * store never answered, so the precondition is unproved rather than unmet:
 * there is no conflicting state for the user to reconcile and no refresh of
 * theirs changes it, so it rejects with {@link InfrastructureUnavailableError},
 * which projects to UNAVAILABLE and reaches an operator. A read that DID answer,
 * with a refusal, keeps the {@link settlementConflict} route and its wire code.
 */
function settlementReadFailure(
  domainError: DomainError,
  wireCode: ErrorCode,
  message: string
): InfrastructureUnavailableError | SettlementConflictError {
  return isAvailabilityCode(domainError.code)
    ? new InfrastructureUnavailableError(message, domainError.cause)
    : settlementConflict(domainError, wireCode, message);
}

const WRAP_EPOCH_FAILURE_MESSAGE = 'chat settlement: wrap-epoch assertion failed';
const FORK_TIP_FAILURE_MESSAGE = 'chat settlement: fork-tip advancement failed';
const FORK_TIP_MOVED_MESSAGE =
  'chat settlement: fork tip moved after the regenerate guard validated its tail';
const REGENERATE_BLOCKED_MESSAGE =
  "chat settlement: the regenerate delete set holds another member's message";

/**
 * Reads the epoch public key the assistant output wraps to. Injected by the
 * conversations slice (the single writer of `epochs`); returns null when the
 * conversation's epoch row is absent, which aborts the settlement.
 */
export type EpochPublicKeyReader = (
  tx: DbWriter,
  conversationId: string,
  epochNumber: number
) => Promise<Uint8Array | null>;

/** The run identity the settlement commit closes over (RunContext, sans fence). */
export interface ChatSettlementIdentity {
  readonly conversationId: string;
  readonly epochNumber: number;
  readonly walletId: string;
  /**
   * The paying account — the owner of {@link walletId}, on every turn shape alike.
   * Who SENT rides {@link sender}; the two diverge on any owner-funded turn.
   */
  readonly payerUserId: string;
  /**
   * The SENDER principal (a member or a link guest). Drives `messages.senderId`,
   * the member-wrapped epoch gate, and per-member spend — each of which
   * re-resolves the `conversation_members` row from this principal inside the
   * settlement transaction rather than reading a carried id. Required: the run
   * identity always carries a sender, and the obvious stand-in for an absent one
   * — the payer — is wrong on exactly the owner-funded turns where the two
   * diverge, which is where it would decide who is charged.
   */
  readonly sender: SenderPrincipal;
  readonly runId: string;
  /**
   * The initiator's message. A send or an edit persists its content as the
   * turn's user message under the id the route minted at run start, and the
   * assistant's reply chains onto it. A retry carries its anchor's id and
   * persists no user row.
   */
  readonly userMessage: {
    readonly id: string;
    readonly content: string;
  };
  /**
   * The id each answer is stored under, minted when the run started and keyed by
   * the charge key (the producing node id), so the stored row carries the id its
   * live tile streamed under. A media answer's plan carries the same id.
   */
  readonly answerMessageIds: ReadonlyMap<string, string>;
  /**
   * The branch this turn extends. When set, the turn chains onto the fork's tip
   * (resolved under a fork-row lock) instead of the linear high-sequence tip,
   * and advances that tip to the new assistant reply — both inside this
   * settlement transaction. Absent (or null) for a linear send.
   */
  readonly forkId?: string | null;
  /**
   * Present when this turn re-runs an existing turn (regenerate/edit). The
   * settlement deletes the superseded reply(s) below `targetMessageId` and
   * re-parents the new reply — inside this one transaction, BEFORE reserving
   * sequences, so survivors keep the lower sequences. Absent for a fresh send.
   */
  readonly regenerate?: RegenerateAction | null;
  /**
   * The pre-minted persistence identities for this run's media generations,
   * keyed by the settlement charge key ({@link SettlementCharge.key} — the producing
   * node id, branch-suffixed under `fanOut`), so settlement joins each media
   * charge to the content item whose id the R2 key and AAD already bind.
   * Absent (or empty) for text-only turns, which stay persist-minted.
   */
  readonly mediaPlans?: ReadonlyMap<string, MediaPersistPlan>;
}

export interface ChatSettlementDeps {
  readonly identity: ChatSettlementIdentity;
  readonly stores: ChatStores;
  readonly billingStores: BillingStores;
  /**
   * The run's funding decision, derived ONCE per run by the caller from the run
   * identity's payer and sender. `true` ⟺ owner-funded (the owner's wallet paid;
   * group spend accrues); `false` ⟺ solo or a personal fall-through (no group
   * spend). It reads nothing, so settlement consumes it without opening a second
   * connection mid-transaction.
   */
  readonly ownerFunded: boolean;
  readonly readEpochPublicKey: EpochPublicKeyReader;
  readonly now: () => Date;
  readonly newId: () => string;
  /**
   * Builds the conversations read/tip stores bound to the settlement
   * transaction. Defaults to the real single-writer factory; injectable so a
   * fault test can drive the parent-chain read-failure arm that rolls the
   * settlement back.
   */
  readonly conversationsStores?: (tx: SettlementTx) => ConversationsStoresHandle;
}

/** The output content a persistable charge carries: the run's text or media final. */
type PersistableOutput =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'media'; readonly value: MediaValue };

interface PersistableCharge {
  readonly charge: SettlementCharge;
  readonly output: PersistableOutput;
}

/** A media-generation charge — the shape whose content item was pre-minted at run start. */
function isMediaModality(modality: Modality): boolean {
  return modality === 'image' || modality === 'video';
}

/**
 * The billable generations whose content the run surfaced as a persistable
 * output: a text output under any charge, or a media output under a
 * media-modality charge. A media output paired to a NON-media charge is a
 * shape mismatch, so it mints no content item of its own; the charge still
 * settles, against the run's anchor, because its node's value COMMITTED.
 *
 * Committing is the licence, and provider spend is NOT — a generation whose call
 * succeeded but whose value failed the runtime output gate never reaches this
 * function at all, because the interpreter charges after the commit and only on
 * success (pinned in `interpreter.test.ts`, "bills nothing for a sibling whose
 * value failed output validation"). So every charge here names work the run
 * accepted, which is what makes anchoring a contentless one onto the run's
 * content honest rather than an over-bill.
 *
 * An EMPTY result is the run's all-failed signal, and it is read off content
 * rather than off charge count. A run may charge for a generation that persists
 * nothing of its own — a turn-level classifier is one — so "some charge exists"
 * stopped being evidence that any branch succeeded. Reading content keeps the
 * signal true for every turn shape: no persistable content means nothing to
 * save and nothing to bill.
 */
export function collectPersistableCharges(request: SettlementRequest): PersistableCharge[] {
  const persistable: PersistableCharge[] = [];
  for (const charge of request.charges) {
    const output: (typeof request.outputs)[string] | undefined = request.outputs[charge.key];
    if (
      output !== undefined &&
      (output.kind === 'text' || (output.kind === 'media' && isMediaModality(charge.modality)))
    ) {
      persistable.push({ charge, output });
    }
  }
  return persistable;
}

async function persistTurnContent(
  tx: SettlementTx,
  request: SettlementRequest,
  deps: ChatSettlementDeps
): Promise<Map<string, string>> {
  // No persistable content is the all-failed signal. A multi-model turn
  // tolerates a subset failing (those outputs simply never arrive), but ALL
  // failing terminal-fails the run — throw to roll back so nothing persists and
  // nothing bills, and the client is told it failed rather than being told a
  // turn succeeded that saved and billed nothing.
  const persistable = collectPersistableCharges(request);
  if (persistable.length === 0) {
    throw new AllBranchesFailedError('chat settlement: no model produced content');
  }

  const { identity } = deps;
  const conversationsStores = deps.conversationsStores
    ? deps.conversationsStores(tx)
    : createConversationsStores(tx);
  const wrapTarget = await resolveWrapTarget(tx, conversationsStores, deps, persistable);

  // Resolve the fork's tip under a fork-row lock (serializing against a
  // concurrent `PUT /tip`), held to commit. Both the fresh-send parent and the
  // regenerate delete/advance need it; a linear turn has no fork tip.
  const lockedForkTip =
    identity.forkId == null
      ? null
      : await resolveForkTip(conversationsStores, identity.conversationId, identity.forkId);

  assertObservedForkTip(identity, lockedForkTip);

  // Plan the graft — a fresh send, or a regenerate/edit whose delete prelude
  // runs HERE, before any sequence is reserved, so the new reply always outranks
  // the survivors. {@link graft} says where the new reply attaches and how the fork
  // tip advances (cascade-aware: deleting the tip nulls it via FK SET NULL).
  const ctx: GraftContext = { tx, conversationsStores, deps, lockedForkTip };
  const graft = await planGraft(ctx);
  // Aggregate the run's FULL charge set by the content item each anchors to, so
  // display equals debit for every turn shape. Only persistable charges mint
  // content items, so a charge with no content of its own resolves its anchor
  // nearest-first through {@link anchorChargeKey}. Pinned end-to-end in this
  // file's integration suite ("lands a turn-level classifier charge on the run's
  // content when the first sibling failed").
  const contentItemKeys = new Set(persistable.map((item) => item.charge.key));
  const displayCostByKey = aggregateDisplayCostByKey(request.charges, contentItemKeys);
  return writeGraftedTurn(ctx, { graft, wrapTarget, persistable, displayCostByKey });
}

/**
 * The membership-gate caller for the settlement's SENDER — a member by `userId`
 * or a link guest by `linkId` (carrying the conversation it acts in). Never the
 * payer: on an owner-funded turn the payer would pass a gate the sender fails.
 */
function settlementCaller(identity: ChatSettlementIdentity): ConversationCaller {
  return senderCaller(identity.sender, identity.conversationId);
}

/** The sender's principal id persisted as `messages.senderId` (linkId for a guest). */
function settlementSenderId(identity: ChatSettlementIdentity): string {
  return senderPrincipalId(identity.sender);
}

/** The epoch a turn's content wraps to: its number and its public key. */
interface WrapTarget {
  readonly epochNumber: number;
  readonly publicKey: ReturnType<typeof asEpochPublicKey>;
}

/**
 * The epoch-at-persist gate (forward secrecy), run INSIDE this transaction
 * before anything wraps. The sender's decryption public key is re-resolved
 * SERVER-SIDE from the active `conversation_members` row (a departed or revoked
 * sender resolves none and is refused), then verified against the
 * authoritative `epoch_members` wrap set of the epoch the content wraps to,
 * under a FOR SHARE lock that serializes against a concurrent rotation. The
 * check is MEMBER-KEYED, the one shape that works when the sender is a link
 * guest with no userId.
 *
 * Which epoch that is depends on the content. A text turn wraps to the
 * conversation's CURRENT epoch, as the runless user-only writer does, so a
 * rotation during the run that kept the sender (a removal of someone else, a
 * link seated without history) moves the turn into the new epoch, where a
 * removed member holds no wrap. A turn storing a media item keeps the send-time
 * epoch: its ciphertext and wrapped key were sealed to that epoch at run start,
 * so a rotation refuses it. Any failure rolls the turn back before a row is
 * written.
 */
async function resolveWrapTarget(
  tx: SettlementTx,
  conversationsStores: ConversationsStoresHandle,
  deps: ChatSettlementDeps,
  persistable: readonly PersistableCharge[]
): Promise<WrapTarget> {
  const { identity } = deps;
  const senderKey = await resolveCallerPublicKey(
    conversationsStores,
    identity.conversationId,
    settlementCaller(identity)
  ).match(
    (key) => key,
    (error) => {
      // Always infrastructure, never a refusal: {@link resolveCallerPublicKey}
      // resolves a non-member and an absent key to `null`, so its error channel
      // carries only what its stores mint — an availability code, from the
      // single translator in `apps/api/src/slices/conversations/adapters/stores.ts`.
      throw new InfrastructureUnavailableError(WRAP_EPOCH_FAILURE_MESSAGE, error.cause);
    }
  );
  if (senderKey === null) {
    throw settlementConflict(
      forbiddenError('chat wrap: sender is no longer an active member at settlement'),
      ERROR_CODES.CONFLICT,
      WRAP_EPOCH_FAILURE_MESSAGE
    );
  }
  const epochNumber = persistable.some(({ output }) => output.kind === 'media')
    ? identity.epochNumber
    : await currentEpochNumber(conversationsStores, identity.conversationId);
  const epochCheck = await assertWrapEpochByMemberWithinTx(conversationsStores, {
    conversationId: identity.conversationId,
    expectedEpoch: epochNumber,
    memberPublicKey: toBase64(senderKey),
  });
  if (epochCheck.isErr()) {
    throw settlementReadFailure(epochCheck.error, ERROR_CODES.CONFLICT, WRAP_EPOCH_FAILURE_MESSAGE);
  }
  const rawKey = await deps.readEpochPublicKey(tx, identity.conversationId, epochNumber);
  /* v8 ignore next 5 -- unreachable defect guard: assertWrapEpochByMemberWithinTx above already proved the epoch exists (with the member's key), so its public key is never null here */
  if (rawKey === null) {
    throw new Error(
      `chat settlement: conversation ${identity.conversationId} has no epoch ${String(epochNumber)} to wrap to`
    );
  }
  return { epochNumber, publicKey: asEpochPublicKey(rawKey) };
}

/**
 * The conversation's current epoch, read under the FOR SHARE lock the wrap gate
 * takes again: a rotation's `currentEpoch` update either committed before this
 * read or waits for this settlement to commit. A conversation deleted during
 * the run is a refusal.
 */
async function currentEpochNumber(
  conversationsStores: ConversationsStoresHandle,
  conversationId: string
): Promise<number> {
  const conversation = await conversationsStores.conversations.lockForShare(conversationId).match(
    (row) => row,
    (error) => {
      throw settlementReadFailure(error, ERROR_CODES.CONFLICT, WRAP_EPOCH_FAILURE_MESSAGE);
    }
  );
  if (conversation === null) {
    throw settlementConflict(
      notFoundError('chat wrap: conversation not found at settlement'),
      ERROR_CODES.CONFLICT,
      WRAP_EPOCH_FAILURE_MESSAGE
    );
  }
  return conversation.currentEpoch;
}

type ConversationsStoresHandle = ReturnType<typeof createConversationsStores>;

/** The collaborators every graft step closes over — bundled to stay under the param cap. */
interface GraftContext {
  readonly tx: SettlementTx;
  readonly conversationsStores: ConversationsStoresHandle;
  readonly deps: ChatSettlementDeps;
  readonly lockedForkTip: string | null;
}

/**
 * Where the new reply grafts onto the tree, and how the fork tip advances.
 * {@link userInsert} is present for a fresh send / edit (a new user message is
 * persisted, the reply chains onto it) and absent for a retry (the existing
 * anchor user message is kept, the reply chains onto {@link assistantParentId}).
 * {@link forkExpectedTip} is the fork-tip CAS's expected value — cascade-aware:
 * `null` when the delete removed the tip (the FK `ON DELETE SET NULL` nulled
 * it), else the locked tip. {@link reparentChildIds} are the messages the delete
 * detached (same cascade), re-attached to the new reply once it exists.
 */
interface GraftPlan {
  readonly userInsert?: {
    readonly id: string;
    readonly content: string;
    readonly parentMessageId: string | null;
  };
  readonly assistantParentId: string | null;
  readonly advanceForkTip: boolean;
  readonly forkExpectedTip: string | null;
  readonly reparentChildIds?: readonly string[];
}

interface WriteGraftedTurnParams {
  readonly graft: GraftPlan;
  readonly wrapTarget: WrapTarget;
  readonly persistable: readonly PersistableCharge[];
  /** The full anchored display cost per content-item key (own charge + classifier). */
  readonly displayCostByKey: ReadonlyMap<string, DisplayCostAggregate>;
}

/** One assistant message's worth of content: the charges of a single originating node. */
interface AssistantGroup {
  readonly key: string;
  readonly items: readonly PersistableCharge[];
}

/**
 * Groups billable content by the ORIGINATING generation (the charge key = the
 * producing node id). Each group becomes one assistant sibling message — N
 * multi-model nodes → N sibling messages.
 * A single-model turn's one charge is one group, so it persists as one message.
 * Insertion order is preserved (the interpreter surfaces charges in node order,
 * which is the selected-model order), so the last group is the last sibling.
 */
function groupByOriginatingNode(persistable: readonly PersistableCharge[]): AssistantGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, PersistableCharge[]>();
  for (const item of persistable) {
    const existing = byKey.get(item.charge.key);
    if (existing === undefined) {
      order.push(item.charge.key);
      byKey.set(item.charge.key, [item]);
    } else {
      existing.push(item);
    }
  }
  /* v8 ignore next -- unreachable `?? []`: every key in {@link order} was set in byKey in the same loop, so byKey.get(key) is always defined */
  return order.map((key) => ({ key, items: byKey.get(key) ?? [] }));
}

/** The denormalized display aggregate for one content item (its full anchored total). */
interface DisplayCostAggregate {
  readonly costNanoUsd: bigint;
  readonly isSmartModel: boolean;
}

/**
 * The per-content-item DISPLAY cost: for each persisted content item (keyed by
 * its originating charge key), the SUM over EVERY charge in the run that anchors
 * to it — its own generation PLUS every contentless charge whose cost the debit
 * path FKs to the same content item, because both paths resolve the anchor
 * through the one {@link anchorChargeKey}. Each summand is
 * `billableCost + storageFee`, the identical value `chargeWithinTx` debits,
 * so the mirrored display total equals the wallet debit total by construction
 * (Σ content_items.cost == Σ usage_records.cost per run) and cannot drift.
 * {@link isSmartModel} is true iff a charge anchoring here ran the smartModel routing
 * pipeline (`smartModelRan`), which the slot sets from the turn's own shape: an
 * answer that fell back to its declared candidate because no decision reached the
 * slot badges just the same. The chip reads "the pipeline ran", never "a
 * classifier billed". The debit path is untouched — this only fills the
 * denormalized display column.
 */
function aggregateDisplayCostByKey(
  charges: readonly SettlementCharge[],
  contentItemKeys: ReadonlySet<string>
): Map<string, DisplayCostAggregate> {
  const byKey = new Map<string, DisplayCostAggregate>();
  const runChargeKeys = charges.map((charge) => charge.key);
  for (const charge of charges) {
    const anchorKey = anchorChargeKey(charge.key, (key) => contentItemKeys.has(key), runChargeKeys);
    if (anchorKey === undefined) continue;
    const cost = charge.billableCostNanoUsd + (charge.storageFeeNanoUsd ?? 0n);
    const prior = byKey.get(anchorKey);
    byKey.set(anchorKey, {
      costNanoUsd: (prior?.costNanoUsd ?? 0n) + cost,
      isSmartModel: (prior?.isSmartModel ?? false) || charge.smartModelRan === true,
    });
  }
  return byKey;
}

/**
 * Persist the graft: reserve the sequence block, persist the (optional) new
 * user message, then one assistant sibling message per originating model node,
 * and advance the fork tip to the LAST sibling. All siblings share the turn's
 * batch id and chain onto the same parent (the new/kept user message). Returns
 * the content-item id minted for each charge key (the charge pairing).
 * Monotonic sequences are never reused, so ordering survives the regenerate
 * delete.
 */
async function writeGraftedTurn(
  ctx: GraftContext,
  params: WriteGraftedTurnParams
): Promise<Map<string, string>> {
  const { deps, conversationsStores } = ctx;
  const { identity } = deps;
  const { graft, wrapTarget, persistable, displayCostByKey } = params;
  const groups = groupByOriginatingNode(persistable);
  const userMsgCount = graft.userInsert === undefined ? 0 : 1;
  const sequences = await reserveSequences(
    conversationsStores,
    identity.conversationId,
    userMsgCount + groups.length
  );
  const batchId = deps.newId();
  const assistantParentId = await persistUserMessage(ctx, graft, wrapTarget, {
    sequences,
    batchId,
  });

  const contentItemIdByKey = new Map<string, string>();
  let lastSiblingId: string | undefined;
  for (const [index, group] of groups.entries()) {
    const assistantSequence = sequences[userMsgCount + index];
    /* v8 ignore next 3 -- the reservation is sized to userMsgCount + groups.length, so each group has its sequence; guards a would-be reservation invariant break */
    if (assistantSequence === undefined) {
      throw new Error('chat settlement: sequence block did not yield an assistant sequence');
    }
    lastSiblingId = await persistAssistantSibling(ctx, {
      group,
      wrapTarget,
      sequenceNumber: assistantSequence,
      parentMessageId: assistantParentId,
      batchId,
      contentItemIdByKey,
      displayCostByKey,
    });
  }

  // The all-failed case throws before this function, so at least one group
  // persisted and lastSiblingId is set.
  /* v8 ignore next 3 -- groups is non-empty (a run with no persistable content terminal-fails upstream), so the loop always sets lastSiblingId */
  if (lastSiblingId === undefined) {
    throw new Error('chat settlement: no assistant sibling was persisted');
  }
  // The subtree the retry-one delete detached re-attaches to the last sibling —
  // the same message the fork tip advances to, so the branch keeps one shape
  // whichever way it is read. This is the earliest it can run: the new parent
  // is minted by the loop above, and it must still commit with the delete, or
  // the subtree stays orphaned.
  if (graft.reparentChildIds !== undefined) {
    await deps.stores.reparentMessagesWithinTx(
      ctx.tx,
      identity.conversationId,
      graft.reparentChildIds,
      lastSiblingId
    );
  }
  if (identity.forkId != null && graft.advanceForkTip) {
    await advanceForkTip(conversationsStores, identity.conversationId, identity.forkId, {
      expectedTipMessageId: graft.forkExpectedTip,
      newTipMessageId: lastSiblingId,
    });
  }
  return contentItemIdByKey;
}

interface PersistSiblingParams {
  readonly group: AssistantGroup;
  readonly wrapTarget: WrapTarget;
  readonly sequenceNumber: number;
  readonly parentMessageId: string | null;
  readonly batchId: string;
  readonly contentItemIdByKey: Map<string, string>;
  readonly displayCostByKey: ReadonlyMap<string, DisplayCostAggregate>;
}

/**
 * The pre-minted persistence identity for a MEDIA group, or `undefined` for a
 * text group. A media charge with no plan is a defect (the runtime mints one
 * plan per media node BEFORE the run starts), thrown to roll the whole
 * settlement back — a media row must never mint fresh ids, because the R2
 * object and its AAD already bind the planned message/item ids.
 */
function resolveMediaPlan(
  identity: ChatSettlementIdentity,
  group: AssistantGroup
): MediaPersistPlan | undefined {
  if (!group.items.some(({ output }) => output.kind === 'media')) return undefined;
  const plan = identity.mediaPlans?.get(group.key);
  if (plan === undefined) {
    throw new Error(`chat settlement: no media persist plan for media charge "${group.key}"`);
  }
  // The shared plan type erases the WrappedSecret brand, and this row's key is
  // persisted verbatim (never re-wrapped) — an empty key from a mint-side bug
  // would commit a permanently undecryptable message, so it fails the settle.
  // Full envelope validation stays with the crypto layer at unwrap.
  if (plan.wrappedContentKey.byteLength === 0) {
    throw new Error(
      `chat settlement: empty wrapped content key in media persist plan "${group.key}"`
    );
  }
  return plan;
}

/**
 * The id a text answer is stored under: the one minted for its node when the
 * run started. A text answer with none is a defect, thrown to roll the whole
 * settlement back, exactly as a media charge with no plan is.
 */
function mintedAnswerId(identity: ChatSettlementIdentity, group: AssistantGroup): string {
  const id = identity.answerMessageIds.get(group.key);
  if (id === undefined) {
    throw new Error(`chat settlement: no minted message id for answer "${group.key}"`);
  }
  return id;
}

/** The `content_items` row type a MediaValue's modality maps to. */
function mediaContentType(modality: Modality): 'image' | 'video' {
  if (modality === 'image' || modality === 'video') return modality;
  // Impossible today (no audio node exists); a silent row would strand
  // undisplayable ciphertext, so an unknown modality kills the settlement.
  throw new Error(`chat settlement: unsupported media modality "${modality}" in a media output`);
}

/**
 * A best-effort numeric dimension from the MediaValue's free-form metadata.
 * Today's only producer (the media mapper) emits STRING hints (aspectRatio,
 * resolution) and no numeric width/height/durationMs, so these columns stay
 * null in practice — by design: dims are a nullable optional hint the renderer
 * tolerates missing, filled only if a future producer measures real values.
 */
function numericMetadata(metadata: MediaValue['metadata'], key: string): number | null {
  const value = metadata[key];
  return typeof value === 'number' ? value : null;
}

/**
 * Persist one assistant sibling message — reserved sentinel sender, chained onto
 * the shared parent (the new/kept user message), carrying its originating node's
 * generation(s) as content items — and record each generation's content-item id
 * against its charge key (the charge pairing). Returns the message id.
 *
 * A TEXT sibling persists under the message id minted for its node at run
 * start. A MEDIA sibling persists under its pre-minted plan: that same run-start
 * message id and the content-item id (the R2 key and AAD bind them) and the
 * pre-supplied epoch-wrapped content key. The pre-wrapped key does NOT bypass the rotation
 * serialization: {@link resolveWrapTarget} already ran for this settlement (it gates
 * ALL persistence, before any graft), asserting the send-time epoch the plan's
 * key was wrapped to is still current and the sender still belongs to it; a
 * mid-run rotation throws a settlement conflict before any row is written.
 */
async function persistAssistantSibling(
  ctx: GraftContext,
  params: PersistSiblingParams
): Promise<string> {
  const { deps, tx } = ctx;
  const mediaPlan = resolveMediaPlan(deps.identity, params.group);
  const assistantMessageId =
    mediaPlan?.assistantMessageId ?? mintedAnswerId(deps.identity, params.group);
  const contentIds = await persistMessage(tx, deps, params.wrapTarget, {
    messageId: assistantMessageId,
    senderType: 'assistant',
    senderId: ASSISTANT_SENDER_ID,
    sequenceNumber: params.sequenceNumber,
    parentMessageId: params.parentMessageId,
    batchId: params.batchId,
    // The wrapped content key minted at run start (the media ciphertext in R2
    // is already encrypted under it); a text sibling mints its own at persist.
    ...(mediaPlan === undefined
      ? {}
      : { wrappedContentKey: mediaPlan.wrappedContentKey as WrappedSecret }),
    items: params.group.items.map(({ charge, output }) => {
      // The full charged cost, mirrored for display reads so display equals debit:
      // the SUM of every charge anchored to this content item — its own generation
      // (marked-up model cost + additive storage fee) PLUS every contentless
      // charge the debit path FKs to the same item. The aggregate derives each
      // summand from the SAME storage-fee-bearing charge `chargeWithinTx` debits,
      // so the two cannot diverge.
      const aggregate = params.displayCostByKey.get(charge.key);
      /* v8 ignore next 3 -- every persistable charge key seeds its own aggregate entry (its own key IS a content-item key), so a miss is an unreachable invariant break */
      if (aggregate === undefined) {
        throw new Error('chat settlement: no display-cost aggregate for a persisted content item');
      }
      const display = {
        modelId: charge.modelId,
        providerName: charge.providerName,
        cost: aggregate.costNanoUsd,
        isSmartModel: aggregate.isSmartModel,
      };
      if (output.kind === 'text') {
        return { text: output.text, ...display } satisfies PersistItem;
      }
      /* v8 ignore next 3 -- a group is homogeneous (one key, one output), so a media output always resolved a plan above */
      if (mediaPlan === undefined) {
        throw new Error('chat settlement: media item persisted without a resolved plan');
      }
      return {
        contentType: mediaContentType(output.value.modality),
        id: mediaPlan.contentItemId,
        storageKey: output.value.ref,
        mimeType: output.value.mimeType,
        // The CIPHERTEXT length the mapper measured after encryption — what R2
        // actually stores, and what the storage fee already billed.
        sizeBytes: output.value.byteLength,
        width: numericMetadata(output.value.metadata, 'width'),
        height: numericMetadata(output.value.metadata, 'height'),
        durationMs: numericMetadata(output.value.metadata, 'durationMs'),
        ...display,
      } satisfies PersistMediaItem;
    }),
  });
  for (const [index, { charge }] of params.group.items.entries()) {
    const contentItemId = contentIds[index];
    /* v8 ignore next -- persistMessage returns one content id per persistable item */
    if (contentItemId === undefined) continue;
    params.contentItemIdByKey.set(charge.key, contentItemId);
  }
  return assistantMessageId;
}

/**
 * Persist the new user message (fresh send / edit) at the first reserved
 * sequence and return the parent the assistant siblings chain onto. A retry
 * inserts no user message — it keeps the existing anchor, and the siblings chain
 * straight onto {@link graft.assistantParentId}.
 */
async function persistUserMessage(
  ctx: GraftContext,
  graft: GraftPlan,
  wrapTarget: WrapTarget,
  block: { readonly sequences: readonly number[]; readonly batchId: string }
): Promise<string | null> {
  const { deps, tx } = ctx;
  if (graft.userInsert === undefined) {
    return graft.assistantParentId;
  }
  const userSequence = block.sequences[0];
  /* v8 ignore next 3 -- a reservation of userMsgCount + groups.length always yields the user sequence at index 0; guards a would-be reservation invariant break */
  if (userSequence === undefined) {
    throw new Error('chat settlement: sequence block did not yield a user sequence');
  }
  await persistMessage(tx, deps, wrapTarget, {
    messageId: graft.userInsert.id,
    senderType: 'user',
    // The SENDER's principal id — a member's userId, a link guest's linkId —
    // never the paying owner (a guest turn's payer is the owner).
    senderId: settlementSenderId(deps.identity),
    sequenceNumber: userSequence,
    parentMessageId: graft.userInsert.parentMessageId,
    batchId: block.batchId,
    items: [
      {
        text: graft.userInsert.content,
        modelId: null,
        providerName: null,
        cost: null,
        isSmartModel: false,
      },
    ],
  });
  return graft.userInsert.id;
}

/** Reserve {@link count} monotonic sequences; a missing conversation is unreachable past the epoch gate. */
async function reserveSequences(
  conversationsStores: ConversationsStoresHandle,
  conversationId: string,
  count: number
): Promise<readonly number[]> {
  const block = await reserveSequenceBlockWithinTx(conversationsStores, { conversationId, count });
  return block.match(
    (sequences) => sequences,
    /* v8 ignore next 3 -- the epoch gate above already asserted the conversation exists, so the reservation cannot report it missing here */
    (error) => {
      throw new Error('chat settlement: sequence block reservation failed', { cause: error });
    }
  );
}

/**
 * A regenerate whose deletable tail is computed from the fork tip: retry-all
 * (no `replaceAssistantId`) and edit both derive their delete set from the
 * live tip via {@link computeForkTail}. Retry-one deletes a fixed, guard-validated
 * `replaceAssistantId`, not a tip-derived tail, so it is immune to a moved tip.
 */
function deletesForkTailByTip(regenerate: RegenerateAction): boolean {
  return regenerate.action === 'edit' || regenerate.replaceAssistantId === undefined;
}

/**
 * The fork-tip TOCTOU fence. The pre-run guard's cross-member walk validated
 * the deletable tail against the fork tip it observed at route time. But the
 * fork tip is mutable by a separate `PUT /tip` route mid-run (one-run-per-
 * conversation gates only run starts, not tip edits), so a co-member's branch
 * can be spliced onto the tip after the guard passed. Deleting from the live
 * tip without re-checking it would let the settlement sweep content the guard
 * never validated. So for a tip-deleting regenerate on a fork, assert the tip
 * the fork-row lock resolved still equals the guard-observed tip (null-safe:
 * both-null passes, null-vs-value fails) BEFORE any tail is computed; a
 * mismatch throws, rolling the whole settlement back.
 */
function assertObservedForkTip(
  identity: ChatSettlementIdentity,
  lockedForkTip: string | null
): void {
  const regenerate = identity.regenerate ?? null;
  if (identity.forkId == null || regenerate === null) return;
  if (!deletesForkTailByTip(regenerate)) return;
  const observed = regenerate.observedForkTipId ?? null;
  if (lockedForkTip !== observed) {
    throw settlementConflict(
      conflictError('chat settlement: fork tip moved before the regenerate could settle'),
      ERROR_CODES.FORK_TIP_CONFLICT,
      FORK_TIP_MOVED_MESSAGE
    );
  }
}

/**
 * Whether this run stores a new user message row: a fresh send and an edit do,
 * a retry does not — it re-runs against the anchor the turn that created it
 * already stored. The one expression of that rule: it selects the graft that
 * carries a {@link GraftPlan.userInsert}, decides whether the turn owes the
 * prompt's storage fee, and — published through the slice's domain barrel —
 * decides whether the route stamps any input-storage characters for the
 * admission hold. Reserve and charge cannot disagree about what was stored
 * because there is nothing for them to disagree with.
 */
export function storesNewUserMessage(
  regenerate: Pick<RegenerateAction, 'action'> | null | undefined
): boolean {
  if (regenerate === null || regenerate === undefined) return true;
  return regenerate.action === 'edit';
}

/** Dispatches the graft on the run's tree action: fresh send, retry, or edit. */
async function planGraft(ctx: GraftContext): Promise<GraftPlan> {
  const { identity } = ctx.deps;
  const regenerate = identity.regenerate ?? null;
  if (regenerate === null) return planFreshSend(ctx);
  if (storesNewUserMessage(regenerate)) return planEdit(ctx, regenerate);
  return planRetry(ctx, regenerate);
}

/** Fresh send: chain the new user message onto the tip and advance to the reply. */
async function planFreshSend(ctx: GraftContext): Promise<GraftPlan> {
  const { deps, tx, lockedForkTip } = ctx;
  const { identity } = deps;
  const parent =
    identity.forkId == null
      ? await deps.stores.latestMessageIdWithinTx(tx, identity.conversationId)
      : lockedForkTip;
  return {
    userInsert: {
      id: identity.userMessage.id,
      content: identity.userMessage.content,
      parentMessageId: parent,
    },
    assistantParentId: null,
    advanceForkTip: true,
    forkExpectedTip: parent,
  };
}

/**
 * Retry: keep the anchor user message; the reply re-parents onto it. Retry-one
 * (`replaceAssistantId` set) deletes just that reply and advances the fork tip
 * only when the replaced reply WAS the tip. Retry-all deletes every reply below
 * the anchor (linear: by sequence; fork: the exclusive tail).
 */
async function planRetry(ctx: GraftContext, regenerate: RegenerateAction): Promise<GraftPlan> {
  const { deps, tx, lockedForkTip } = ctx;
  const { identity } = deps;
  const anchorId = regenerate.targetMessageId;
  if (regenerate.replaceAssistantId !== undefined) {
    // The replaced reply need not be the last message on its branch, so it can
    // have children; the read must precede the delete.
    const reparentChildIds = await deps.stores.childMessageIdsWithinTx(
      tx,
      identity.conversationId,
      regenerate.replaceAssistantId
    );
    await deps.stores.deleteMessagesByIdWithinTx(tx, identity.conversationId, [
      regenerate.replaceAssistantId,
    ]);
    return {
      assistantParentId: anchorId,
      advanceForkTip: identity.forkId != null && regenerate.replaceAssistantId === lockedForkTip,
      forkExpectedTip: null,
      reparentChildIds,
    };
  }
  const deletedTip = await deleteBelowAnchor(ctx, anchorId);
  return {
    assistantParentId: anchorId,
    advanceForkTip: identity.forkId != null,
    forkExpectedTip: deletedTip ? null : lockedForkTip,
  };
}

/**
 * Edit: delete from the anchor's PARENT down (the old user message and its
 * replies), then insert the new user message re-parented to that parent. A root
 * anchor (no parent) is deleted explicitly after its subtree.
 */
async function planEdit(ctx: GraftContext, regenerate: RegenerateAction): Promise<GraftPlan> {
  const { deps, lockedForkTip } = ctx;
  const { identity } = deps;
  const anchorId = regenerate.targetMessageId;
  const anchorRef = await deps.stores.messageRefWithinTx(ctx.tx, identity.conversationId, anchorId);
  if (anchorRef === null) {
    throw new Error('chat settlement: regenerate edit target message not found');
  }
  const targetParentId = anchorRef.parentMessageId;
  const deletedTip = await deleteForEdit(ctx, { anchorId, anchorRef, targetParentId });
  return {
    userInsert: {
      id: identity.userMessage.id,
      content: identity.userMessage.content,
      parentMessageId: targetParentId,
    },
    assistantParentId: null,
    advanceForkTip: identity.forkId != null,
    forkExpectedTip: deletedTip ? null : lockedForkTip,
  };
}

/**
 * Every message's sender, parent and sequence, read INSIDE the settlement
 * transaction through the conversations slice's published reader.
 */
async function senderRows(ctx: GraftContext): Promise<readonly SenderChainRow[]> {
  return ctx.conversationsStores.messages.senderChainRows(ctx.deps.identity.conversationId).match(
    (rows) => rows,
    (error) => {
      throw new Error('chat settlement: sender-chain read failed', { cause: error });
    }
  );
}

/**
 * The LINEAR regenerate delete, fenced by the same predicate the route-time
 * guard ran. That guard read a graph another member could have changed since,
 * and outside this transaction, so the rows are re-read here, the delete set is
 * derived from them by {@link linearDeleteSetIds} — the one expression that decides
 * what a linear regenerate removes, which the guard also consumes — judged, and
 * then deleted by exactly those ids. Nothing is added to the set after the
 * judgement, so no row can be deleted unjudged.
 *
 * {@link alsoDelete} carries the root anchor of an edit, which sits AT the boundary
 * rather than above it.
 */
async function deleteAboveSequence(
  ctx: GraftContext,
  deletionAnchorSequence: number,
  alsoDelete: readonly string[]
): Promise<void> {
  const { deps, tx } = ctx;
  const rows = await senderRows(ctx);
  const doomedIds = linearDeleteSetIds(rows, deletionAnchorSequence, alsoDelete);
  assertNoForeignRowInDeleteSet(ctx, rows, doomedIds);
  await deps.stores.deleteMessagesByIdWithinTx(tx, deps.identity.conversationId, [...doomedIds]);
}

/**
 * Refuses a delete set holding — or stranding — a message of a principal other
 * than this run's sender. The fence judges a set it derives itself, so a
 * refusal says that set was blocked and not that anything moved concurrently:
 * it takes the conflict route to a friendly `{code}` and rolls the whole
 * settlement back rather than paging.
 */
function assertNoForeignRowInDeleteSet(
  ctx: GraftContext,
  rows: readonly SenderChainRow[],
  doomedIds: ReadonlySet<string>
): void {
  if (deleteSetBlockedByOtherUser(rows, doomedIds, senderPrincipalId(ctx.deps.identity.sender))) {
    throw settlementConflict(
      forbiddenError(REGENERATE_BLOCKED_MESSAGE),
      ERROR_CODES.REGENERATION_BLOCKED_BY_OTHER_USER,
      REGENERATE_BLOCKED_MESSAGE
    );
  }
}

/**
 * The FORK regenerate delete, judged inside the transaction over the exact ids
 * it is about to remove. The route-time guard walked the tip-to-anchor chain
 * this tail is cut from, but it walked a graph read outside this transaction;
 * {@link assertObservedForkTip} pins the tip the tail is cut FROM, never the chain
 * beneath it. So the same predicate the linear fence runs re-judges the tail
 * here, over rows this transaction read, and the delete names exactly the ids
 * that were judged.
 */
async function deleteForkIds(ctx: GraftContext, doomed: readonly string[]): Promise<void> {
  const { deps, tx } = ctx;
  assertNoForeignRowInDeleteSet(ctx, await senderRows(ctx), new Set(doomed));
  await deps.stores.deleteMessagesByIdWithinTx(tx, deps.identity.conversationId, doomed);
}

/**
 * The edit delete: everything from the anchor's parent down, then the root
 * anchor itself when it had no parent. Returns whether the locked fork tip was
 * among the deleted ids (always false on a linear turn — no fork tip).
 */
async function deleteForEdit(
  ctx: GraftContext,
  target: {
    readonly anchorId: string;
    readonly anchorRef: { readonly sequenceNumber: number };
    readonly targetParentId: string | null;
  }
): Promise<boolean> {
  const { deps, tx, lockedForkTip } = ctx;
  const { identity } = deps;
  const { anchorId, anchorRef, targetParentId } = target;
  const deletionAnchorId = targetParentId ?? anchorId;
  if (identity.forkId == null) {
    const deletionRef =
      deletionAnchorId === anchorId
        ? anchorRef
        : await deps.stores.messageRefWithinTx(tx, identity.conversationId, deletionAnchorId);
    /* v8 ignore next 3 -- deletionRef is the anchor (non-null) or the anchor's still-present parent (an existing parentMessageId); a null here is an unreachable concurrent delete within one transaction */
    if (deletionRef === null) {
      throw new Error('chat settlement: regenerate edit deletion anchor not found');
    }
    await deleteAboveSequence(
      ctx,
      deletionRef.sequenceNumber,
      targetParentId === null ? [anchorId] : []
    );
    return false;
  }
  const tail = await computeForkTail(ctx, deletionAnchorId);
  const idsToDelete = targetParentId === null ? [...tail, anchorId] : tail;
  await deleteForkIds(ctx, idsToDelete);
  return lockedForkTip !== null && idsToDelete.includes(lockedForkTip);
}

/**
 * Delete every reply below the anchor for a retry-all. Linear: by sequence
 * (returns false — a linear turn has no fork tip). Fork: the exclusive tail
 * (returns whether that tail included the locked tip, so the caller can make
 * the fork-tip CAS cascade-aware).
 */
async function deleteBelowAnchor(ctx: GraftContext, anchorId: string): Promise<boolean> {
  const { deps, tx, lockedForkTip } = ctx;
  const { identity } = deps;
  if (identity.forkId == null) {
    const anchorRef = await deps.stores.messageRefWithinTx(tx, identity.conversationId, anchorId);
    if (anchorRef !== null) {
      await deleteAboveSequence(ctx, anchorRef.sequenceNumber, []);
    }
    return false;
  }
  const tail = await computeForkTail(ctx, anchorId);
  await deleteForkIds(ctx, tail);
  return lockedForkTip !== null && tail.includes(lockedForkTip);
}

/** The fork's exclusive deletable tail from its tip up to (exclusive of) the anchor. */
async function computeForkTail(ctx: GraftContext, anchorId: string): Promise<string[]> {
  const rows = await ctx.conversationsStores.messages
    .parentChainRows(ctx.deps.identity.conversationId)
    .match(
      (chainRows) => chainRows,
      (error) => {
        throw new Error('chat settlement: parent-chain read failed', { cause: error });
      }
    );
  return regenerableTailIds(buildParentIndex(rows), ctx.lockedForkTip, anchorId);
}

/**
 * Resolves a fork's tip under a fork-row `FOR UPDATE` lock (held to commit).
 * A fork absent at settlement — deleted while the run executed — throws to
 * terminal-fail the run so nothing persists against a stale branch.
 */
async function resolveForkTip(
  conversationsStores: ReturnType<typeof createConversationsStores>,
  conversationId: string,
  forkId: string
): Promise<string | null> {
  const resolved = await resolveForkTipWithinTx(conversationsStores, { conversationId, forkId });
  if (resolved.isErr()) {
    throw settlementReadFailure(
      resolved.error,
      ERROR_CODES.FORK_TIP_CONFLICT,
      FORK_TIP_FAILURE_MESSAGE
    );
  }
  return resolved.value.tipMessageId;
}

/**
 * Advances a fresh-send fork's tip: CAS it from the prior tip (the parent the
 * messages chained onto) to the new assistant reply, through the same
 * IS-NOT-DISTINCT-FROM CAS the `PUT /tip` route uses. Under the fork-row lock
 * the resolve step took, the CAS always holds; a zero-row outcome is an
 * unreachable concurrency defect — it throws a plain {@link Error} (NOT the
 * {@link SettlementConflictError} sentinel), so it rolls the whole settlement back AND
 * still surfaces as a defect + Sentry, unlike the expected settlement refusals.
 */
async function advanceForkTip(
  conversationsStores: ReturnType<typeof createConversationsStores>,
  conversationId: string,
  forkId: string,
  tips: { readonly expectedTipMessageId: string | null; readonly newTipMessageId: string }
): Promise<void> {
  const advanced = await advanceForkTipWithinTx(conversationsStores, {
    conversationId,
    forkId,
    ...tips,
  });
  if (advanced.isErr()) {
    throw new Error('chat settlement: fork-tip advancement failed', { cause: advanced.error });
  }
}

/**
 * Persist one message and its content items through the shared insert
 * primitive ({@link persistEncryptedMessage} — the run settlement and the runless
 * user-only send compose the SAME implementation), bound to this settlement's
 * conversation and the epoch the gate resolved. Returns the minted content-item
 * ids in item order.
 */
async function persistMessage(
  tx: SettlementTx,
  deps: ChatSettlementDeps,
  wrapTarget: WrapTarget,
  params: Omit<PersistMessageParams, 'epochPublicKey'>
): Promise<string[]> {
  return persistEncryptedMessage(
    tx,
    {
      stores: deps.stores,
      conversationId: deps.identity.conversationId,
      epochNumber: wrapTarget.epochNumber,
      newId: deps.newId,
    },
    { ...params, epochPublicKey: wrapTarget.publicKey }
  );
}

/**
 * Attaches the additive storage fee to each charge (nano-USD, never marked up).
 * Text storage = (chars) × per-char rate over the NEW turn only — the persisted
 * user prompt plus this generation's response — never the resent history. Media
 * storage = artifact bytes × per-byte rate. The shared user prompt is stored
 * ONCE per turn, so its char cost is attributed to exactly one charge; every
 * branch still carries its own response (and media) storage.
 *
 * That one charge is the first PERSISTED charge, not the first charge. A run
 * may charge for a generation that persists nothing of its own — a turn-level
 * classifier is one, and it charges before any sibling — so declaration order
 * alone no longer names a charge whose own content item can carry the fee. This
 * guarantees the fee rides a charge that minted content, which is what keeps the
 * whole prompt fee on one item in both the debit and the display.
 */
export function withStorageFees(
  request: SettlementRequest,
  promptChars: number
): SettlementCharge[] {
  const promptFee = charStorageNanoUsd(promptChars);
  const promptFeeKey = collectPersistableCharges(request)[0]?.charge.key;
  return request.charges.map((charge) => {
    const output = request.outputs[charge.key];
    const responseChars = output?.kind === 'text' ? output.text.length : 0;
    const responseFee = charStorageNanoUsd(responseChars);
    const mediaFee = mediaStorageNanoUsd(mediaBytesOf(output));
    const promptShare = charge.key === promptFeeKey ? promptFee : 0n;
    return { ...charge, storageFeeNanoUsd: promptShare + responseFee + mediaFee };
  });
}

/** The persisted byte length of a media output, or 0 for text/absent outputs. */
function mediaBytesOf(output: SettlementRequest['outputs'][string] | undefined): number {
  if (output?.kind === 'media') return output.value.byteLength;
  if (output?.kind === 'bytes') return output.bytes.length;
  return 0;
}

/**
 * The chat turn's settlement commit: lock the payer's and sender's accounts,
 * persist the assistant message and its content items, then charge each
 * billable generation, all in the ONE fenced settlement transaction the
 * interpreter enters through the settlement hook. Nothing commits mid-run, and
 * a throw here rolls back everything this commit wrote. A
 * {@link SettlementConflictError} is then billed by the chat refusal commit,
 * `createChatRefusalCommit`, in the same transaction; any other throw fails the
 * whole settlement. Either way what is saved is billed, and the key row flips
 * with the bill.
 *
 * The account locks come first, ahead of every other lock this commit takes
 * ({@link lockPrincipalAccounts} says why). Which accounts they find is not read
 * here: an account deleted before them took its member row with it, or, for the
 * owner, the conversation, and {@link resolveWrapTarget} refuses either.
 *
 * Content pairing is keyed by the CHARGE key. Each charge names the generation
 * that produced it (the node id); the interpreter surfaces that generation's
 * content under the same key in `outputs`, so a charge maps to the content item
 * minted for exactly its generation. A charge whose own generation persisted
 * nothing resolves its anchor nearest-first through {@link anchorChargeKey}; a
 * run that persisted nothing at all terminal-fails before any charge is posted.
 */
export function createChatSettlementCommit(deps: ChatSettlementDeps): SettlementCommit {
  return async (tx, request) => {
    await lockPrincipalAccounts(tx, deps);
    // Enrich every charge with its additive storage fee ONCE, up front, then feed
    // the SAME settled request to both content persistence and the charge. Display
    // must equal debit: the persisted content cost and the wallet charge derive
    // from one storage-fee value, so they cannot diverge.
    const promptChars = storesNewUserMessage(deps.identity.regenerate)
      ? deps.identity.userMessage.content.length
      : 0;
    const charges = withStorageFees(request, promptChars);
    const settled: SettlementRequest = { ...request, charges };
    const contentItemIdByKey = await persistTurnContent(tx, settled, deps);
    const charging = createChargingCommit({
      stores: deps.billingStores,
      context: {
        ...(await runChargeContext(tx, deps)),
        contentItemIdFor: (key) => contentItemIdByKey.get(key),
      },
    });
    await charging(tx, settled);
    // Stamp the conversation onto every usage record of this run (keyed by
    // runId) so per-conversation spend analytics can group by it. Runs for all
    // turn shapes — solo and group — where `chargeWithinTx`'s group-only
    // {@link conversationId} never reaches a solo turn's usage record.
    await deps.billingStores.stampRunConversationWithinTx(
      tx,
      deps.identity.runId,
      deps.identity.conversationId
    );
  };
}
