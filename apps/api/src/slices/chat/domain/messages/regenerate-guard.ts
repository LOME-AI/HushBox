import { okAsync } from '../../../../lib/result/index.js';
import type { ConversationsStores, SenderChainRow } from '../../../conversations/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';

/**
 * The regenerate/edit guard. A regenerate re-runs a turn from an anchor user
 * message, deleting the reply(s) below it — so it must never delete across a
 * message belonging to anyone but the caller. Its three arms prove that
 * differently, each against the delete it actually issues.
 *
 * A fork-less retry-all or edit deletes every row above a sequence boundary, and
 * is judged by the delete-set predicate the settlement re-runs over the rows it
 * removes. A fork regenerate deletes a tail cut from the tip-to-anchor chain,
 * and is judged by the ancestry walk over that same chain, with the settlement
 * re-judging the tail it cuts. Either of those, when an edit replaces a ROOT
 * anchor, also deletes that anchor — the one row the ownership gate has already
 * proved is the caller's own. A retry-one deletes one assistant reply, validated
 * here as a direct reply of the caller's own anchor and owned by no principal;
 * a co-member's message parented on that reply is detached by the FK's own
 * `ON DELETE SET NULL` and re-attached to the replacement, so its content
 * survives unchanged and only its thread position moves. That cross-member
 * effect is accepted: the alternative to re-attaching is an orphan.
 *
 * The arms are told apart the way the settlement's own graft dispatch tells them
 * apart: `action` first, then `replaceAssistantId` — no edit is ever answered by
 * the single-id arm whatever that field holds, and only a retry naming a direct
 * reply of the anchor is a retry-one. A guard discriminating on the field alone
 * would judge one id while the settlement swept a range.
 *
 * No arm consults membership. A member who left, was removed, or had their share
 * link revoked keeps their `messages.senderId`, so an active-member count bounds
 * none of these deletes: a conversation reporting one active member can still
 * hold another principal's rows in every set above.
 *
 * This gate runs BEFORE the paid run starts, so a blocked regenerate never
 * admits or charges.
 */

interface CanRegenerateParams {
  readonly conversationId: string;
  readonly targetMessageId: string;
  readonly userId: string;
  /**
   * Which turn shape this is, because the two delete from different boundaries:
   * `retry` keeps the anchor and deletes above it, `edit` replaces the anchor
   * and so deletes from its PARENT — one node higher. A guard blind to the
   * action judges the wrong blast radius for one of them.
   */
  readonly action: 'retry' | 'edit';
  /**
   * Scopes the regenerate to one branch. On the arms that delete a range —
   * retry-all and edit — the delete becomes a tail cut from this fork's tip
   * instead of a sequence range, and a fork with a tip is judged by walking
   * that same tip-to-anchor chain; a retry-one names the one row it deletes on
   * either shape, so it neither walks nor cuts a tail. Absent on a fork-less
   * conversation, which is the only shape the sequence-scoped delete is safe on.
   */
  readonly forkId?: string | undefined;
  /**
   * The single assistant reply a retry-one deletes. When set it MUST be a direct
   * assistant reply of `targetMessageId`, or the settlement's unscoped
   * `deleteMessagesByIdWithinTx([replaceAssistantId])` would delete an arbitrary
   * message — including a co-member's. Absent for retry-all, and refused
   * alongside `action: 'edit'` by `regenerateTurnBodySchema`: an edit's
   * delete never reads it, so a body carrying both would describe two different
   * deletes.
   */
  readonly replaceAssistantId?: string | undefined;
}

/**
 * The pre-run verdict. `target-missing` (404) and `invalid-replace` (404, the
 * named reply is not a direct assistant reply of the anchor) both reject a bad
 * delete target; `fork-required` rejects a no-forkId regenerate on a conversation
 * that has forks (the linear sequence-delete is unsafe once branches share the
 * sequence space); `blocked` (403) refuses deleting across another member's
 * message, and equally refuses a regenerate whose chain walk cannot prove it
 * reached the anchor. Only `allowed` proceeds to admission.
 */
export type RegenerateDecision =
  | 'allowed'
  | 'blocked'
  | 'target-missing'
  | 'invalid-replace'
  | 'fork-required';

/**
 * Pure walk from `tipMessageId` up to (exclusive of) `targetMessageId` via
 * `parentMessageId`. Returns true — BLOCK — when a `user` message from a
 * DIFFERENT, still-attributed sender sits on that path. An assistant message is
 * skipped (only users intervene); a null `senderId` (a deleted account, scrubbed
 * to null) counts as nobody.
 *
 * Fails CLOSED: the walk must reach the anchor for its verdict to mean
 * anything. A null tip, a null parent pointer, a parent with no row, and a cycle
 * all end it somewhere other than the anchor, leaving it a statement about a
 * prefix of the branch rather than about the branch. Answering "no other user
 * found" from that risks an admitted, paid, streamed run whose delete the
 * settlement then refuses: the tail a fork retry-all or edit deletes is cut
 * from this same tip-to-anchor chain by `regenerableTailIds` but is not that
 * chain — a candidate whose subtree leaves the tail is kept back, and an edit's
 * delete reaches one node further, taking the anchor it replaces — and the
 * settlement re-judges exactly the ids it removes with
 * `deleteSetBlockedByOtherUser` first. So an unfinished walk blocks rather than
 * paying for a run that fence will refuse.
 */
