import { z } from 'zod';
import {
  MAX_CONVERSATION_MEMBERS,
  MEMBER_PRIVILEGES,
  canAddMembers,
  canChangePrivilege,
  canRemoveMember,
  getPrivilegeLevel,
  isOwner,
  fromBase64,
  toBase64,
} from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { resolveCallerMember } from '../shares/caller.js';
import { isRefusal, refusalSchema } from '../outcomes.js';
import { applyRotation, epochRowId, planEpochWraps } from '../epochs/rotation.js';
import type { ConversationCaller } from '../shares/caller.js';
import type { MemberPrivilege } from '@hushbox/shared';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ByTransitionParams } from '../../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { ConversationRecord, ConversationsStores, MemberRecord } from '../../ports/index.js';
import type { Outcome, Refusal } from '../outcomes.js';
import type { AddMemberBody, RotationBody } from '../schemas.js';
import type { PlannedWrap } from '../epochs/rotation.js';

const memberViewSchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  /** The link a guest joined through; null for real user members. The frontend
   * filters link-guest rows out of the member list (they render as links). */
  linkId: z.string().nullable(),
  username: z.string().nullable(),
  privilege: z.enum(MEMBER_PRIVILEGES),
  visibleFromEpoch: z.number().int(),
  joinedAt: z.string(),
  accepted: z.boolean(),
});

type MemberView = z.infer<typeof memberViewSchema>;

export function listMembers(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly caller: ConversationCaller }
): ResultAsync<Outcome<{ members: MemberView[] }>, DomainError> {
  return resolveCallerMember(stores, params.conversationId, params.caller).andThen((caller) => {
    if (caller === null) {
      return okAsync<Outcome<{ members: MemberView[] }>>({ refusal: 'not-found' });
    }
    return stores.members.listActive(params.conversationId).map((rows) => ({
      members: rows.map(
        (row): MemberView => ({
          id: row.id,
          userId: row.userId,
          linkId: row.linkId,
          username: row.username,
          privilege: row.privilege,
          visibleFromEpoch: row.visibleFromEpoch,
          joinedAt: row.joinedAt.toISOString(),
          accepted: row.acceptedAt !== null,
        })
      ),
    }));
  });
}

export const addMemberOutcomeSchema = z.union([
  z.object({ member: memberViewSchema, newEpochNumber: z.number().int().nullable() }),
  refusalSchema,
]);

type AddMemberOutcome = z.infer<typeof addMemberOutcomeSchema>;

interface AddMemberParams {
  readonly conversationId: string;
  readonly callerUserId: string;
  readonly body: AddMemberBody;
}

interface AddContext {
  readonly conversation: ConversationRecord;
  readonly target: {
    readonly id: string;
    readonly username: string;
    readonly publicKey: Uint8Array;
  };
}

/**
 * Refusal-before-write discipline (binding for every byKey flow in this
 * slice): refusals ride the success channel and therefore COMMIT the
 * transaction, so every check — privilege, limit, stale epoch, wrap-set —
 * runs before the first domain write. The `FOR UPDATE` conversation lock
 * taken up front keeps those reads authoritative until commit.
 */
export function addMember(
  stores: ConversationsStores,
  params: AddMemberParams
): ResultAsync<AddMemberOutcome, DomainError> {
  const { conversationId, callerUserId, body } = params;
  return stores.conversations.lockForUpdate(conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<AddMemberOutcome>({ refusal: 'not-found' });
    return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
      const gate = addPrivilegeGate(caller, body);
      if (gate !== null) return okAsync<AddMemberOutcome>(gate);
      return stores.users.byId(body.userId).andThen((target) => {
        if (target === null) return okAsync<AddMemberOutcome>({ refusal: 'not-found' });
        return admitTarget(stores, params, { conversation, target });
      });
    });
  });
}

/**
 * No two live seats of a conversation share a public key. Seating a key takes
 * over that key's wraps in the conversation — a full-history seat deletes them,
 * a rotation re-seats them — so a key some live seat already holds is refused
 * before any write, whoever asks and whether it arrives as an account key or a
 * link key. A departed seat's key is free to be seated again.
 */
