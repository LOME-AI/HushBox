import { z } from 'zod';
import {
  MAX_CONVERSATION_MEMBERS,
  MemberPrivilege,
  canManageLinks,
  canSendMessages,
  fromBase64,
  sharedMessageResponseSchema,
  toBase64,
} from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { resolveCallerMember } from './caller.js';
import { contentItemView } from '../messages/content-item-view.js';
import { isVisibleAtFloor } from '../epochs/epoch-visibility.js';
import { refusalSchema } from '../outcomes.js';
import { applyRotation, epochRowId, planEpochWraps } from '../epochs/rotation.js';
import { refuseLiveSeatKey } from '../members/members.js';
import type { SharedContentItemResponse, SharedMessageResponse } from '@hushbox/shared';
import type { ConversationCaller } from './caller.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type {
  ContentItemRow,
  ConversationRecord,
  ConversationsStores,
  MessageHeader,
  SharedLinkRecord,
  SharedMessageRecord,
} from '../../ports/index.js';
import type { Outcome, Refusal } from '../outcomes.js';
import type { PlannedWrap } from '../epochs/rotation.js';
import type { RotationBody } from '../schemas.js';

/**
 * Shares: a shared LINK is a public, revocable/expiring window into a
 * conversation, minted and revoked by link-managing members (its own
 * machinery, below). A shared MESSAGE is a STANDALONE artifact: a member
 * exposes one message's wrapped content key (wrapped client-side to a fresh
 * share secret carried only in the URL fragment) as an independent
 * `shared_messages` row, read by its own share id — no link, no guest member,
 * no epoch rotation. The unauthenticated public read returns exactly that one
 * message and its content items and leaks nothing else: no membership, no
 * other messages, no conversation title, no epoch or private key material.
 */

const sharedLinkViewSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  /** The link guest's seated privilege — the sidebar groups links by it. */
  privilege: MemberPrivilege,
  revokedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

type SharedLinkView = z.infer<typeof sharedLinkViewSchema>;

/**
 * Privilege is carried alongside the record rather than on it, and it is always
 * the privilege the guest member row HOLDS: a fresh mint passes what it just
 * seated, a re-mint reads the live seat, and the list read joins it. What the
 * caller asked for is never what is reported.
 */