export function regenerateBlockedByOtherUser(
  rows: readonly SenderChainRow[],
  tipMessageId: string | null,
  targetMessageId: string,
  userId: string
): boolean {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const visited = new Set<string>();
  let currentId: string | null = tipMessageId;
  while (currentId !== null && currentId !== targetMessageId) {
    if (visited.has(currentId)) return true;
    visited.add(currentId);
    const message = byId.get(currentId);
    if (message === undefined) return true;
    if (message.senderType === 'user' && message.senderId !== null && message.senderId !== userId) {
      return true;
    }
    currentId = message.parentMessageId;
  }
  return currentId !== targetMessageId;
}

/**
 * The LINEAR retry-all / edit delete set: every row above `deletionAnchorSequence`,
 * plus `alsoDelete` — the root anchor of an edit, which sits AT the boundary
 * rather than above it. This is the ONLY expression that decides which rows that
 * delete removes; the guard judges its output and the settlement deletes its
 * output, so there is no second spelling of the delete-set selection to drift
 * from. The BOUNDARY handed to it is derived twice on purpose — once route-time
 * in the guard, once in the settlement fence — and must stay that way: the fence
 * judges the set built from its OWN boundary, so a drift between the two costs a
 * spurious conflict or an over-block, never an unjudged delete. Collapsing them
 * merges the advisory check into the authority that re-validates it, which is the
 * defence in depth this guard exists to provide.
 */
export function linearDeleteSetIds(
  rows: readonly SenderChainRow[],
  deletionAnchorSequence: number,
  alsoDelete: readonly string[]
): ReadonlySet<string> {
  const doomed = new Set(
    rows.filter((row) => row.sequenceNumber > deletionAnchorSequence).map((row) => row.id)
  );
  for (const id of alsoDelete) doomed.add(id);
  return doomed;
}

/**
 * The delete-set predicate, over whatever set a regenerate is about to remove.
 * Asks of exactly that set whether it holds a message belonging to anyone but
 * the caller — and, in the one clause the set alone misses, whether deleting it
 * would strand a surviving co-member message on a deleted parent
 * (`parentMessageId` is `ON DELETE SET NULL`, so the survivor is detached from
 * the tree rather than destroyed).
 *
 * A caller is identified by the id that persists to `messages.senderId` — a
 * member's user id, a link guest's link id — so a sender always recognises its
 * own rows and never another principal's. An assistant row belongs to nobody,
 * and a scrubbed (null) `senderId` is a deleted account, likewise nobody.
 *
 * The guard runs it on the sequence-scoped arm, over the set `linearDeleteSetIds`
 * produced. The settlement runs this SAME function over the rows it is about to
 * delete on every arm that deletes a set — sequence-scoped and fork tail alike —
 * so no arm's delete can drift from a model of itself.
 */
export function deleteSetBlockedByOtherUser(
  rows: readonly SenderChainRow[],
  doomedIds: ReadonlySet<string>,
  senderId: string
): boolean {
  return rows.some((row) => {
    if (row.senderType !== 'user' || row.senderId === null || row.senderId === senderId) {
      return false;
    }
    return (
      doomedIds.has(row.id) || (row.parentMessageId !== null && doomedIds.has(row.parentMessageId))
    );
  });
}

/**
 * The verdict plus the fork tip the guard observed. The observed tip is carried
 * into the run so the settlement can assert the live tip still matches what the
 * guard validated its deletable tail against — the fork-tip TOCTOU fence (the
 * tip is mutable by a separate `PUT /tip` route mid-run).
 */
interface RegenerateVerdict {
  readonly decision: RegenerateDecision;
  /** The fork tip read once during the guard; null for a linear regenerate or a tipless fork. */
  readonly observedForkTipId: string | null;
}

function verdict(
  decision: RegenerateDecision,
  observedForkTipId: string | null = null
): RegenerateVerdict {
  return { decision, observedForkTipId };
}

/** The fork's current tip, read once; null for a linear regenerate (no fork). */
function resolveObservedForkTip(
  stores: ConversationsStores,
  params: CanRegenerateParams
): ResultAsync<string | null, DomainError> {
  if (params.forkId === undefined) return okAsync<string | null, DomainError>(null);
  return stores.forks
    .byId(params.conversationId, params.forkId)
    .map((fork) => fork?.tipMessageId ?? null);
}