export function refuseLiveSeatKey(
  stores: ConversationsStores,
  conversationId: string,
  publicKey: Uint8Array
): ResultAsync<Refusal | null, DomainError> {
  return stores.members
    .activeVisibilityByKey(conversationId)
    .map((visibility): Refusal | null =>
      visibility.has(toBase64(publicKey)) ? { refusal: 'conflict' } : null
    );
}

/** Duplicate-membership, seat-key and member-limit gates, then the chosen add path. */
function admitTarget(
  stores: ConversationsStores,
  params: AddMemberParams,
  context: AddContext
): ResultAsync<AddMemberOutcome, DomainError> {
  const { conversationId, body } = params;
  return stores.members.activeByUser(conversationId, context.target.id).andThen((existing) => {
    if (existing !== null) return okAsync<AddMemberOutcome>({ refusal: 'already-member' });
    return refuseLiveSeatKey(stores, conversationId, context.target.publicKey).andThen(
      (collision) => {
        if (collision !== null) return okAsync<AddMemberOutcome>(collision);
        return stores.members.countActive(conversationId).andThen((count) => {
          if (count >= MAX_CONVERSATION_MEMBERS) {
            return okAsync<AddMemberOutcome>({
              refusal: 'member-limit',
              limit: MAX_CONVERSATION_MEMBERS,
            });
          }
          return body.giveFullHistory
            ? addWithFullHistory(stores, params, context)
            : addWithRotation(stores, params, context);
        });
      }
    );
  });
}

function addPrivilegeGate(caller: MemberRecord | null, body: AddMemberBody): Refusal | null {
  if (caller === null) return { refusal: 'not-found' };
  if (!canAddMembers(caller.privilege)) return { refusal: 'forbidden' };
  // The grant must sit strictly below the granter: an admin can never mint
  // another admin, and owner stays unreachable (also excluded by schema).
  if (getPrivilegeLevel(body.privilege) >= getPrivilegeLevel(caller.privilege)) {
    return { refusal: 'forbidden' };
  }
  return null;
}

function addedMemberView(
  inserted: { readonly id: string; readonly joinedAt: Date },
  context: AddContext,
  body: AddMemberBody,
  visibleFromEpoch: number
): MemberView {
  return {
    id: inserted.id,
    userId: context.target.id,
    // Add-member seats a real user member; a link-guest is seated by the shares path.
    linkId: null,
    username: context.target.username,
    privilege: body.privilege,
    visibleFromEpoch,
    joinedAt: inserted.joinedAt.toISOString(),
    accepted: false,
  };
}

function addWithFullHistory(
  stores: ConversationsStores,
  params: AddMemberParams,
  context: AddContext
): ResultAsync<AddMemberOutcome, DomainError> {
  const { conversationId, callerUserId, body } = params;
  if (body.wrap === undefined || body.expectedEpoch === undefined) {
    return okAsync<AddMemberOutcome>({ refusal: 'validation' });
  }
  const wrap = body.wrap;
  if (body.expectedEpoch !== context.conversation.currentEpoch) {
    return okAsync<AddMemberOutcome>({
      refusal: 'stale-epoch',
      currentEpoch: context.conversation.currentEpoch,
    });
  }
  return stores.epochs
    .byNumber(conversationId, context.conversation.currentEpoch)
    .andThen((epoch) => {
      if (epoch === null) {
        throw new Error('conversations: current epoch row missing for member add');
      }
      return stores.members
        .insert({
          conversationId,
          userId: context.target.id,
          privilege: body.privilege,
          visibleFromEpoch: 1,
          acceptedAt: null,
          invitedByUserId: callerUserId,
        })
        .andThen((inserted) => {
          if (inserted === null) return okAsync<AddMemberOutcome>({ refusal: 'already-member' });
          // A key that left without a rotation still holds its old wraps, floored
          // at its old seat; the full-history seat replaces them rather than
          // letting the conflict-tolerant insert keep the stale floor.
          return stores.epochs
            .deleteWrapsForKeys(conversationId, [context.target.publicKey])
            .andThen(() =>
              stores.epochs.insertWraps([
                {
                  epochId: epoch.id,
                  memberPublicKey: context.target.publicKey,
                  wrap: fromBase64(wrap),
                  visibleFromEpoch: 1,
                },
              ])
            )
            .map(
              (): AddMemberOutcome => ({
                member: addedMemberView(inserted, context, body, 1),
                newEpochNumber: null,
              })
            );
        });
    });
}