function sharedLinkView(record: SharedLinkRecord, privilege: MemberPrivilege): SharedLinkView {
  return {
    id: record.id,
    displayName: record.displayName,
    privilege,
    revokedAt: record.revokedAt === null ? null : record.revokedAt.toISOString(),
    expiresAt: record.expiresAt === null ? null : record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}

export const createLinkOutcomeSchema = z.union([
  z.object({
    link: sharedLinkViewSchema,
    created: z.literal(true),
    /** The seated link-guest member's id — the `member:added` broadcast payload. */
    memberId: z.string(),
    /** The new epoch when the mint rotated; null on the full-history path. */
    newEpochNumber: z.number().int().nullable(),
  }),
  z.object({ link: sharedLinkViewSchema, created: z.literal(false) }),
  refusalSchema,
]);

type CreateLinkOutcome = z.infer<typeof createLinkOutcomeSchema>;

interface CreateSharedLinkParams {
  readonly conversationId: string;
  readonly callerUserId: string;
  /** Base64 client-generated public key; decoded here and opaque to the API. */
  readonly linkPublicKey: string;
  /** Base64 hash of the link auth token, computed by the minting client. */
  readonly linkAuthHash: string;
  readonly displayName: string | null;
  /** ISO instant or null; stored as-is and enforced lazily at read. */
  readonly expiresAt: string | null;
  /** Stored on the guest member row (`shared_links` has no privilege column). */
  readonly privilege: MemberPrivilege;
  readonly giveFullHistory: boolean;
  /** Full-history path: ECIES wrap of the current epoch key to the link key. */
  readonly memberWrap?: string | undefined;
  /** Full-history path: the epoch the `memberWrap` was built for. */
  readonly expectedEpoch?: number | undefined;
  /** Rotation path: departure-style rotation that also seats the link key. */
  readonly rotation?: RotationBody | undefined;
}

/** The seated-link facts a created mint surfaces for broadcasting; or a refusal. */
type MintedLink = { readonly link: SharedLinkView; readonly memberId: string } | Refusal;

/**
 * Refusal-before-write: every gate — membership/privilege, cross-conversation
 * conflict, member limit, stale epoch, wrap-set — runs before the first write.
 * The mint takes the conversation `FOR UPDATE` (uniform lock order, epoch
 * freshness) and re-reads the caller's membership `FOR SHARE` so a concurrent
 * removal serializes against it. A minted link seats a real guest member
 * (epoch-wrapped, read/write): a `giveFullHistory` mint wraps the current
 * epoch key to the link key; a rotation mint rotates the epoch, seating the
 * link key in the new wrap set. The client-generated `linkPublicKey` is the
 * natural idempotency guard — a re-mint of an existing key converges on the
 * existing (already-seated) link only when it carries the same auth hash, and
 * anyone else's key answers 409. Key and hash derive from one link secret, so a
 * mismatched pair is forged, and converging on it would report success for a
 * link whose URL cannot authenticate.
 */
export function createSharedLink(
  stores: ConversationsStores,
  params: CreateSharedLinkParams
): ResultAsync<CreateLinkOutcome, DomainError> {
  const linkPublicKey = fromBase64(params.linkPublicKey);
  const linkAuthHash = fromBase64(params.linkAuthHash);
  const expiresAt = params.expiresAt === null ? null : new Date(params.expiresAt);
  return stores.conversations.lockForUpdate(params.conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<CreateLinkOutcome>({ refusal: 'not-found' });
    const ctx: MintCtx = { stores, params, conversation, linkPublicKey, linkAuthHash, expiresAt };
    return stores.members
      .lockActiveByUser(params.conversationId, params.callerUserId)
      .andThen((caller) => {
        if (caller === null) return okAsync<CreateLinkOutcome>({ refusal: 'not-found' });
        if (!canManageLinks(caller.privilege)) {
          return okAsync<CreateLinkOutcome>({ refusal: 'forbidden' });
        }
        return stores.sharedLinks.byPublicKey(linkPublicKey).andThen((existing) => {
          if (existing === null) return admitNewLink(ctx);
          // Idempotent re-mint: the guest member and wraps already exist from
          // the first mint, so nothing is written. A foreign key, or this key
          // under another hash, answers 409.
          if (
            existing.conversationId !== params.conversationId ||
            toBase64(existing.linkAuthHash) !== toBase64(linkAuthHash)
          ) {
            return okAsync<CreateLinkOutcome>({ refusal: 'conflict' });
          }
          return convergeOnLiveLink(ctx, existing);
        });
      });
  });
}

/**
 * The re-mint of a key this conversation already holds. Convergence is on the
 * LIVE seat: the guest member row carries the privilege actually in force, which
 * is what the response reports. A link with no live seat (revoked, or its guest
 * gone) is treated as absent and the mint path runs instead — where the unique
 * `linkPublicKey` refuses it, so a dead link is never revived and never reported
 * as freshly issued. A caller wanting a live link generates a new key.
 */
function convergeOnLiveLink(
  ctx: MintCtx,
  existing: SharedLinkRecord
): ResultAsync<CreateLinkOutcome, DomainError> {
  return ctx.stores.members
    .activeLinkGuest(ctx.params.conversationId, existing.id)
    .andThen((guest) =>
      guest === null
        ? admitNewLink(ctx)
        : okAsync<CreateLinkOutcome>({
            link: sharedLinkView(existing, guest.member.privilege),
            created: false,
          })
    );
}

/** The bundled inputs a new-link seat needs, threaded through the seating paths. */
interface MintCtx {
  readonly stores: ConversationsStores;
  readonly params: CreateSharedLinkParams;
  readonly conversation: ConversationRecord;
  readonly linkPublicKey: Uint8Array;
  readonly linkAuthHash: Uint8Array;
  readonly expiresAt: Date | null;
}

