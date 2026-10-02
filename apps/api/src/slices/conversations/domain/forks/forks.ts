import { z } from 'zod';
import { MAX_FORKS_PER_CONVERSATION, canSendMessages, forkResponseSchema } from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { isVisibleAtFloor } from '../epochs/epoch-visibility.js';
import { buildParentIndex, exclusiveMessageIds } from './parent-chain.js';
import { isRefusal, refusalSchema } from '../outcomes.js';
import type { ForkResponse } from '@hushbox/shared';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type {
  ConversationsStores,
  ForkListRecord,
  ForkRecord,
  MemberRecord,
} from '../../ports/index.js';
import type { Outcome, Refusal } from '../outcomes.js';

/**
 * The chat slice's message deleter, injected into fork deletion. Conversations
 * owns the delete DECISION (which messages are exclusive to the deleted branch);
 * chat owns the `messages` table (single-writer), so the actual DELETE is
 * composed through this callback inside the fork-delete transaction. The
 * `conversationId` scopes the delete defensively — the deleter can never touch
 * a message outside the conversation whose fork is being deleted.
 */
export type ForkMessageDeleter = (
  conversationId: string,
  ids: readonly string[]
) => ResultAsync<void, DomainError>;

/**
 * Fork semantics (mirrors the legacy service, minus message deletion — the
 * chat slice owns `messages`, so orphan cleanup on fork deletion is its
 * concern via the published parent-chain walk):
 *
 * - The first branch materializes the implicit linear history as a "Main"
 *   fork tipped at the latest message, alongside the requested fork.
 * - Fork ids are client-generated uuids: a re-create of the same id
 *   converges instead of duplicating.
 * - Deleting down to one remaining fork reverts the conversation to linear
 *   (all fork rows removed).
 *
 * Every mutation runs under the conversation `FOR UPDATE` lock so limit
 * checks and the two-row first-branch insert never race; refusals commit
 * (they ride the success channel), so every check precedes the first write.
 */

/** The reserved name of the implicit linear-history fork. */
const MAIN_FORK_NAME = 'Main';

const AUTO_NAME_PATTERN = /^Fork (\d+)$/;

/**
 * The serialized fork. Aliased to the shared wire contract
 * (`@hushbox/shared`), whose `forkResponseSchema` is also what this slice's
 * fork outcome unions replay-validate against — one declaration, so a field
 * rename there is a compile error in this serializer.
 */
type ForkView = ForkResponse;

function forkView(record: ForkRecord): ForkView {
  return {
    id: record.id,
    name: record.name,
    tipMessageId: record.tipMessageId,
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * The listed forks: those whose tip message the caller may see. A fork
 * branching below the caller's floor is dropped entirely rather than shown
 * with its tip blanked, because the tip identifier is the whole disclosure.
 * A tipless fork carries no identifier and stays listed. Every gate that
 * needs the WHOLE fork set — the per-conversation limit, the name
 * pre-checks, the delete's orphan walk and its drop-to-linear count — reads
 * the unfiltered rows, so a floored caller can never mint a duplicate name
 * or collapse a branch it cannot see.
 */
export function visibleForkViews(
  rows: readonly ForkListRecord[],
  visibleFromEpoch: number
): ForkView[] {
  return rows
    .filter(
      (row) => row.tipEpochNumber === null || isVisibleAtFloor(row.tipEpochNumber, visibleFromEpoch)
    )
    .map((row) => forkView(row));
}

/** "Fork N" with N one past the highest existing auto-name. */
export function nextAutoName(existingNames: readonly string[]): string {
  let maxNumber = 0;
  for (const name of existingNames) {
    const matched = AUTO_NAME_PATTERN.exec(name);
    const parsed = matched?.[1] === undefined ? Number.NaN : Number.parseInt(matched[1], 10);
    if (!Number.isNaN(parsed) && parsed > maxNumber) maxNumber = parsed;
  }
  return `Fork ${String(maxNumber + 1)}`;
}

/** The write gate's verdict: the seated caller, or the refusal that stops them. */
function forkWriteGate(caller: MemberRecord | null): MemberRecord | Refusal {
  if (caller === null) return { refusal: 'not-found' };
  if (!canSendMessages(caller.privilege)) return { refusal: 'forbidden' };
  return caller;
}

/**
 * The shared prelude of every fork mutation: take the conversation `FOR
 * UPDATE` lock, gate on the caller's write privilege, then run the operation
 * under that serialization.
 */
function underForkWriteGate<S>(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly callerUserId: string },
  run: (caller: MemberRecord) => ResultAsync<Outcome<S>, DomainError>
): ResultAsync<Outcome<S>, DomainError> {
  return stores.conversations.lockForUpdate(params.conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<Outcome<S>>({ refusal: 'not-found' });
    return stores.members
      .activeByUser(params.conversationId, params.callerUserId)
      .andThen((caller) => {
        const gate = forkWriteGate(caller);
        if (isRefusal(gate)) return okAsync<Outcome<S>>(gate);
        return run(gate);
      });
  });
}