function addWithRotation(
  stores: ConversationsStores,
  params: AddMemberParams,
  context: AddContext
): ResultAsync<AddMemberOutcome, DomainError> {
  const { conversationId, callerUserId, body } = params;
  if (body.rotation === undefined) return okAsync<AddMemberOutcome>({ refusal: 'validation' });
  const rotation = body.rotation;
  if (rotation.expectedEpoch !== context.conversation.currentEpoch) {
    return okAsync<AddMemberOutcome>({
      refusal: 'stale-epoch',
      currentEpoch: context.conversation.currentEpoch,
    });
  }
  const newEpochNumber = rotation.expectedEpoch + 1;
  return stores.members.activeVisibilityByKey(conversationId).andThen((visibility) => {
    const withTarget = new Map(visibility);
    withTarget.set(toBase64(context.target.publicKey), newEpochNumber);
    const plan = planEpochWraps(withTarget, rotation.memberWraps);
    if (plan === null) return okAsync<AddMemberOutcome>({ refusal: 'wrap-set-mismatch' });
    return stores.members
      .insert({
        conversationId,
        userId: context.target.id,
        privilege: body.privilege,
        visibleFromEpoch: newEpochNumber,
        acceptedAt: null,
        invitedByUserId: callerUserId,
      })
      .andThen((inserted) => {
        if (inserted === null) return okAsync<AddMemberOutcome>({ refusal: 'already-member' });
        // The invitee's wrap is seated at the new epoch, so its title must be too.
        return epochRowId(stores, conversationId, rotation.expectedEpoch)
          .andThen((predecessorEpochId) =>
            applyRotation(stores, {
              conversationId,
              rotation,
              plan,
              predecessorEpochId,
              writeTitle: true,
            })
          )
          .map(
            (rotated): AddMemberOutcome => ({
              member: addedMemberView(inserted, context, body, newEpochNumber),
              newEpochNumber: rotated.newEpochNumber,
            })
          );
      });
  });
}

export const removeMemberOutcomeSchema = z.union([
  z.object({
    removed: z.literal(true),
    newEpochNumber: z.number().int(),
    evicteePrincipalIds: z.array(z.string()),
  }),
  refusalSchema,
]);

type RemoveMemberOutcome = z.infer<typeof removeMemberOutcomeSchema>;

interface RemoveMemberParams {
  readonly conversationId: string;
  readonly memberId: string;
  readonly callerUserId: string;
  readonly rotation: RotationBody;
}

/**
 * Membership-lifecycle budget-row removal (BILLING §Group Funding 4): billing's
 * `deleteMemberBudgetWithinTx`, bound by the route into the SAME `byKey`
 * transaction as the departure writes, so the budget row dies atomically with
 * the membership — never a cleanup sweep. Billing stays the single writer of
 * `member_budgets`; this slice only composes the published helper.
 */
type MemberBudgetDeleter = (memberId: string) => ResultAsync<void, DomainError>;