/** Seat-key and member-limit gates, then the chosen seating path. */
function admitNewLink(ctx: MintCtx): ResultAsync<CreateLinkOutcome, DomainError> {
  const { stores, params, linkPublicKey } = ctx;
  return refuseLiveSeatKey(stores, params.conversationId, linkPublicKey).andThen((collision) => {
    if (collision !== null) return okAsync<CreateLinkOutcome>(collision);
    return stores.members.countActive(params.conversationId).andThen((count) => {
      if (count >= MAX_CONVERSATION_MEMBERS) {
        return okAsync<CreateLinkOutcome>({
          refusal: 'member-limit',
          limit: MAX_CONVERSATION_MEMBERS,
        });
      }
      return params.giveFullHistory ? mintFullHistory(ctx) : mintWithRotation(ctx);
    });
  });
}

/** Full-history seat: wrap the current epoch key to the link key, no rotation. */
function mintFullHistory(ctx: MintCtx): ResultAsync<CreateLinkOutcome, DomainError> {
  const { stores, params, conversation, linkPublicKey } = ctx;
  if (params.memberWrap === undefined || params.expectedEpoch === undefined) {
    return okAsync<CreateLinkOutcome>({ refusal: 'validation' });
  }
  const memberWrap = params.memberWrap;
  if (params.expectedEpoch !== conversation.currentEpoch) {
    return okAsync<CreateLinkOutcome>({
      refusal: 'stale-epoch',
      currentEpoch: conversation.currentEpoch,
    });
  }
  return stores.epochs
    .byNumber(params.conversationId, conversation.currentEpoch)
    .andThen((epoch) => {
      if (epoch === null) {
        throw new Error('conversations: current epoch row missing for link mint');
      }
      return insertLinkAndMember(ctx, 1).andThen((minted) => {
        if ('refusal' in minted) return okAsync<CreateLinkOutcome>(minted);
        // Any wrap the key already holds here carries another seat's floor; the
        // full-history seat replaces it, as the full-history member add does.
        return stores.epochs
          .deleteWrapsForKeys(params.conversationId, [linkPublicKey])
          .andThen(() =>
            stores.epochs.insertWraps([
              {
                epochId: epoch.id,
                memberPublicKey: linkPublicKey,
                wrap: fromBase64(memberWrap),
                visibleFromEpoch: 1,
              },
            ])
          )
          .map(
            (): CreateLinkOutcome => ({
              link: minted.link,
              created: true,
              memberId: minted.memberId,
              newEpochNumber: null,
            })
          );
      });
    });
}

/** Rotation seat: rotate the epoch, seating the link key in the new wrap set. */
function mintWithRotation(ctx: MintCtx): ResultAsync<CreateLinkOutcome, DomainError> {
  const { stores, params, conversation, linkPublicKey } = ctx;
  if (params.rotation === undefined) return okAsync<CreateLinkOutcome>({ refusal: 'validation' });
  const rotation = params.rotation;
  if (rotation.expectedEpoch !== conversation.currentEpoch) {
    return okAsync<CreateLinkOutcome>({
      refusal: 'stale-epoch',
      currentEpoch: conversation.currentEpoch,
    });
  }
  const newEpochNumber = rotation.expectedEpoch + 1;
  return stores.members.activeVisibilityByKey(params.conversationId).andThen((visibility) => {
    const withLink = new Map(visibility);
    withLink.set(toBase64(linkPublicKey), newEpochNumber);
    const plan = planEpochWraps(withLink, rotation.memberWraps);
    if (plan === null) return okAsync<CreateLinkOutcome>({ refusal: 'wrap-set-mismatch' });
    return insertLinkAndMember(ctx, newEpochNumber).andThen((minted) => {
      if ('refusal' in minted) return okAsync<CreateLinkOutcome>(minted);
      return epochRowId(stores, params.conversationId, rotation.expectedEpoch)
        .andThen((predecessorEpochId) =>
          applyRotation(stores, {
            conversationId: params.conversationId,
            rotation,
            plan,
            predecessorEpochId,
            // The guest's wrap is seated at the new epoch, so its title must be too.
            writeTitle: true,
          })
        )
        .map(
          (rotated): CreateLinkOutcome => ({
            link: minted.link,
            created: true,
            memberId: minted.memberId,
            newEpochNumber: rotated.newEpochNumber,
          })
        );
    });
  });
}