export function listForks(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly callerUserId: string }
): ResultAsync<Outcome<{ forks: ForkView[] }>, DomainError> {
  return stores.members
    .activeByUser(params.conversationId, params.callerUserId)
    .andThen((caller) => {
      if (caller === null) {
        return okAsync<Outcome<{ forks: ForkView[] }>>({ refusal: 'not-found' });
      }
      return stores.forks
        .list(params.conversationId)
        .map((rows) => ({ forks: visibleForkViews(rows, caller.visibleFromEpoch) }));
    });
}

/**
 * `created` is the row this request inserted, null when a re-create of the
 * same id converged on an existing fork. It is stated separately from `forks`
 * because that list is floored to what the caller may see: a caller who
 * branches from a message below their own floor creates a fork the list
 * withholds from them, and the created row is the only honest answer to
 * "what did this request do".
 */
export const createForkOutcomeSchema = z.union([
  z.object({ forks: z.array(forkResponseSchema), created: forkResponseSchema.nullable() }),
  refusalSchema,
]);

type CreateForkOutcome = z.infer<typeof createForkOutcomeSchema>;

interface CreateForkParams {
  readonly conversationId: string;
  readonly callerUserId: string;
  readonly id: string;
  readonly fromMessageId: string;
  readonly name?: string | undefined;
}

export function createFork(
  stores: ConversationsStores,
  params: CreateForkParams
): ResultAsync<CreateForkOutcome, DomainError> {
  const { conversationId, id, fromMessageId } = params;
  return underForkWriteGate(stores, params, (caller) =>
    stores.forks.byId(conversationId, id).andThen((existing) => {
      // Convergence is conversation-scoped on purpose: `id` is the table's
      // GLOBAL primary key, so a hit in another conversation cannot converge —
      // returning that row would disclose a fork the caller may not see. The
      // insert's 'id-taken' answers `conflict` for that case instead.
      if (existing !== null) {
        return convergedForks(stores, conversationId, caller.visibleFromEpoch, null);
      }
      return stores.messages.inConversation(fromMessageId, conversationId).andThen((inConv) => {
        if (!inConv) return okAsync<CreateForkOutcome>({ refusal: 'not-found' });
        return planForkInsert(stores, params, caller.visibleFromEpoch);
      });
    })
  );
}

/** Limit + name gates over the locked fork set, then the matching insert path. */
function planForkInsert(
  stores: ConversationsStores,
  params: CreateForkParams,
  visibleFromEpoch: number
): ResultAsync<CreateForkOutcome, DomainError> {
  const { conversationId, id, fromMessageId } = params;
  return stores.forks.list(conversationId).andThen((forks) => {
    if (forks.length >= MAX_FORKS_PER_CONVERSATION) {
      return okAsync<CreateForkOutcome>({
        refusal: 'fork-limit',
        limit: MAX_FORKS_PER_CONVERSATION,
      });
    }
    const name = params.name ?? nextAutoName(forks.map((fork) => fork.name));
    // Name collisions refuse BEFORE any insert: a unique-violation inside
    // the byKey transaction would abort it wholesale (25P02 on the key-row
    // flip), and the conversation lock makes this pre-check race-free —
    // every fork-name writer takes it.
    if (forks.some((fork) => fork.name === name)) {
      return okAsync<CreateForkOutcome>({ refusal: 'fork-name-taken' });
    }
    return forks.length === 0
      ? insertFirstForks(stores, { conversationId, id, name, fromMessageId }, visibleFromEpoch)
      : insertAdditionalFork(stores, { conversationId, id, name, fromMessageId }, visibleFromEpoch);
  });
}

interface InsertForkParams {
  readonly conversationId: string;
  readonly id: string;
  readonly name: string;
  readonly fromMessageId: string;
}

/**
 * The requested branch's insert outcome when it is not a row. A name collision
 * is impossible under the conversation lock (every fork-name writer takes it and
 * the pre-check ran beneath it), so it is a defect; an id collision is the
 * client-minted identifier already used by some other conversation's fork, which
 * is the `conflict` refusal. Shared by both insert paths: the two must answer a
 * reused id identically, and a copy that lost this line would answer a store
 * failure instead.
 */
function forkInsertRefusal(outcome: 'name-taken' | 'id-taken'): CreateForkOutcome {
  if (outcome === 'name-taken') {
    throw new Error('conversations: fork name collided under the conversation lock');
  }
  return { refusal: 'conflict' };
}