export function removeMember(
  stores: ConversationsStores,
  deleteBudget: MemberBudgetDeleter,
  params: RemoveMemberParams
): ResultAsync<RemoveMemberOutcome, DomainError> {
  const { conversationId, memberId, callerUserId, rotation } = params;
  return stores.conversations.lockForUpdate(conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<RemoveMemberOutcome>({ refusal: 'not-found' });
    return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
      if (caller === null) return okAsync<RemoveMemberOutcome>({ refusal: 'not-found' });
      if (getPrivilegeLevel(caller.privilege) < getPrivilegeLevel('admin')) {
        // Legacy mounted requirePrivilege('admin') on this route, answering the
        // distinct PRIVILEGE_INSUFFICIENT (403) for a below-admin caller.
        return okAsync<RemoveMemberOutcome>({ refusal: 'privilege-insufficient' });
      }
      return stores.members.activeById(conversationId, memberId).andThen((target) => {
        const gate = removalGate(caller, target, callerUserId, conversation);
        if ('refusal' in gate) return okAsync<RemoveMemberOutcome>(gate);
        if (rotation.expectedEpoch !== conversation.currentEpoch) {
          return okAsync<RemoveMemberOutcome>({
            refusal: 'stale-epoch',
            currentEpoch: conversation.currentEpoch,
          });
        }
        return executeRemoval(stores, deleteBudget, params, {
          targetUserId: gate.targetUserId,
          callerIsOwner: conversation.ownerUserId === callerUserId,
        });
      });
    });
  });
}

/** The gated removal writes: the shared departure rotation, shaped for removal. */
function executeRemoval(
  stores: ConversationsStores,
  deleteBudget: MemberBudgetDeleter,
  params: RemoveMemberParams,
  admitted: { readonly targetUserId: string; readonly callerIsOwner: boolean }
): ResultAsync<RemoveMemberOutcome, DomainError> {
  const { targetUserId } = admitted;
  return rotateOutDeparture(stores, deleteBudget, {
    conversationId: params.conversationId,
    memberId: params.memberId,
    leavingUserId: targetUserId,
    rotation: params.rotation,
    callerIsOwner: admitted.callerIsOwner,
  }).map(
    (outcome): RemoveMemberOutcome =>
      isRefusal(outcome)
        ? outcome
        : {
            removed: true,
            newEpochNumber: outcome.newEpochNumber,
            evicteePrincipalIds: [targetUserId],
          }
  );
}

/**
 * The removal's departure write: plan the wrap set minus the removed member,
 * mark the row left, delete their budget row (membership lifecycle owns budget
 * rows — BILLING §Group Funding 4), rotate the epoch — all under the caller's
 * conversation lock.
 */
function rotateOutDeparture(
  stores: ConversationsStores,
  deleteBudget: MemberBudgetDeleter,
  params: {
    readonly conversationId: string;
    readonly memberId: string;
    readonly leavingUserId: string;
    readonly rotation: RotationBody;
    readonly callerIsOwner: boolean;
  }
): ResultAsync<Outcome<{ newEpochNumber: number }>, DomainError> {
  const { conversationId, memberId, leavingUserId, rotation, callerIsOwner } = params;
  return planWithoutUser(stores, conversationId, leavingUserId, rotation).andThen((plan) => {
    if (plan === null) {
      return okAsync<Outcome<{ newEpochNumber: number }>>({ refusal: 'wrap-set-mismatch' });
    }
    return stores.members.markLeft({ conversationId, memberId }).andThen((left) => {
      if (left === null) {
        throw new Error('conversations: active member vanished under the conversation lock');
      }
      return deleteBudget(memberId)
        .andThen(() => epochRowId(stores, conversationId, rotation.expectedEpoch))
        .andThen((predecessorEpochId) =>
          applyRotation(stores, {
            conversationId,
            rotation,
            plan,
            predecessorEpochId,
            writeTitle: callerIsOwner,
          })
        );
    });
  });
}