/**
 * Inserts the link row (natural-key idempotent) then seats its guest member.
 * A null insert means another row already holds the public key or the auth
 * hash: a concurrent mint of the same key won the race under another
 * conversation's lock, or a new key carries a hash another link holds. Both are
 * answered as a conflict; a null member insert is a defect (the link id is
 * brand new under our lock).
 */
function insertLinkAndMember(
  ctx: MintCtx,
  visibleFromEpoch: number
): ResultAsync<MintedLink, DomainError> {
  const { stores, params, linkPublicKey, linkAuthHash, expiresAt } = ctx;
  return stores.sharedLinks
    .insert({
      conversationId: params.conversationId,
      linkPublicKey,
      linkAuthHash,
      displayName: params.displayName,
      expiresAt,
      createdBy: params.callerUserId,
    })
    .andThen((inserted) => {
      if (inserted === null) return okAsync<MintedLink>({ refusal: 'conflict' });
      return stores.members
        .insertLinkMember({
          conversationId: params.conversationId,
          linkId: inserted.id,
          privilege: params.privilege,
          visibleFromEpoch,
        })
        .map((member): MintedLink => {
          if (member === null) {
            throw new Error('conversations: link member insert lost under the conversation lock');
          }
          return { link: sharedLinkView(inserted, params.privilege), memberId: member.id };
        });
    });
}

interface ListLinksResult {
  readonly links: SharedLinkView[];
}

/** Any active member may see the conversation's links; management is a separate gate. */
export function listSharedLinks(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly caller: ConversationCaller }
): ResultAsync<Outcome<ListLinksResult>, DomainError> {
  return resolveCallerMember(stores, params.conversationId, params.caller).andThen((caller) => {
    if (caller === null) return okAsync<Outcome<ListLinksResult>>({ refusal: 'not-found' });
    return stores.sharedLinks
      .listForConversation(params.conversationId)
      .map((rows) => ({ links: rows.map((row) => sharedLinkView(row, row.privilege)) }));
  });
}

export const revokeLinkOutcomeSchema = z.union([
  z.object({
    revoked: z.literal(true),
    /** The departed guest member's id, or null when the link had no member. */
    memberId: z.string().nullable(),
    newEpochNumber: z.number().int(),
    evicteePrincipalIds: z.array(z.string()),
  }),
  /** An already-revoked link, by any path: nothing is written. */
  z.object({ revoked: z.literal(true), alreadyRevoked: z.literal(true) }),
  refusalSchema,
]);

type RevokeLinkOutcome = z.infer<typeof revokeLinkOutcomeSchema>;

interface RevokeSharedLinkParams {
  readonly conversationId: string;
  readonly linkId: string;
  readonly callerUserId: string;
  readonly rotation: RotationBody;
}

/**
 * Revoking a link is a member departure: under the conversation `FOR UPDATE`
 * lock, it flips `revokedAt`, marks the guest member left (the media presign
 * member-path gate), and rotates the epoch out of the revoked link — the remaining
 * members re-wrap to a key the guest never held. Every gate (membership,
 * not-found, stale epoch, wrap-set) precedes the first write. An already-revoked
 * link answers `alreadyRevoked` and writes nothing, whichever path revoked it.
 * Only this path rotates at revoke: after an admin revoke or the creator's
 * account deletion the conversation stays rotation-pending until a member's
 * maintenance rotation, which a repeated revoke here does not perform.
 */
export function revokeSharedLink(
  stores: ConversationsStores,
  params: RevokeSharedLinkParams
): ResultAsync<RevokeLinkOutcome, DomainError> {
  const { conversationId, linkId, callerUserId, rotation } = params;
  return stores.conversations.lockForUpdate(conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<RevokeLinkOutcome>({ refusal: 'not-found' });
    return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
      if (caller === null) return okAsync<RevokeLinkOutcome>({ refusal: 'not-found' });
      if (!canManageLinks(caller.privilege)) {
        return okAsync<RevokeLinkOutcome>({ refusal: 'forbidden' });
      }
      return stores.sharedLinks.byId(linkId).andThen((link) => {
        if (link === null) return okAsync<RevokeLinkOutcome>({ refusal: 'not-found' });
        if (link.conversationId !== conversationId) {
          return okAsync<RevokeLinkOutcome>({ refusal: 'not-found' });
        }
        if (link.revokedAt !== null) {
          return okAsync<RevokeLinkOutcome>({ revoked: true, alreadyRevoked: true });
        }
        if (rotation.expectedEpoch !== conversation.currentEpoch) {
          return okAsync<RevokeLinkOutcome>({
            refusal: 'stale-epoch',
            currentEpoch: conversation.currentEpoch,
          });
        }
        return executeRevoke(stores, params, conversation.ownerUserId === callerUserId);
      });
    });
  });
}