/**
 * True when `replaceAssistantId` names an assistant message whose parent is
 * exactly the anchor — the only message a retry-one may delete. A missing id, a
 * user message, or a reply of a different anchor is refused before the paid run.
 */
function isDirectAssistantReply(
  rows: readonly SenderChainRow[],
  replaceAssistantId: string,
  targetMessageId: string
): boolean {
  const row = rows.find((candidate) => candidate.id === replaceAssistantId);
  return row?.senderType === 'assistant' && row.parentMessageId === targetMessageId;
}

/**
 * A no-forkId retry-all/edit deletes every message after the anchor's sequence
 * across the whole conversation; forks share one sequence space, so that delete
 * is safe only on a fork-less conversation. Once forks exist the caller must
 * scope the regenerate to a branch so the branch-aware delete runs instead. A
 * supplied forkId already takes that safe path, so the fork read is skipped.
 */
function forkRequired(
  stores: ConversationsStores,
  params: CanRegenerateParams
): ResultAsync<boolean, DomainError> {
  if (params.forkId !== undefined) return okAsync<boolean, DomainError>(false);
  return stores.forks.list(params.conversationId).map((forks) => forks.length > 0);
}

/**
 * The anchor row, but only when `targetMessageId` is the caller's OWN user
 * message. The regenerate/edit anchor must be the caller's own turn: the
 * settlement deletes the anchor's reply(s) — edit/retry-all delete by sequence
 * from the anchor, retry-one deletes its assistant reply — so anchoring on
 * another member's turn, an assistant message, or a scrubbed (null senderId)
 * message would destroy content the caller does not own. The tip→target walk is
 * exclusive of the target, so a foreign anchor passes every other gate; this is
 * the root check. Null — fail closed — if the target is absent from the chain
 * (readers disagreeing).
 */
function ownAnchorRow(
  rows: readonly SenderChainRow[],
  targetMessageId: string,
  userId: string
): SenderChainRow | null {
  const row = rows.find((candidate) => candidate.id === targetMessageId);
  return row?.senderType === 'user' && row.senderId === userId ? row : null;
}

/**
 * The set the LINEAR delete will remove, built through the one derivation the
 * settlement also uses. A retry-all measures from the anchor's own sequence and
 * keeps the anchor; an edit replaces the anchor, so it measures from the
 * anchor's PARENT — or, at a root anchor, from the anchor itself with the anchor
 * appended to the set. Null when the row the delete would measure from is absent
 * from the chain, a reader disagreement the caller turns into a block.
 */
function linearDeleteSet(
  rows: readonly SenderChainRow[],
  anchor: SenderChainRow,
  action: CanRegenerateParams['action']
): ReadonlySet<string> | null {
  if (action === 'edit' && anchor.parentMessageId !== null) {
    const parentSequence = rows.find((row) => row.id === anchor.parentMessageId)?.sequenceNumber;
    return parentSequence === undefined ? null : linearDeleteSetIds(rows, parentSequence, []);
  }
  return linearDeleteSetIds(rows, anchor.sequenceNumber, action === 'edit' ? [anchor.id] : []);
}

/**
 * The linear retry-all / edit verdict: the delete's own predicate, run over the
 * delete's own set. The ancestry walk cannot serve this arm — it proves a
 * property of one path while the delete sweeps a sequence range, and a
 * re-parented subtree sits inside that range and off every path.
 */
function linearDeleteVerdict(
  rows: readonly SenderChainRow[],
  anchor: SenderChainRow,
  params: CanRegenerateParams,
  observedForkTipId: string | null
): RegenerateVerdict {
  const doomedIds = linearDeleteSet(rows, anchor, params.action);
  const blocked = doomedIds === null || deleteSetBlockedByOtherUser(rows, doomedIds, params.userId);
  return verdict(blocked ? 'blocked' : 'allowed', observedForkTipId);
}

function guardWithObservedForkTip(
  stores: ConversationsStores,
  params: CanRegenerateParams
): ResultAsync<RegenerateVerdict, DomainError> {
  return resolveObservedForkTip(stores, params).andThen((observedForkTipId) =>
    evaluateRegenerateArm(stores, params, observedForkTipId)
  );
}

/**
 * The FORK retry-all / edit verdict: the ancestry walk from the observed tip.
 * The walk is this delete's own geometry — `regenerableTailIds` draws the tail
 * from the same tip-to-anchor chain — so on a retry-all, a walk that reaches the
 * anchor has read every row that delete can remove. An edit cuts its tail from
 * the anchor's PARENT instead, so that tail can also carry the anchor: the row
 * the walk terminates on without reading, and the one row the ownership gate
 * above has already proved is the caller's own. The walk runs on every fork
 * regenerate, because an active-member count bounds nothing here: a member who
 * left, was removed, or had their share link revoked keeps their
 * `messages.senderId`, and their rows sit on the chain the tail is cut from.
 *
 * A tipless fork is the exception, and not a walk that failed: with no tip
 * there is no chain, so `regenerableTailIds` yields an empty tail and the only
 * other id a fork delete carries — the root anchor of an edit — is the caller's
 * own by the ownership gate above.
 */