/** Refusal, or the admitted target's user id (narrowed non-null by the gates). */
function removalGate(
  caller: MemberRecord,
  target: MemberRecord | null,
  callerUserId: string,
  conversation: ConversationRecord
): Refusal | { readonly targetUserId: string } {
  if (target === null) return { refusal: 'not-found' };
  // Link-guest removal travels with link privileges (the shares slice path).
  if (target.userId === null) return { refusal: 'validation' };
  if (target.userId === callerUserId) return { refusal: 'cannot-remove-self' };
  if (isOwner(target.privilege) || target.userId === conversation.ownerUserId) {
    return { refusal: 'cannot-remove-owner' };
  }
  // Legacy answered the distinct PRIVILEGE_INSUFFICIENT (403) when an admin+
  // caller is not strictly senior to the target (e.g. admin cannot remove
  // admin) — the same specific code the non-admin-caller rung above and the
  // sibling privilege-change path use, matching legacy's requirePrivilege('admin').
  if (!canRemoveMember(caller.privilege, target.privilege)) {
    return { refusal: 'privilege-insufficient' };
  }
  return { targetUserId: target.userId };
}

/** The remaining-members wrap plan: authoritative visibility minus the leaver. */
function planWithoutUser(
  stores: ConversationsStores,
  conversationId: string,
  leavingUserId: string,
  rotation: RotationBody
): ResultAsync<PlannedWrap[] | null, DomainError> {
  return stores.users.byId(leavingUserId).andThen((leaving) => {
    if (leaving === null) {
      throw new Error('conversations: users row missing for an active member');
    }
    return stores.members.activeVisibilityByKey(conversationId).map((visibility) => {
      const remaining = new Map(visibility);
      remaining.delete(toBase64(leaving.publicKey));
      return planEpochWraps(remaining, rotation.memberWraps);
    });
  });
}

export const leaveOutcomeSchema = z.union([
  z.object({
    left: z.literal(true),
    /** The leaving member's id — the `member:removed` broadcast payload. */
    memberId: z.string(),
    evicteePrincipalIds: z.array(z.string()),
  }),
  z.object({ deleted: z.literal(true), evicteePrincipalIds: z.array(z.string()) }),
  refusalSchema,
]);

type LeaveOutcome = z.infer<typeof leaveOutcomeSchema>;

interface LeaveParams {
  readonly conversationId: string;
  readonly callerUserId: string;
}

/**
 * The owner's leave is the conversation's hard deletion (legacy semantics:
 * the owner always remains otherwise). Any other member's leave is a pure
 * departure: the row is marked left and nothing is rotated, so the leaver never
 * mints the key meant to exclude them. Their current-epoch wrap stays behind,
 * which is what makes the conversation rotation-pending until a remaining
 * member's client rotates it out.
 */
export function leaveConversation(
  stores: ConversationsStores,
  deleteBudget: MemberBudgetDeleter,
  params: LeaveParams
): ResultAsync<LeaveOutcome, DomainError> {
  const { conversationId, callerUserId } = params;
  return stores.conversations.lockForUpdate(conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<LeaveOutcome>({ refusal: 'not-found' });
    return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
      if (caller === null) return okAsync<LeaveOutcome>({ refusal: 'not-found' });
      if (isOwner(caller.privilege)) return ownerLeave(stores, conversationId, callerUserId);
      return memberLeave(stores, deleteBudget, {
        conversationId,
        callerUserId,
        memberId: caller.id,
      });
    });
  });
}

/** A non-owner's exit: mark the row left and drop its budget row, nothing else. */
function memberLeave(
  stores: ConversationsStores,
  deleteBudget: MemberBudgetDeleter,
  params: LeaveParams & { readonly memberId: string }
): ResultAsync<LeaveOutcome, DomainError> {
  const { conversationId, callerUserId, memberId } = params;
  return stores.members.markLeft({ conversationId, memberId }).andThen((left) => {
    if (left === null) {
      throw new Error('conversations: active member vanished under the conversation lock');
    }
    return deleteBudget(memberId).map(
      (): LeaveOutcome => ({ left: true, memberId, evicteePrincipalIds: [callerUserId] })
    );
  });
}

function ownerLeave(
  stores: ConversationsStores,
  conversationId: string,
  callerUserId: string
): ResultAsync<LeaveOutcome, DomainError> {
  return stores.members.activePrincipalIds(conversationId).andThen((principalIds) =>
    stores.conversations
      .deleteOwned({ conversationId, ownerUserId: callerUserId })
      .map((deleted): LeaveOutcome => {
        if (!deleted) {
          throw new Error(
            'conversations: owner-privilege member does not own the conversation row'
          );
        }
        return { deleted: true, evicteePrincipalIds: principalIds };
      })
  );
}