/** The gated revoke writes: plan the remaining wrap set, then apply. */
function executeRevoke(
  stores: ConversationsStores,
  params: RevokeSharedLinkParams,
  callerIsOwner: boolean
): ResultAsync<RevokeLinkOutcome, DomainError> {
  return planLinkDeparture(stores, params.conversationId, params.linkId, params.rotation).andThen(
    (plan) =>
      plan === null
        ? okAsync<RevokeLinkOutcome>({ refusal: 'wrap-set-mismatch' })
        : applyRevokeWrites(stores, params, plan, callerIsOwner)
  );
}

/** Flip `revokedAt`, mark the guest left, rotate the epoch out of the revoked link. */
function applyRevokeWrites(
  stores: ConversationsStores,
  params: RevokeSharedLinkParams,
  plan: readonly PlannedWrap[],
  callerIsOwner: boolean
): ResultAsync<RevokeLinkOutcome, DomainError> {
  const { conversationId, linkId, rotation } = params;
  return stores.sharedLinks
    .revoke({ conversationId, linkId })
    .andThen((revoked) => {
      if (revoked === null) {
        throw new Error('conversations: revoke matched no row under the conversation lock');
      }
      return stores.members.markLeftByLink({ conversationId, linkId });
    })
    .andThen((left) =>
      epochRowId(stores, conversationId, rotation.expectedEpoch)
        .andThen((predecessorEpochId) =>
          applyRotation(stores, {
            conversationId,
            rotation,
            plan,
            predecessorEpochId,
            writeTitle: callerIsOwner,
          })
        )
        .map(
          (rotated): RevokeLinkOutcome => ({
            revoked: true,
            memberId: left?.id ?? null,
            newEpochNumber: rotated.newEpochNumber,
            evicteePrincipalIds: [linkId],
          })
        )
    );
}

/** The remaining-members wrap plan: authoritative key set minus the revoked link. */
function planLinkDeparture(
  stores: ConversationsStores,
  conversationId: string,
  linkId: string,
  rotation: RotationBody
): ResultAsync<PlannedWrap[] | null, DomainError> {
  return stores.members.activeKeysOrdered(conversationId).map((keys) => {
    const remaining = new Map<string, number>();
    for (const key of keys) {
      if (key.linkId === linkId) continue;
      remaining.set(toBase64(key.publicKey), key.visibleFromEpoch);
    }
    return planEpochWraps(remaining, rotation.memberWraps);
  });
}

const adminRevokeLinkOutcomeSchema = z.union([
  z.object({
    revoked: z.literal(true),
    /** The departed guest member's id, or null when the link seated no active guest. */
    memberId: z.string().nullable(),
    /** Principal ids for best-effort live-socket eviction (the link id). */
    evicteePrincipalIds: z.array(z.string()),
  }),
  /** An already-revoked link: the first revoke departed the guest; this replays. */
  z.object({ revoked: z.literal(true), alreadyRevoked: z.literal(true) }),
  refusalSchema,
]);

type AdminRevokeLinkOutcome = z.infer<typeof adminRevokeLinkOutcomeSchema>;

// Literal arms only, so no reachable value can fail a runtime check and this
// shape carries no construction-time parse — unlike {@link AdminRevokeLinkOutcome},
// whose `memberId` comes from a row. Give an arm a data-carrying field and the
// parse comes back with it.
type AdminUnrevokeLinkOutcome = Outcome<
  /** `alreadyLive`: nothing to clear; this replays as a no-op. */
  { unrevoked: true; alreadyLive: true } | { unrevoked: true }
>;

export interface AdminSharedLinkParams {
  readonly conversationId: string;
  readonly linkId: string;
}

