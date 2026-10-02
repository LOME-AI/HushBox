import { z } from 'zod';
import {
  createConversationResponseSchema,
  fromBase64,
  toBase64,
  trimPage,
  updateConversationResponseSchema,
} from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { resolveCallerMember } from './shares/caller.js';
import { visibleForkViews } from './forks/forks.js';
import { refusalSchema } from './outcomes.js';
import { assertNoPendingDeparture } from './epochs/pending.js';
import type {
  ConversationListItem,
  ConversationResponse,
  GetConversationResponse,
  ListConversationsResponse,
  MembershipView,
} from '@hushbox/shared';
import type { ConversationCaller } from './shares/caller.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { ConversationRecord, ConversationsStores, MemberRecord } from '../ports/index.js';
import type { Outcome } from './outcomes.js';

const DEFAULT_PAGE_LIMIT = 50;

/**
 * The serialized conversation record. Aliased to the shared wire contract
 * (`@hushbox/shared`), whose `conversationResponseSchema` is also what this
 * slice's conversation outcome unions replay-validate against — one
 * declaration, so a field rename there is a compile error in this serializer.
 */
type ConversationView = ConversationResponse;

function conversationView(record: ConversationRecord): ConversationView {
  return {
    id: record.id,
    title: toBase64(record.title),
    titleEpochNumber: record.titleEpochNumber,
    currentEpoch: record.currentEpoch,
    nextSequence: record.nextSequence,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function membershipView(member: MemberRecord): MembershipView {
  return {
    privilege: member.privilege,
    linkId: member.linkId,
    muted: member.muted,
    pinned: member.pinned,
    accepted: member.acceptedAt !== null,
    visibleFromEpoch: member.visibleFromEpoch,
    // The read cursor is a bigint column bounded by `messages.sequence_number`
    // (int4), so this narrowing is exact.
    lastReadSeq: Number(member.lastReadSeq),
  };
}

export const createConversationOutcomeSchema = z.union([
  createConversationResponseSchema,
  refusalSchema,
]);

type CreateConversationOutcome = z.infer<typeof createConversationOutcomeSchema>;

interface CreateConversationParams {
  readonly callerUserId: string;
  readonly id: string;
  readonly title?: string | undefined;
  readonly epochPublicKey: string;
  readonly confirmationHash: string;
  readonly memberWrap: string;
}

/**
 * The epoch-1 bootstrap: conversation row, epoch 1 (chain root —
 * `previousEpochId` null), the owner's wrap, and the owner membership, all
 * inside the caller's transaction. The conversation id is client-generated;
 * the PK conflict arbitrates retries — losing the insert converges on the
 * existing record for the same owner and refuses anyone else's id.
 */
export function createConversation(
  stores: ConversationsStores,
  params: CreateConversationParams
): ResultAsync<CreateConversationOutcome, DomainError> {
  const title = params.title === undefined ? new Uint8Array(0) : fromBase64(params.title);
  return stores.conversations
    .insert({ id: params.id, ownerUserId: params.callerUserId, title })
    .andThen((inserted) => {
      if (inserted === null) return convergeOnExisting(stores, params);
      return stores.users.byId(params.callerUserId).andThen((owner) => {
        if (owner === null) ownerRowMissing(params.callerUserId);
        return stores.epochs
          .insert({
            conversationId: params.id,
            epochNumber: 1,
            previousEpochId: null,
            epochPublicKey: fromBase64(params.epochPublicKey),
            confirmationHash: fromBase64(params.confirmationHash),
            chainLink: null,
          })
          .andThen((epoch) =>
            stores.epochs.insertWraps([
              {
                epochId: epoch.id,
                memberPublicKey: owner.publicKey,
                wrap: fromBase64(params.memberWrap),
                visibleFromEpoch: 1,
              },
            ])
          )
          .andThen(() =>
            stores.members.insert({
              conversationId: params.id,
              userId: params.callerUserId,
              privilege: 'owner',
              visibleFromEpoch: 1,
              acceptedAt: new Date(),
              invitedByUserId: null,
            })
          )
          .map(
            (): CreateConversationOutcome => ({
              conversation: conversationView(inserted),
              created: true,
            })
          );
      });
    });
}

/** A session principal without a users row is a referential-integrity defect. */
function ownerRowMissing(userId: string): never {
  throw new Error(`conversations: no users row for authenticated principal ${userId}`);
}

function convergeOnExisting(
  stores: ConversationsStores,
  params: CreateConversationParams
): ResultAsync<CreateConversationOutcome, DomainError> {
  return stores.conversations.get(params.id).map((existing): CreateConversationOutcome => {
    if (existing?.ownerUserId !== params.callerUserId) {
      // Existence is not leaked: a foreign id and a just-deleted own id
      // answer the same way.
      return { refusal: 'conflict' };
    }
    return { conversation: conversationView(existing), created: false };
  });
}

export function getConversation(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly caller: ConversationCaller }
): ResultAsync<Outcome<GetConversationResponse>, DomainError> {
  return resolveCallerMember(stores, params.conversationId, params.caller).andThen((member) =>
    member === null
      ? okAsync<Outcome<GetConversationResponse>>({ refusal: 'not-found' })
      : loadConversationView(stores, params.conversationId, member)
  );
}

/** The success path: the conversation record plus its branch set, or not-found. */
function loadConversationView(
  stores: ConversationsStores,
  conversationId: string,
  member: MemberRecord
): ResultAsync<Outcome<GetConversationResponse>, DomainError> {
  return stores.conversations.get(conversationId).andThen((record) => {
    if (record === null) return okAsync<Outcome<GetConversationResponse>>({ refusal: 'not-found' });
    return stores.forks.list(conversationId).map(
      (forks): Outcome<GetConversationResponse> => ({
        conversation: conversationView(record),
        membership: membershipView(member),
        forks: visibleForkViews(forks, member.visibleFromEpoch),
      })
    );
  });
}

function encodeCursor(row: { readonly updatedAt: Date; readonly id: string }): string {
  return toBase64(
    new TextEncoder().encode(JSON.stringify({ updatedAt: row.updatedAt.toISOString(), id: row.id }))
  );
}

const cursorSchema = z.object({ updatedAt: z.iso.datetime(), id: z.uuid() });

function decodeCursor(cursor: string): { updatedAt: Date; id: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64(cursor)));
    // eslint-disable-next-line catch-swallow/no-silent-catch -- an undecodable cursor is a stale client pointer, returning an empty page (documented legacy behavior).
  } catch {
    return null;
  }
  const result = cursorSchema.safeParse(parsed);
  if (!result.success) return null;
  return { updatedAt: new Date(result.data.updatedAt), id: result.data.id };
}