type MuteOutcome = Outcome<{ muted: boolean }>;

type PinOutcome = Outcome<{ pinned: boolean }>;

/**
 * Member-scoped flag writes: the WHERE clause binds the row to the CALLER's
 * active membership, so no input can reach another member's flags. Zero rows
 * disambiguates to not-found — the caller is not an active member (or the
 * conversation does not exist), and the two answer identically on purpose.
 */
export function setMutedTransition(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly callerUserId: string;
    readonly muted: boolean;
  }
): ByTransitionParams<MuteOutcome, DomainError> {
  return {
    transition: () =>
      stores.members
        .setMuted({
          conversationId: params.conversationId,
          userId: params.callerUserId,
          muted: params.muted,
        })
        .map((updated) => (updated ? { muted: params.muted } : null)),
    onZeroRows: () => okAsync<MuteOutcome, DomainError>({ refusal: 'not-found' }),
  };
}

export function setPinnedTransition(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly callerUserId: string;
    readonly pinned: boolean;
  }
): ByTransitionParams<PinOutcome, DomainError> {
  return {
    transition: () =>
      stores.members
        .setPinned({
          conversationId: params.conversationId,
          userId: params.callerUserId,
          pinned: params.pinned,
        })
        .map((updated) => (updated ? { pinned: params.pinned } : null)),
    onZeroRows: () => okAsync<PinOutcome, DomainError>({ refusal: 'not-found' }),
  };
}

type ReadCursorOutcome = Outcome<{ lastReadSeq: number }>;

/**
 * Acknowledges reading up to a sequence. The store write is monotonic, so the
 * answer is the row's committed cursor — a replayed or out-of-order lower
 * acknowledgement converges on the higher value instead of regressing it.
 */
export function advanceLastReadSeqTransition(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly callerUserId: string;
    readonly lastReadSeq: number;
  }
): ByTransitionParams<ReadCursorOutcome, DomainError> {
  return {
    transition: () =>
      stores.members
        .advanceLastReadSeq({
          conversationId: params.conversationId,
          userId: params.callerUserId,
          lastReadSeq: BigInt(params.lastReadSeq),
        })
        .map((row) => (row === null ? null : { lastReadSeq: Number(row.lastReadSeq) })),
    onZeroRows: () => okAsync<ReadCursorOutcome, DomainError>({ refusal: 'not-found' }),
  };
}

type AcceptOutcome = Outcome<{ accepted: true }>;

const declineOutcomeSchema = z.union([
  z.object({
    declined: z.literal(true),
    memberId: z.string(),
    /** The decliner, so the route evicts them like every other departure. */
    evicteePrincipalIds: z.array(z.string()),
  }),
  refusalSchema,
]);

type DeclineOutcome = z.infer<typeof declineOutcomeSchema>;

/**
 * Accept a pending invite: the conditional `acceptedAt` write wins for a
 * pending membership; a 0-row outcome is disambiguated — a still-active member
 * is already accepted (an idempotent no-op success, legacy 200-on-repeat), and
 * a missing/left one is not-found.
 */
export function acceptInviteTransition(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly callerUserId: string }
): ByTransitionParams<AcceptOutcome, DomainError> {
  const { conversationId, callerUserId } = params;
  return {
    transition: () =>
      stores.members
        .setAccepted({ conversationId, userId: callerUserId })
        .map((updated) => (updated ? { accepted: true as const } : null)),
    onZeroRows: () =>
      stores.members
        .activeByUser(conversationId, callerUserId)
        .map(
          (member): AcceptOutcome =>
            member === null ? { refusal: 'not-found' } : { accepted: true }
        ),
  };
}