/**
 * Materializes the requested fork plus "Main" (tipped at the latest message).
 * The requested branch is inserted FIRST so its refusals write nothing —
 * refusals commit, and Main inserted ahead of one would survive it. The
 * creation-ordered list still opens with Main: the two rows carry explicit
 * `createdAt` stamps rather than taking their order from the inserts. The
 * requested name is pre-checked against the reserved Main name because a
 * request for it would leave Main's own insert raising a unique violation,
 * which aborts the transaction instead of refusing.
 */
function insertFirstForks(
  stores: ConversationsStores,
  params: InsertForkParams,
  visibleFromEpoch: number
): ResultAsync<CreateForkOutcome, DomainError> {
  const { conversationId, id, name, fromMessageId } = params;
  if (name === MAIN_FORK_NAME) return okAsync<CreateForkOutcome>({ refusal: 'fork-name-taken' });
  return stores.messages.latestId(conversationId).andThen((mainTip) => {
    const now = new Date();
    return stores.forks
      .insert({
        id,
        conversationId,
        name,
        tipMessageId: fromMessageId,
        // Strictly after Main so the creation-ordered list keeps Main first.
        createdAt: new Date(now.getTime() + 1),
      })
      .andThen((inserted) => {
        if (typeof inserted === 'string') return okAsync(forkInsertRefusal(inserted));
        return stores.forks
          .insert({
            id: null,
            conversationId,
            name: MAIN_FORK_NAME,
            tipMessageId: mainTip,
            createdAt: now,
          })
          .andThen((main) => {
            // Matched by VALUE, not by `typeof`: the outcome is a broken state
            // invariant rather than a type fault, and a `typeof` guard obliges
            // the throw to be a TypeError.
            if (main === 'name-taken' || main === 'id-taken') {
              // Main's id is server-minted, and its name is free: this branch is
              // reached only with an EMPTY fork set read under the conversation
              // lock, and the reserved-name pre-check keeps the requested branch
              // off that name.
              throw new Error('conversations: Main fork collided in an empty fork set');
            }
            return convergedForks(stores, conversationId, visibleFromEpoch, inserted);
          });
      });
  });
}

function insertAdditionalFork(
  stores: ConversationsStores,
  params: InsertForkParams,
  visibleFromEpoch: number
): ResultAsync<CreateForkOutcome, DomainError> {
  const { conversationId, id, name, fromMessageId } = params;
  return stores.forks
    .insert({ id, conversationId, name, tipMessageId: fromMessageId })
    .andThen((inserted) => {
      if (typeof inserted === 'string') return okAsync(forkInsertRefusal(inserted));
      return convergedForks(stores, conversationId, visibleFromEpoch, inserted);
    });
}

function convergedForks(
  stores: ConversationsStores,
  conversationId: string,
  visibleFromEpoch: number,
  created: ForkRecord | null
): ResultAsync<CreateForkOutcome, DomainError> {
  return stores.forks.list(conversationId).map((rows) => ({
    forks: visibleForkViews(rows, visibleFromEpoch),
    created: created === null ? null : forkView(created),
  }));
}

export const renameForkOutcomeSchema = z.union([
  z.object({ fork: forkResponseSchema }),
  refusalSchema,
]);

type RenameForkOutcome = z.infer<typeof renameForkOutcomeSchema>;

export function renameFork(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly forkId: string;
    readonly callerUserId: string;
    readonly name: string;
  }
): ResultAsync<RenameForkOutcome, DomainError> {
  const { conversationId, forkId, name } = params;
  return underForkWriteGate(stores, params, () =>
    stores.forks.list(conversationId).andThen((forks) => {
      // Pre-checked under the conversation lock (see planForkInsert): a
      // unique-violation inside the byKey transaction would abort it.
      // Renaming a fork to its own current name stays a legal no-op.
      if (forks.some((fork) => fork.name === name && fork.id !== forkId)) {
        return okAsync<RenameForkOutcome>({ refusal: 'fork-name-taken' });
      }
      return stores.forks
        .rename({ conversationId, forkId, name })
        .map((renamed): RenameForkOutcome => {
          if (renamed === 'name-taken') {
            throw new Error('conversations: fork rename collided under the conversation lock');
          }
          if (renamed === null) return { refusal: 'not-found' };
          return { fork: forkView(renamed) };
        });
    })
  );
}

export const updateForkTipOutcomeSchema = z.union([
  z.object({ fork: forkResponseSchema }),
  refusalSchema,
]);

type UpdateForkTipOutcome = z.infer<typeof updateForkTipOutcomeSchema>;