export function listConversations(
  stores: ConversationsStores,
  params: { readonly callerUserId: string; readonly limit?: number; readonly cursor?: string }
): ResultAsync<ListConversationsResponse, DomainError> {
  const limit = params.limit ?? DEFAULT_PAGE_LIMIT;
  let cursor: { updatedAt: Date; id: string } | null = null;
  if (params.cursor !== undefined) {
    cursor = decodeCursor(params.cursor);
    // An undecodable cursor is a stale client pointer, not an attack surface:
    // answer the empty page (legacy behavior) instead of guessing an offset.
    if (cursor === null) return okAsync({ conversations: [], nextCursor: null });
  }
  return stores.conversations
    .listForUser({ userId: params.callerUserId, limit: limit + 1, cursor })
    .map((rows) => {
      const { page, hasMore } = trimPage(rows, limit);
      const last = page.at(-1);
      return {
        conversations: page.map(
          (row): ConversationListItem => ({
            ...conversationView(row.conversation),
            privilege: row.privilege,
            muted: row.muted,
            pinned: row.pinned,
            accepted: row.acceptedAt !== null,
            invitedByUsername: row.invitedByUsername,
            lastReadSeq: Number(row.lastReadSeq),
            memberCount: row.memberCount,
          })
        ),
        nextCursor:
          hasMore && last !== undefined
            ? encodeCursor({ updatedAt: last.conversation.updatedAt, id: last.conversation.id })
            : null,
      };
    });
}

export const updateTitleOutcomeSchema = z.union([updateConversationResponseSchema, refusalSchema]);