/**
 * Decline a pending invite (pending-only — an accepted member uses `/leave`):
 * the conditional `leftAt` write wins for a pending membership and yields the
 * member id for the broadcast plus the decliner's principal for eviction (a
 * pending invitee may already hold a socket — the WS gate is active membership,
 * which has no `acceptedAt` predicate); a 0-row
 * outcome is disambiguated — a still-active member is accepted (a `validation`
 * refusal), and a missing/left one is not-found.
 */
export function declineInviteTransition(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly callerUserId: string }
): ByTransitionParams<DeclineOutcome, DomainError> {
  const { conversationId, callerUserId } = params;
  return {
    transition: () =>
      stores.members.declinePending({ conversationId, userId: callerUserId }).map((row) =>
        row === null
          ? null
          : // Validated where it is built: the schema is this payload's runtime
            // invariant, and a shape it does not declare is a server defect
            // (a throw), never a refusal the client could act on.
            declineOutcomeSchema.parse({
              declined: true as const,
              memberId: row.id,
              evicteePrincipalIds: [callerUserId],
            })
      ),
    onZeroRows: () =>
      stores.members
        .activeByUser(conversationId, callerUserId)
        .map(
          (member): DeclineOutcome =>
            member === null ? { refusal: 'not-found' } : { refusal: 'validation' }
        ),
  };
}

export const changePrivilegeOutcomeSchema = z.union([
  z.object({
    updated: z.literal(true),
    memberId: z.string(),
    privilege: z.enum(MEMBER_PRIVILEGES),
  }),
  refusalSchema,
]);

type ChangePrivilegeOutcome = z.infer<typeof changePrivilegeOutcomeSchema>;

interface ChangePrivilegeParams {
  readonly conversationId: string;
  readonly callerUserId: string;
  readonly memberId: string;
  readonly privilege: MemberPrivilege;
}

/**
 * The admin-driven member privilege change, porting the legacy authorization
 * ladder exactly: the caller must be an active admin+; the target must exist
 * and not be the caller; and `canChangePrivilege` gates the grant (target and
 * new privilege both strictly below the caller — so `owner` is never mintable
 * and the owner is never demoted). Refusals ride the success channel, so every
 * check precedes the conditional write.
 */
export function changeMemberPrivilege(
  stores: ConversationsStores,
  params: ChangePrivilegeParams
): ResultAsync<ChangePrivilegeOutcome, DomainError> {
  const { conversationId, callerUserId, memberId, privilege } = params;
  return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
    if (caller === null) return okAsync<ChangePrivilegeOutcome>({ refusal: 'not-found' });
    if (getPrivilegeLevel(caller.privilege) < getPrivilegeLevel('admin')) {
      // Legacy mounted requirePrivilege('admin') on this route, answering the
      // distinct PRIVILEGE_INSUFFICIENT (403) for a below-admin caller.
      return okAsync<ChangePrivilegeOutcome>({ refusal: 'privilege-insufficient' });
    }
    return stores.members.activeById(conversationId, memberId).andThen((target) => {
      if (target === null) return okAsync<ChangePrivilegeOutcome>({ refusal: 'not-found' });
      if (target.userId === callerUserId) {
        return okAsync<ChangePrivilegeOutcome>({ refusal: 'cannot-change-own-privilege' });
      }
      if (!canChangePrivilege(caller.privilege, target.privilege, privilege)) {
        // Legacy returns the distinct PRIVILEGE_INSUFFICIENT (403) for an
        // over-grant / not-strictly-below refusal — the same code the non-admin
        // rung above and the removal path use, matching legacy's
        // requirePrivilege('admin').
        return okAsync<ChangePrivilegeOutcome>({ refusal: 'privilege-insufficient' });
      }
      return stores.members.updatePrivilege({ conversationId, memberId, privilege }).map(
        (updated): ChangePrivilegeOutcome =>
          // 0 rows only if the target departed concurrently between the
          // authz read and this write — no lock is held here, so treat the
          // benign race as not-found rather than a defect.
          updated ? { updated: true, memberId, privilege } : { refusal: 'not-found' }
      );
    });
  });
}