interface UpdateForkTipParams {
  readonly conversationId: string;
  readonly forkId: string;
  readonly callerUserId: string;
  readonly tipMessageId: string;
  readonly expectedTipMessageId: string | null;
}

/**
 * The fork-tip CAS: the store's conditional UPDATE
 * (`WHERE tipMessageId IS NOT DISTINCT FROM expected`) is the winner-picker;
 * a zero-row outcome is disambiguated by re-reading the fork — gone is
 * not-found, moved is a conflict carrying the authoritative tip.
 */
export function updateForkTip(
  stores: ConversationsStores,
  params: UpdateForkTipParams
): ResultAsync<UpdateForkTipOutcome, DomainError> {
  const { conversationId, tipMessageId } = params;
  return underForkWriteGate(stores, params, () =>
    stores.messages.inConversation(tipMessageId, conversationId).andThen((inConv) => {
      if (!inConv) return okAsync<UpdateForkTipOutcome>({ refusal: 'not-found' });
      return casForkTip(stores, params);
    })
  );
}

/** The conditional tip write plus its zero-row disambiguation read. */
function casForkTip(
  stores: ConversationsStores,
  params: UpdateForkTipParams
): ResultAsync<UpdateForkTipOutcome, DomainError> {
  const { conversationId, forkId, tipMessageId, expectedTipMessageId } = params;
  return stores.forks
    .updateTip({ conversationId, forkId, expectedTipMessageId, tipMessageId })
    .andThen((updated) => {
      if (updated !== null) {
        return okAsync<UpdateForkTipOutcome>({ fork: forkView(updated) });
      }
      return stores.forks
        .byId(conversationId, forkId)
        .map(
          (fork): UpdateForkTipOutcome =>
            fork === null
              ? { refusal: 'not-found' }
              : { refusal: 'fork-tip-conflict', currentTipMessageId: fork.tipMessageId }
        );
    });
}

export const deleteForkOutcomeSchema = z.union([
  z.object({ forks: z.array(forkResponseSchema) }),
  refusalSchema,
]);

type DeleteForkOutcome = z.infer<typeof deleteForkOutcomeSchema>;

export function deleteFork(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly forkId: string;
    readonly callerUserId: string;
  },
  deleteMessages: ForkMessageDeleter
): ResultAsync<DeleteForkOutcome, DomainError> {
  const { conversationId, forkId } = params;
  return underForkWriteGate(stores, params, (caller) =>
    stores.forks.list(conversationId).andThen((forks) => {
      const target = forks.find((fork) => fork.id === forkId);
      // Converged idempotently: a retry after the row is already gone deletes
      // no messages (the first call's cleanup already ran).
      if (target === undefined) {
        return remainingForksAfterDelete(stores, conversationId, caller.visibleFromEpoch);
      }
      const survivingTips = forks
        .filter((fork) => fork.id !== forkId)
        .map((fork) => fork.tipMessageId);
      return deleteExclusiveMessages(stores, deleteMessages, {
        conversationId,
        deletedTip: target.tipMessageId,
        survivingTips,
      })
        .andThen(() => stores.forks.remove({ conversationId, forkId }))
        .andThen(() => remainingForksAfterDelete(stores, conversationId, caller.visibleFromEpoch));
    })
  );
}

/**
 * Deletes exactly the messages whose only path to a fork tip runs through the
 * deleted branch — never a shared ancestor (deleting one would null a surviving
 * fork's tip via the `ON DELETE SET NULL` cascade). Runs before the fork row is
 * removed, inside the same transaction.
 */
function deleteExclusiveMessages(
  stores: ConversationsStores,
  deleteMessages: ForkMessageDeleter,
  params: {
    readonly conversationId: string;
    readonly deletedTip: string | null;
    readonly survivingTips: readonly (string | null)[];
  }
): ResultAsync<void, DomainError> {
  return stores.messages.parentChainRows(params.conversationId).andThen((rows) => {
    const orphans = exclusiveMessageIds(
      buildParentIndex(rows),
      params.deletedTip,
      params.survivingTips
    );
    return deleteMessages(params.conversationId, orphans);
  });
}

function remainingForksAfterDelete(
  stores: ConversationsStores,
  conversationId: string,
  visibleFromEpoch: number
): ResultAsync<DeleteForkOutcome, DomainError> {
  return stores.forks.list(conversationId).andThen((remaining) => {
    if (remaining.length === 1) {
      // A single surviving fork is linear history: drop the fork layer.
      return stores.forks.removeAll(conversationId).map((): DeleteForkOutcome => ({ forks: [] }));
    }
    return okAsync<DeleteForkOutcome>({
      forks: visibleForkViews(remaining, visibleFromEpoch),
    });
  });
}