/**
 * Admin-engine share-link revoke — AUTHORIZATION-ONLY revocation, a deliberate
 * founder-settled deviation from the member path (`revokeSharedLink`): it
 * flips `revokedAt` (the public read paths enforce it lazily) and marks the
 * link's guest member left (the media presign gate keys on `leftAt`, never
 * `revokedAt`), but it does NOT rotate the epoch — admins hold no key
 * material. The guest's current-epoch wrap is left behind, so the conversation
 * turns rotation-pending and nothing new is encrypted to that epoch until a
 * remaining member's client rotates the link key out. There is likewise
 * no member-privilege gate and no rotation body: the caller is the admin
 * engine, authorized upstream. The conversation `FOR UPDATE` lock is the same
 * discipline the member path takes, so admin and member revokes serialize.
 * Idempotent: an already-revoked link is a safe no-op (`alreadyRevoked`).
 */
export function adminRevokeSharedLink(
  stores: ConversationsStores,
  params: AdminSharedLinkParams
): ResultAsync<AdminRevokeLinkOutcome, DomainError> {
  const { conversationId, linkId } = params;
  return stores.conversations.lockForUpdate(conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<AdminRevokeLinkOutcome>({ refusal: 'not-found' });
    return stores.sharedLinks.byId(linkId).andThen((link) => {
      if (link?.conversationId !== conversationId) {
        return okAsync<AdminRevokeLinkOutcome>({ refusal: 'not-found' });
      }
      if (link.revokedAt !== null) {
        return okAsync<AdminRevokeLinkOutcome>({ revoked: true, alreadyRevoked: true });
      }
      return stores.sharedLinks
        .revoke({ conversationId, linkId })
        .andThen((revoked) => {
          if (revoked === null) {
            throw new Error(
              'conversations: admin revoke matched no row under the conversation lock'
            );
          }
          return stores.members.markLeftByLink({ conversationId, linkId });
        })
        .map(
          // Validated where it is built: the schema is this payload's runtime
          // invariant, and a shape it does not declare is a server defect
          // (a throw), never a refusal the caller could act on.
          (left): AdminRevokeLinkOutcome =>
            adminRevokeLinkOutcomeSchema.parse({
              revoked: true,
              memberId: left?.id ?? null,
              evicteePrincipalIds: [linkId],
            })
        );
    });
  });
}

/**
 * Admin-engine unrevoke — the inverse of the authorization flip ONLY: it
 * clears `revokedAt` and writes nothing else. The guest member departed by
 * the revoke stays left; the guest re-enters through the normal link flow (a
 * link-managing member re-mints, seating a fresh guest member), never through
 * this write. Same conversation `FOR UPDATE` discipline as revoke.
 * Idempotent: unrevoking a live link is a safe no-op (`alreadyLive`).
 */
export function adminUnrevokeSharedLink(
  stores: ConversationsStores,
  params: AdminSharedLinkParams
): ResultAsync<AdminUnrevokeLinkOutcome, DomainError> {
  const { conversationId, linkId } = params;
  return stores.conversations.lockForUpdate(conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<AdminUnrevokeLinkOutcome>({ refusal: 'not-found' });
    return stores.sharedLinks.byId(linkId).andThen((link) => {
      if (link?.conversationId !== conversationId) {
        return okAsync<AdminUnrevokeLinkOutcome>({ refusal: 'not-found' });
      }
      if (link.revokedAt === null) {
        return okAsync<AdminUnrevokeLinkOutcome>({ unrevoked: true, alreadyLive: true });
      }
      return stores.sharedLinks
        .unrevoke({ conversationId, linkId })
        .map((cleared): AdminUnrevokeLinkOutcome => {
          if (cleared === null) {
            throw new Error(
              'conversations: admin unrevoke matched no row under the conversation lock'
            );
          }
          return { unrevoked: true };
        });
    });
  });
}

export const changeLinkPrivilegeOutcomeSchema = z.union([
  z.object({
    changed: z.literal(true),
    /** The affected guest member's id — the `member:privilege-changed` payload; null when the link seats no active guest. */
    memberId: z.string().nullable(),
  }),
  refusalSchema,
]);

type ChangeLinkPrivilegeOutcome = z.infer<typeof changeLinkPrivilegeOutcomeSchema>;