function forkTailVerdict(
  rows: readonly SenderChainRow[],
  params: CanRegenerateParams,
  observedForkTipId: string | null
): RegenerateVerdict {
  if (observedForkTipId === null) return verdict('allowed', null);
  return verdict(
    regenerateBlockedByOtherUser(rows, observedForkTipId, params.targetMessageId, params.userId)
      ? 'blocked'
      : 'allowed',
    observedForkTipId
  );
}

function evaluateRegenerateArm(
  stores: ConversationsStores,
  params: CanRegenerateParams,
  observedForkTipId: string | null
): ResultAsync<RegenerateVerdict, DomainError> {
  // The sender chain serves the ownership gate on every regenerate, the
  // retry-one replace-target validity, the delete-set predicate and the walk.
  return stores.messages.senderChainRows(params.conversationId).andThen((rows) => {
    // Ownership gate: the anchor must be the caller's own user message. Without
    // it a member could anchor on another member's turn and have the settlement
    // destroy the replies under it — a sequence range on the fork-less arm, a
    // branch tail on a fork, the named reply on a retry-one.
    const anchor = ownAnchorRow(rows, params.targetMessageId, params.userId);
    if (anchor === null) {
      return okAsync<RegenerateVerdict, DomainError>(verdict('blocked', observedForkTipId));
    }
    if (
      params.replaceAssistantId !== undefined &&
      !isDirectAssistantReply(rows, params.replaceAssistantId, params.targetMessageId)
    ) {
      return okAsync<RegenerateVerdict, DomainError>(verdict('invalid-replace', observedForkTipId));
    }
    // Retry-one deletes exactly `replaceAssistantId`: one assistant row, owned
    // by no principal, held by `isDirectAssistantReply` to a direct reply of the
    // caller's own anchor. A co-member's message parented on it is detached by
    // the FK's own `ON DELETE SET NULL` and re-attached to the replacement,
    // with its content unchanged and its thread position moved. That
    // cross-member effect is accepted; the alternative to re-attaching is an
    // orphan.
    // The `action` half of the test is what keeps this arm and the settlement's
    // graft dispatch on the same body: that dispatch reads `action` first and
    // sends every edit to the delete its shape implies — a sequence range or a
    // fork tail — so an edit answered here would be an admitted, paid run whose
    // delete the settlement fence then refuses.
    if (params.action === 'retry' && params.replaceAssistantId !== undefined) {
      return okAsync<RegenerateVerdict, DomainError>(verdict('allowed', observedForkTipId));
    }
    // The sequence-scoped arm: a fork-less retry-all or edit. It reaches the
    // delete-set predicate with nothing in front of it — the settlement fence
    // judges every row whose sender is a different principal, so a check the
    // fence does not share would let the guard allow what the fence refuses.
    if (params.forkId === undefined) {
      return okAsync<RegenerateVerdict, DomainError>(
        linearDeleteVerdict(rows, anchor, params, observedForkTipId)
      );
    }
    return okAsync<RegenerateVerdict, DomainError>(
      forkTailVerdict(rows, params, observedForkTipId)
    );
  });
}

/**
 * Whether the caller may regenerate/edit from `targetMessageId`. The target must
 * belong to the conversation (`target-missing` → 404); a no-forkId regenerate on
 * a forked conversation is refused (`fork-required`); a retry-one's
 * `replaceAssistantId` must be a direct assistant reply of the anchor
 * (`invalid-replace` → 404); a group regenerate must not delete across another
 * member's message (`blocked` → 403); otherwise `allowed`. Reads only — the
 * regenerate's writes are the settlement's. Returns the verdict plus the fork
 * tip the guard observed (the settlement's TOCTOU fence — see RegenerateVerdict).
 */
export function canRegenerate(
  stores: ConversationsStores,
  params: CanRegenerateParams
): ResultAsync<RegenerateVerdict, DomainError> {
  return stores.messages
    .inConversation(params.targetMessageId, params.conversationId)
    .andThen((present): ResultAsync<RegenerateVerdict, DomainError> => {
      if (!present) return okAsync<RegenerateVerdict, DomainError>(verdict('target-missing'));
      return forkRequired(stores, params).andThen((required) =>
        required
          ? okAsync<RegenerateVerdict, DomainError>(verdict('fork-required'))
          : guardWithObservedForkTip(stores, params)
      );
    });
}