type UpdateTitleOutcome = z.infer<typeof updateTitleOutcomeSchema>;

interface UpdateTitleParams {
  readonly conversationId: string;
  readonly callerUserId: string;
  /** Opaque ciphertext (base64); decoded here, never inspected. */
  readonly title: string;
  readonly titleEpochNumber: number;
}

/**
 * Owner-only title write. The conditional UPDATE on (id, ownerUserId, and the
 * epoch the title names) is the only ownership check — never check-then-act —
 * and its 0-row outcome is disambiguated by reading the row back: gone is
 * not-found, present but not owned is forbidden, and owned means the one
 * remaining arm failed, so the client named an epoch this conversation has
 * none of. A title at the current epoch is new ciphertext a departed seat could
 * open, so the owner's write there waits while a departure is pending; the
 * `FOR UPDATE` lock holds the epoch still until the write commits.
 */
export function updateConversationTitle(
  stores: ConversationsStores,
  params: UpdateTitleParams
): ResultAsync<UpdateTitleOutcome, DomainError> {
  return stores.conversations
    .lockForUpdate(params.conversationId)
    .andThen((locked) => titleEpochGate(stores, locked, params))
    .andThen(() =>
      stores.conversations.updateTitle({
        conversationId: params.conversationId,
        ownerUserId: params.callerUserId,
        title: fromBase64(params.title),
        titleEpochNumber: params.titleEpochNumber,
      })
    )
    .andThen((updated) => {
      if (updated !== null) {
        return okAsync<UpdateTitleOutcome, DomainError>({
          conversation: conversationView(updated),
        });
      }
      return stores.conversations.get(params.conversationId).map((record): UpdateTitleOutcome => {
        if (record === null) return { refusal: 'not-found' };
        return record.ownerUserId === params.callerUserId
          ? { refusal: 'validation' }
          : { refusal: 'forbidden' };
      });
    });
}

/** Only the owner's write at the current epoch can be new ciphertext to a pending epoch. */
function titleEpochGate(
  stores: ConversationsStores,
  locked: ConversationRecord | null,
  params: UpdateTitleParams
): ResultAsync<void, DomainError> {
  if (
    locked?.ownerUserId !== params.callerUserId ||
    locked.currentEpoch !== params.titleEpochNumber
  ) {
    return okAsync();
  }
  return assertNoPendingDeparture(stores, params.conversationId);
}

export const deleteConversationOutcomeSchema = z.union([
  z.object({ deleted: z.literal(true), evicteePrincipalIds: z.array(z.string()) }),
  refusalSchema,
]);

type DeleteConversationOutcome = z.infer<typeof deleteConversationOutcomeSchema>;

/**
 * Hard deletion (privacy doctrine): the conditional DELETE on
 * (id, ownerUserId) is the only owner check — never check-then-act. The
 * active principal ids are read first, inside the same transaction, because
 * after the cascade there is nobody left to enumerate for eviction.
 */
export function deleteConversation(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly callerUserId: string }
): ResultAsync<DeleteConversationOutcome, DomainError> {
  return stores.members
    .activeByUser(params.conversationId, params.callerUserId)
    .andThen((member) => {
      if (member === null) {
        return okAsync<DeleteConversationOutcome, DomainError>({ refusal: 'not-found' });
      }
      return stores.members
        .activePrincipalIds(params.conversationId)
        .andThen((principalIds) => executeOwnedDelete(stores, params, principalIds));
    });
}

/** The conditional owner-only DELETE plus its zero-row disambiguation read. */
function executeOwnedDelete(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly callerUserId: string },
  principalIds: string[]
): ResultAsync<DeleteConversationOutcome, DomainError> {
  return stores.conversations
    .deleteOwned({
      conversationId: params.conversationId,
      ownerUserId: params.callerUserId,
    })
    .andThen((deleted) => {
      if (deleted) {
        return okAsync<DeleteConversationOutcome, DomainError>({
          deleted: true,
          evicteePrincipalIds: principalIds,
        });
      }
      return stores.conversations
        .get(params.conversationId)
        .map(
          (record): DeleteConversationOutcome =>
            record === null ? { refusal: 'not-found' } : { refusal: 'forbidden' }
        );
    });
}