/**
 * Admin-driven link privilege change. The privilege's single source of truth is
 * the link's guest MEMBER row (not a `shared_links` column), so this updates
 * that row and never rotates keys (a privilege change does not revoke access).
 * Not-found is keyed on the LINK: a missing, foreign, or revoked link answers
 * the same 404 as a live link with no active guest member would — except the
 * latter is a real (idempotent) change with a null member id.
 */
export function changeLinkPrivilege(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly callerUserId: string;
    readonly linkId: string;
    readonly privilege: MemberPrivilege;
  }
): ResultAsync<ChangeLinkPrivilegeOutcome, DomainError> {
  const { conversationId, callerUserId, linkId, privilege } = params;
  return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
    if (caller === null) return okAsync<ChangeLinkPrivilegeOutcome>({ refusal: 'not-found' });
    if (!canManageLinks(caller.privilege)) {
      return okAsync<ChangeLinkPrivilegeOutcome>({ refusal: 'forbidden' });
    }
    return stores.sharedLinks.byId(linkId).andThen((link) => {
      if (link?.conversationId !== conversationId || link.revokedAt !== null) {
        return okAsync<ChangeLinkPrivilegeOutcome>({ refusal: 'not-found' });
      }
      return stores.members
        .updatePrivilegeByLink({ conversationId, linkId, privilege })
        .map(
          (member): ChangeLinkPrivilegeOutcome => ({ changed: true, memberId: member?.id ?? null })
        );
    });
  });
}

export const changeLinkNameOutcomeSchema = z.union([
  z.object({ success: z.literal(true) }),
  refusalSchema,
]);

type ChangeLinkNameOutcome = z.infer<typeof changeLinkNameOutcomeSchema>;

/**
 * Admin-driven link display-name change. Gated on the link-management ladder
 * (admin+), then a conditional write to a live link; a missing, foreign, or
 * revoked link answers not-found.
 */
export function changeLinkName(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly callerUserId: string;
    readonly linkId: string;
    readonly displayName: string;
  }
): ResultAsync<ChangeLinkNameOutcome, DomainError> {
  const { conversationId, callerUserId, linkId, displayName } = params;
  return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
    if (caller === null) return okAsync<ChangeLinkNameOutcome>({ refusal: 'not-found' });
    if (!canManageLinks(caller.privilege)) {
      return okAsync<ChangeLinkNameOutcome>({ refusal: 'forbidden' });
    }
    return stores.sharedLinks
      .updateDisplayName({ conversationId, linkId, displayName })
      .map(
        (updated): ChangeLinkNameOutcome => (updated ? { success: true } : { refusal: 'not-found' })
      );
  });
}

export const createSharedMessageOutcomeSchema = z.union([
  z.object({ shareId: z.string() }),
  refusalSchema,
]);

type CreateSharedMessageOutcome = z.infer<typeof createSharedMessageOutcomeSchema>;

/**
 * A member shares one message from a conversation they belong to as a
 * standalone artifact. The caller's active membership is taken `FOR SHARE`
 * (a concurrent removal cannot slip between the guard and the insert), then
 * gates run in a fixed order: membership, send privilege, the caller's
 * epoch floor, and authorship. Publishing to the open internet is a write
 * act, so a read-privilege member is refused it. The privilege gate runs
 * BEFORE the message read so its `forbidden` never depends on whether the
 * message exists; a non-member, a foreign message and a message from before
 * the caller joined all answer the same uniform not-found, which is what
 * keeps the refusal from disclosing that the message exists. Authorship runs
 * after the floor gate, so it only ever judges a message the caller can
 * already read: a member publishes only their own words or the model's,
 * never another member's. The row is stamped with `createdBy` so a creator's hard deletion severs their shares by FK
 * cascade; there is no link, epoch, or membership state on the share itself.
 */
export function createSharedMessage(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly callerUserId: string;
    readonly messageId: string;
    /** Base64 wrap of the message content key under the share secret; decoded here, opaque to the API. */
    readonly wrappedContentKey: string;
  }
): ResultAsync<CreateSharedMessageOutcome, DomainError> {
  const wrappedContentKey = fromBase64(params.wrappedContentKey);
  return stores.members
    .lockActiveByUser(params.conversationId, params.callerUserId)
    .andThen((caller) => {
      if (caller === null) return okAsync<CreateSharedMessageOutcome>({ refusal: 'not-found' });
      if (!canSendMessages(caller.privilege)) {
        return okAsync<CreateSharedMessageOutcome>({ refusal: 'forbidden' });
      }
      return stores.messages
        .headerInConversation(params.messageId, params.conversationId)
        .andThen((header) => {
          if (header === null || !isVisibleAtFloor(header.epochNumber, caller.visibleFromEpoch)) {
            return okAsync<CreateSharedMessageOutcome>({ refusal: 'not-found' });
          }
          if (!isShareableBy(header, params.callerUserId)) {
            return okAsync<CreateSharedMessageOutcome>({ refusal: 'forbidden' });
          }
          return stores.sharedMessages
            .insert({
              messageId: params.messageId,
              createdBy: params.callerUserId,
              wrappedContentKey,
            })
            .map((inserted): CreateSharedMessageOutcome => ({ shareId: inserted.id }));
        });
    });
}

/**
 * A model-written message is shareable by any member; a human-written one only
 * by its own sender. A user message whose sender was erased, and a system
 * message, belong to no caller and are shareable by none.
 */
function isShareableBy(header: MessageHeader, callerUserId: string): boolean {
  if (header.senderType === 'assistant') return true;
  return header.senderType === 'user' && header.senderId === callerUserId;
}

/**
 * The public standalone-message share's wire shape, declared in
 * `@hushbox/shared`; this annotation is what makes a field rename there a
 * compile error here. `conversationId`, `epochNumber`, `senderId` and
 * `epochWrappedContentKey` are the AAD inputs each content item's envelope was
 * sealed with — without them the visitor holds the right key and still cannot
 * open the blob, because the AEAD tag covers them.
 */
type SharedMessageView = SharedMessageResponse;

/**
 * The unauthenticated public read, scoped by share id. Returns exactly that
 * one shared message and its content items; a missing id answers not-found.
 * Standalone shares carry no revoke or expiry, so there is no lazy predicate
 * here — the endpoint discloses nothing about any other message.
 */
export function readSharedMessage(
  stores: ConversationsStores,
  params: { readonly shareId: string }
): ResultAsync<Outcome<SharedMessageView>, DomainError> {
  return stores.sharedMessages.byId(params.shareId).map((share): Outcome<SharedMessageView> => {
    if (share === null) return { refusal: 'not-found' };
    return sharedMessageView(share);
  });
}

/**
 * Validated where it is built: the schema is this view's runtime invariant, and
 * a shape it does not declare is a server defect (a throw), never a refusal the
 * unauthenticated reader could act on. The `satisfies` is not redundant with
 * that parse — `parse` takes `unknown`, so without it a field renamed in the
 * shared schema would compile here and fail per request instead.
 */
function sharedMessageView(row: SharedMessageRecord): SharedMessageView {
  return sharedMessageResponseSchema.parse({
    shareId: row.id,
    messageId: row.messageId,
    wrappedContentKey: toBase64(row.wrappedContentKey),
    createdAt: row.createdAt.toISOString(),
    messageCreatedAt: row.messageCreatedAt.toISOString(),
    conversationId: row.conversationId,
    epochNumber: row.epochNumber,
    senderId: row.senderId,
    epochWrappedContentKey: toBase64(row.epochWrappedContentKey),
    deleted: row.deletedAt !== null,
    contentItems: row.contentItems.map((item) => sharedContentItemView(item)),
  } satisfies SharedMessageView);
}

/**
 * The public read's content item: the slim base view plus the generating model,
 * the smart-model flag, and the reasoning rung and token count, so a shared
 * reply names its model and reads its reasoning exactly as its author's does.
 * The billed cost stays on the authenticated history read.
 */
type SharedContentItemView = SharedContentItemResponse;

function sharedContentItemView(row: ContentItemRow): SharedContentItemView {
  return {
    ...contentItemView(row),
    modelName: row.modelId,
    isSmartModel: row.isSmartModel,
    reasoningTokens: row.reasoningTokens,
    reasoningEffort: row.reasoningEffort,
    reasoningDurationMs: row.reasoningDurationMs,
  };
}
