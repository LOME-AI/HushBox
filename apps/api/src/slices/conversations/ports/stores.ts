import type { MemberPrivilege, ResolvedReasoningEffort } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * Data access for the conversations slice (single-writer owner of
 * `conversations`, `conversation_members`, `epochs`, `epoch_members`,
 * `conversation_forks`; read-only on `users` and `messages`). Every method is
 * one statement (or one read), so the same factory binds to the raw client or
 * to an open transaction — multi-statement orchestration and every rule live
 * in domain functions, never here.
 */

export interface ConversationRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly title: Uint8Array;
  readonly titleEpochNumber: number;
  readonly currentEpoch: number;
  readonly nextSequence: number;
  /**
   * The durable, owner-set per-conversation spend cap in nano-USD; `0` means no
   * owner-funded conversation budget (NOT unlimited). At admission it contributes
   * 0 to `effective = min(member, conversation, owner)`, so owner-funding does not
   * engage until the owner sets a cap — a signed-in member self-funds (a guest is
   * refused upstream). See admission.
   */
  readonly conversationBudgetNanoUsd: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface ConversationListRecord {
  readonly conversation: ConversationRecord;
  readonly privilege: MemberPrivilege;
  readonly muted: boolean;
  readonly pinned: boolean;
  readonly acceptedAt: Date | null;
  readonly invitedByUsername: string | null;
  /** Highest message sequence this member has read; 0 means nothing read. */
  readonly lastReadSeq: bigint;
  /** Seats not left in the conversation, users and link guests alike. */
  readonly memberCount: number;
}

export interface MemberRecord {
  readonly id: string;
  readonly userId: string | null;
  /** The link a guest joined through (`userId` null); null for real user members. */
  readonly linkId: string | null;
  readonly privilege: MemberPrivilege;
  readonly visibleFromEpoch: number;
  readonly joinedAt: Date;
  readonly acceptedAt: Date | null;
  readonly muted: boolean;
  readonly pinned: boolean;
  /** Highest message sequence this member has read; 0 means nothing read. */
  readonly lastReadSeq: bigint;
}

interface MemberListRecord {
  readonly id: string;
  readonly userId: string | null;
  /** The link a guest joined through (`userId` null); null for real user members. */
  readonly linkId: string | null;
  readonly username: string | null;
  readonly privilege: MemberPrivilege;
  readonly visibleFromEpoch: number;
  readonly joinedAt: Date;
  readonly acceptedAt: Date | null;
}

export interface ForkRecord {
  readonly id: string;
  readonly name: string;
  readonly tipMessageId: string | null;
  readonly createdAt: Date;
}

/**
 * A fork as the LIST read returns it: the record plus the epoch of its tip
 * message, which the caller's epoch floor is applied against before the fork
 * reaches a view. Null when the fork has no tip message — there is then no
 * identifier to withhold. Only `list` carries it; the single-fork reads and
 * the `RETURNING` writes cannot join, and none of them lists.
 */
export interface ForkListRecord extends ForkRecord {
  readonly tipEpochNumber: number | null;
}

/**
 * One active member's PUBLIC key material — the authoritative set a departing
 * member re-wraps the next epoch key against. `userId` is set for user members
 * (`publicKey` from `users`), `linkId` for link-guest members (`publicKey` from
 * `sharedLinks.linkPublicKey`); exactly one is non-null.
 */
export interface MemberKeyRecord {
  readonly memberId: string;
  readonly userId: string | null;
  readonly linkId: string | null;
  readonly publicKey: Uint8Array;
  readonly privilege: MemberPrivilege;
  readonly visibleFromEpoch: number;
}

/**
 * A stored content item, read-only for the history and public-share reads.
 * `content_items` is the chat slice's table; this slice reads it exactly as it
 * reads `messages` and `users`. Text items carry `encryptedBlob`; media items
 * carry null bytes and are fetched by presigning `id` separately.
 *
 * The billed cost `costNanoUsd` is projected only onto the AUTHENTICATED
 * history read; the unauthenticated public-share view serves the model and the
 * smart-model flag and strips the cost, and its projection —
 * `sharedContentItemView` in `shares.ts` — is what defines the public
 * disclosure. Each read owns its own projection; `content-item-view.ts` holds
 * only the base shape they extend.
 */
export interface ContentItemRow {
  readonly id: string;
  readonly messageId: string;
  readonly position: number;
  readonly contentType: 'text' | 'image' | 'audio' | 'video';
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  /** Pixel width of media items (null for text/audio); drives the client aspect ratio. */
  readonly width: number | null;
  /** Pixel height of media items (null for text/audio); drives the client aspect ratio. */
  readonly height: number | null;
  /** Duration of time-based media (video/audio) in milliseconds, or null. */
  readonly durationMs: number | null;
  readonly encryptedBlob: Uint8Array | null;
  /** Total billed cost anchored to this item (display mirror), or null. */
  readonly costNanoUsd: bigint | null;
  /** The generating model id as a plain string, or null (user/system items). */
  readonly modelId: string | null;
  readonly isSmartModel: boolean;
  /**
   * Persisted reasoning-token spend summed over the billed generations
   * anchored to this item (`llm_completions.reasoningTokens`), or null when no
   * completion row exists (user text, media, pre-feature rows).
   */
  readonly reasoningTokens: number | null;
  /**
   * The level the generation behind this item reasoned at
   * (`llm_completions.reasoningEffort`), or null when no completion row
   * recorded one. Null and `off` are different facts: null is "no reasoning
   * wire was sent", `off` is "reasoning was resolved to none".
   */
  readonly reasoningEffort: ResolvedReasoningEffort | null;
  readonly reasoningDurationMs: number | null;
  /**
   * Input and output tokens summed over the billed generations anchored to
   * this item (`llm_completions`), each null when no completion row exists.
   */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/** The `messages.sender_type` enum's values. */
type MessageSenderType = 'user' | 'assistant' | 'system';

/** A conversation message with its content items — the history read's row. */
export interface HistoryMessageRow {
  readonly id: string;
  readonly parentMessageId: string | null;
  readonly sequenceNumber: number;
  readonly epochNumber: number;
  readonly senderType: MessageSenderType;
  readonly senderId: string | null;
  readonly wrappedContentKey: Uint8Array;
  readonly batchId: string;
  /** Set when the sender's account deletion erased the content; the rows then hold no content items. */
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly contentItems: ContentItemRow[];
}

export interface EpochWrapRecord {
  readonly conversationId: string;
  readonly epochNumber: number;
  readonly wrap: Uint8Array;
  readonly visibleFromEpoch: number;
}

/**
 * One epoch as the key-chain read returns it. `previousEpochNumber` is the
 * epoch its chain link opens to, read through `previous_epoch_id`: a recovery
 * rotation chains past the epochs whose keys did not verify, so it is not
 * always `epochNumber - 1`.
 */
export interface EpochChainRecord {
  readonly epochNumber: number;
  readonly epochPublicKey: Uint8Array;
  readonly confirmationHash: Uint8Array;
  readonly previousEpochNumber: number | null;
  readonly chainLink: Uint8Array | null;
}

/**
 * One conversation's slice of the chain read: everything from `fromEpoch`
 * upward. The floor rides the query rather than a post-read filter, so a
 * conversation with a long rotation history never hands the pre-floor epochs
 * (whose keys the member may not derive) to the process at all.
 */
export interface EpochChainScope {
  readonly conversationId: string;
  readonly fromEpoch: number;
}

export interface ConversationsStore {
  /** `INSERT … ON CONFLICT (id) DO NOTHING`; null when the id already exists. */
  insert(params: {
    readonly id: string;
    readonly ownerUserId: string;
    readonly title: Uint8Array;
  }): ResultAsync<ConversationRecord | null, DomainError>;
  get(conversationId: string): ResultAsync<ConversationRecord | null, DomainError>;
  /**
   * `get` over an id set in one statement — the batch keychain's existence and
   * `currentEpoch` read. Ids with no row are simply absent from the result.
   */
  byIds(conversationIds: readonly string[]): ResultAsync<ConversationRecord[], DomainError>;
  /**
   * `SELECT … FOR UPDATE` — the per-conversation serialization point every
   * member/epoch/fork-structure transaction takes FIRST (uniform lock order
   * prevents interleaved rotations and member-count races).
   */
  lockForUpdate(conversationId: string): ResultAsync<ConversationRecord | null, DomainError>;
  /**
   * `SELECT … FOR SHARE` — the settlement's epoch-at-persist re-read. FOR SHARE
   * blocks rotation's `currentEpoch` UPDATE (a writer) while allowing concurrent
   * readers, so the wrap-target assertion serializes against rotation without
   * taking an exclusive lock.
   */
  lockForShare(conversationId: string): ResultAsync<ConversationRecord | null, DomainError>;
  listForUser(params: {
    readonly userId: string;
    readonly limit: number;
    readonly cursor: { readonly updatedAt: Date; readonly id: string } | null;
  }): ResultAsync<ConversationListRecord[], DomainError>;
  /** Conditional owner-only hard delete; false when 0 rows matched. */
  deleteOwned(params: {
    readonly conversationId: string;
    readonly ownerUserId: string;
  }): ResultAsync<boolean, DomainError>;
  /**
   * Owner-only title write: conditional
   * `UPDATE … SET title, titleEpochNumber WHERE id = … AND ownerUserId = …
   * AND EXISTS (that epoch number on that conversation) RETURNING …`; null
   * when 0 rows (missing, not the owner, or a title epoch the conversation
   * has none of — the caller disambiguates). The title is opaque ciphertext,
   * and `titleEpochNumber` is client-supplied, so the EXISTS arm is the write
   * boundary that keeps the stored number naming a real epoch.
   */
  updateTitle(params: {
    readonly conversationId: string;
    readonly ownerUserId: string;
    readonly title: Uint8Array;
    readonly titleEpochNumber: number;
  }): ResultAsync<ConversationRecord | null, DomainError>;
  /**
   * Owner-only per-conversation budget write: conditional
   * `UPDATE … SET conversationBudgetNanoUsd WHERE id = … AND ownerUserId = …
   * RETURNING …`; null when 0 rows (missing or not the owner — the caller
   * disambiguates, exactly like `updateTitle`). The cap is the durable,
   * cumulative-forever per-conversation ceiling admission gates against.
   */
  updateBudget(params: {
    readonly conversationId: string;
    readonly ownerUserId: string;
    readonly budgetNanoUsd: bigint;
  }): ResultAsync<ConversationRecord | null, DomainError>;
  /**
   * The rotation claim: first-write-wins
   * `UPDATE … SET currentEpoch = expected + 1, title … WHERE currentEpoch = expected`.
   * False when the epoch moved underneath the caller (stale rotation).
   * A null `encryptedTitle` claims the epoch and leaves `title` and
   * `titleEpochNumber` exactly as they stand. Which rotations carry one is the
   * caller's authorization decision, made in `applyRotation`'s `writeTitle`: a
   * departure rotation carries the title only for the owner, while a rotation
   * that seats a member or link guest carries it whoever runs it, because the
   * new seat's floor is the new epoch.
   */
  claimRotation(params: {
    readonly conversationId: string;
    readonly expectedEpoch: number;
    readonly encryptedTitle: Uint8Array | null;
  }): ResultAsync<boolean, DomainError>;
  /**
   * Atomically bumps `nextSequence` by `count` and returns the reserved,
   * contiguous block (lowest first) — `UPDATE … SET nextSequence =
   * nextSequence + count RETURNING nextSequence - count`. The counter is
   * monotonic and reserved numbers are never reused, so message ordering never
   * collides after a delete. Null when the conversation row is absent.
   */
  reserveSequenceBlock(params: {
    readonly conversationId: string;
    readonly count: number;
  }): ResultAsync<readonly number[] | null, DomainError>;
}

/**
 * An active link-guest member joined to its link's public-key material. A link
 * guest is a first-class member (`userId` null, `linkId` set); its decryption
 * key and display name live on `shared_links`, so one read serves both the
 * membership gate and keychain. `displayName` is the link's own label (never a
 * `users.username`).
 */
export interface ActiveLinkGuest {
  readonly member: MemberRecord;
  readonly publicKey: Uint8Array;
  readonly displayName: string | null;
}

export interface MembersStore {
  activeByUser(
    conversationId: string,
    userId: string
  ): ResultAsync<MemberRecord | null, DomainError>;
  /**
   * The subset of `conversationIds` the user still holds an active membership
   * in, in one statement. Ids, not rows: the batch keychain needs the
   * membership gate's yes/no and nothing else.
   */
  activeIdsForUser(
    conversationIds: readonly string[],
    userId: string
  ): ResultAsync<string[], DomainError>;
  /**
   * The active link-guest member for a link (`leftAt IS NULL`), joined to
   * `shared_links` for its public key and display name; null when the link has
   * no active member (never seated, revoked, or left). Gates the guest-reachable
   * reads and the WS upgrade on the member row — never on link liveness alone.
   */
  activeLinkGuest(
    conversationId: string,
    linkId: string
  ): ResultAsync<ActiveLinkGuest | null, DomainError>;
  /**
   * `activeByUser` with `SELECT … FOR SHARE` on the membership row. Taken by
   * membership-guarded share/link writes inside their transaction so the
   * guarded insert serializes against a concurrent member-removal UPDATE:
   * whichever side commits first is visible to the other, closing the
   * check-then-act window an unlocked read leaves open. Pure read paths stay
   * on `activeByUser`.
   */
  lockActiveByUser(
    conversationId: string,
    userId: string
  ): ResultAsync<MemberRecord | null, DomainError>;
  activeById(
    conversationId: string,
    memberId: string
  ): ResultAsync<MemberRecord | null, DomainError>;
  /**
   * Every member row without a `leftAt`, lapsed link seats included — this read
   * deliberately does not carry the link-liveness predicate the member-cap count
   * and the wrap set do. Adding it would change every consumer of this read, and
   * none of those changes has been decided. Some of that is presentational —
   * which seats the member list shows, which seats per-member budgets attach to —
   * but the regenerate guard decides solo-versus-group from these rows, and a
   * guest seat carries a null `userId`: filtering would make a conversation whose
   * only other seat is an expired-link guest read as solo, skipping the
   * cross-member walk that stops a sequence-scoped delete from destroying that
   * guest's content.
   * The cost of leaving it unfiltered: lapsed seats accumulate here, bounded by
   * the link-mint rate limit rather than by the member cap, which counts them
   * out.
   */
  listActive(conversationId: string): ResultAsync<MemberListRecord[], DomainError>;
  /**
   * Every active member's public key, ordered by `joinedAt` — the authoritative
   * wrap-set input every epoch rotation is validated against. Unions user
   * members (`users.publicKey`) and link members (`sharedLinks.linkPublicKey`).
   */
  activeKeysOrdered(conversationId: string): ResultAsync<MemberKeyRecord[], DomainError>;
  countActive(conversationId: string): ResultAsync<number, DomainError>;
  /**
   * Principal ids (user or link) of every active member — the eviction fan-out.
   * Lapsed link seats are deliberately included: this feeds a broadcast, where a
   * superset costs an evictee who was already losing the seat, and dropping one
   * would leave a live subscriber unevicted.
   */
  activePrincipalIds(conversationId: string): ResultAsync<string[], DomainError>;
  /**
   * `INSERT … ON CONFLICT DO NOTHING` on the active-unique index; null when
   * the user is already an active member.
   */
  insert(params: {
    readonly conversationId: string;
    readonly userId: string;
    readonly privilege: MemberPrivilege;
    readonly visibleFromEpoch: number;
    readonly acceptedAt: Date | null;
    readonly invitedByUserId: string | null;
  }): ResultAsync<{ readonly id: string; readonly joinedAt: Date } | null, DomainError>;
  /**
   * Seats a link-guest member (`userId` null, `linkId` set, `acceptedAt` now):
   * `INSERT … ON CONFLICT DO NOTHING` on the link-active index; null when the
   * link already has an active member. A link guest participates exactly like a
   * user member and is revoked by its row being marked left.
   */
  insertLinkMember(params: {
    readonly conversationId: string;
    readonly linkId: string;
    readonly privilege: MemberPrivilege;
    readonly visibleFromEpoch: number;
  }): ResultAsync<{ readonly id: string } | null, DomainError>;
  /** Conditional `SET leftAt WHERE … leftAt IS NULL`; null when 0 rows. */
  markLeft(params: {
    readonly conversationId: string;
    readonly memberId: string;
  }): ResultAsync<{ readonly userId: string | null } | null, DomainError>;
  /**
   * Conditional link-guest departure: `SET leftAt = now() WHERE conversationId
   * = … AND linkId = … AND leftAt IS NULL RETURNING id`; null when 0 rows (no
   * active member for the link). Security-critical: the media presign member
   * path gates a link guest solely on `conversation_members.leftAt` (never
   * `shared_links.revokedAt`), so revoke MUST mark the guest left here or a
   * revoked guest still passes the presign gate.
   */
  markLeftByLink(params: {
    readonly conversationId: string;
    readonly linkId: string;
  }): ResultAsync<{ readonly id: string } | null, DomainError>;
  /**
   * Pending-only accept: `SET acceptedAt = now() WHERE … acceptedAt IS NULL
   * AND leftAt IS NULL`; false when 0 rows (already accepted, left, or not a
   * member — the caller disambiguates). Never check-then-act.
   */
  setAccepted(params: {
    readonly conversationId: string;
    readonly userId: string;
  }): ResultAsync<boolean, DomainError>;
  /**
   * Pending-only decline: `SET leftAt = now() WHERE … acceptedAt IS NULL AND
   * leftAt IS NULL RETURNING id`; null when 0 rows (accepted, already left, or
   * not a member). Returns the member id for the removal broadcast.
   */
  declinePending(params: {
    readonly conversationId: string;
    readonly userId: string;
  }): ResultAsync<{ readonly id: string } | null, DomainError>;
  /**
   * Admin-driven privilege change: conditional `SET privilege WHERE id = … AND
   * conversationId = … AND leftAt IS NULL`; false when 0 rows (the target
   * departed concurrently — the authz gates ran on a prior read).
   */
  updatePrivilege(params: {
    readonly conversationId: string;
    readonly memberId: string;
    readonly privilege: MemberPrivilege;
  }): ResultAsync<boolean, DomainError>;
  /**
   * Link-guest privilege change (the legacy `changeLinkPrivilege` write, whose
   * single source of truth is the member row): conditional
   * `SET privilege WHERE conversationId = … AND linkId = … AND leftAt IS NULL
   * RETURNING id`; null when the link has no active guest member. No key
   * rotation — a privilege change never revokes access.
   */
  updatePrivilegeByLink(params: {
    readonly conversationId: string;
    readonly linkId: string;
    readonly privilege: MemberPrivilege;
  }): ResultAsync<{ readonly id: string } | null, DomainError>;
  /** Caller-scoped flag write; false when the caller has no active row. */
  setMuted(params: {
    readonly conversationId: string;
    readonly userId: string;
    readonly muted: boolean;
  }): ResultAsync<boolean, DomainError>;
  setPinned(params: {
    readonly conversationId: string;
    readonly userId: string;
    readonly pinned: boolean;
  }): ResultAsync<boolean, DomainError>;
  /**
   * Monotonic read-cursor write: `SET last_read_seq = GREATEST(last_read_seq,
   * $new)` scoped to the CALLER's active row. Never check-then-act — a replay
   * and an out-of-order lower write both converge on the committed maximum, so
   * the returned cursor is the row's value after the write, not the input.
   * Null when the caller has no active row.
   */
  advanceLastReadSeq(params: {
    readonly conversationId: string;
    readonly userId: string;
    readonly lastReadSeq: bigint;
  }): ResultAsync<{ readonly lastReadSeq: bigint } | null, DomainError>;
  /**
   * base64(member public key) → visibleFromEpoch for every ACTIVE member
   * (users and link guests) — the authoritative input to wrap-set planning.
   */
  activeVisibilityByKey(conversationId: string): ResultAsync<Map<string, number>, DomainError>;
}

export interface EpochsStore {
  byNumber(
    conversationId: string,
    epochNumber: number
  ): ResultAsync<{ readonly id: string } | null, DomainError>;
  insert(params: {
    readonly conversationId: string;
    readonly epochNumber: number;
    readonly previousEpochId: string | null;
    readonly epochPublicKey: Uint8Array;
    readonly confirmationHash: Uint8Array;
    readonly chainLink: Uint8Array | null;
  }): ResultAsync<{ readonly id: string }, DomainError>;
  /** Idempotent on (epochId, memberPublicKey): conflicts converge, not throw. */
  insertWraps(
    rows: readonly {
      readonly epochId: string;
      readonly memberPublicKey: Uint8Array;
      readonly wrap: Uint8Array;
      readonly visibleFromEpoch: number;
    }[]
  ): ResultAsync<void, DomainError>;
  /**
   * Deletes, across every epoch of the conversation, each wrap whose key is not
   * in `keys`: a rotation drops the departed seats' wraps everywhere, and every
   * remaining seat keeps each wrap it ever held.
   */
  deleteWrapsExceptKeys(
    conversationId: string,
    keys: readonly Uint8Array[]
  ): ResultAsync<void, DomainError>;
  /** Deletes, across every epoch of the conversation, each wrap of a key in `keys`. */
  deleteWrapsForKeys(
    conversationId: string,
    keys: readonly Uint8Array[]
  ): ResultAsync<void, DomainError>;
  /**
   * The subset of `conversationIds` that is rotation-pending: its current epoch
   * holds a wrap whose key no live seat holds. One statement whatever the id
   * count. Derived rather than stored, because a link lapses with no writer at
   * the moment it does.
   */
  conversationsWithDepartedHolders(
    conversationIds: readonly string[]
  ): ResultAsync<ReadonlySet<string>, DomainError>;
  /**
   * True when `memberPublicKey` holds an `epoch_members` row for the
   * conversation's epoch NUMBER (joining `epochs → epoch_members`). The
   * authoritative wrap-set membership check for the settlement's member-keyed
   * epoch-at-persist gate: a non-member or stale key finds no row. Conversation
   * membership is not enough — only keys actually wrapped into this epoch pass.
   */
  memberInEpoch(params: {
    readonly conversationId: string;
    readonly epochNumber: number;
    readonly memberPublicKey: Uint8Array;
  }): ResultAsync<boolean, DomainError>;
  /**
   * Every wrap the key holds across the given conversations, in one read.
   * Set-based rather than per-conversation because the batch keychain asks for
   * up to a hundred at once, and the Neon pool serializes on one connection —
   * a per-id loop would be a hundred round trips in a row.
   */
  wrapsForKey(
    conversationIds: readonly string[],
    memberPublicKey: Uint8Array
  ): ResultAsync<EpochWrapRecord[], DomainError>;
  /**
   * The epoch records for many conversations at their own floors, keyed by
   * conversation id, ascending by epoch number. One statement whatever the
   * scope count; a conversation with no epoch at or above its floor is absent
   * from the map.
   */
  epochChains(
    scopes: readonly EpochChainScope[]
  ): ResultAsync<ReadonlyMap<string, readonly EpochChainRecord[]>, DomainError>;
}

export interface UsersReader {
  byId(userId: string): ResultAsync<
    {
      readonly id: string;
      readonly username: string;
      readonly publicKey: Uint8Array;
    } | null,
    DomainError
  >;
  /**
   * The users row under a `FOR KEY SHARE` lock held to commit, null when it is
   * gone. A settlement takes it for its payer and sender before any other lock,
   * the order account deletion takes its own, so a deletion in flight is waited
   * out and then read as gone, and one that starts later waits for the
   * settlement: the usage rows the settlement writes can name the row safely.
   */
  lockForKeyShare(userId: string): ResultAsync<{ readonly id: string } | null, DomainError>;
}

export interface MessagesReader {
  inConversation(messageId: string, conversationId: string): ResultAsync<boolean, DomainError>;
  /**
   * The message's epoch and sender when it belongs to the conversation, null
   * otherwise. This read applies NO epoch floor: null means absence alone, and
   * a message below the caller's floor comes back carrying its real epoch. A
   * caller holding a caller-supplied message id must put that epoch through
   * the visibility predicate itself, and must answer an invisible message with
   * the same refusal it gives an absent one — a refusal that differs discloses
   * that the message exists.
   */
  headerInConversation(
    messageId: string,
    conversationId: string
  ): ResultAsync<MessageHeader | null, DomainError>;
  /** Highest-sequence message id — the Main fork's initial tip. */
  latestId(conversationId: string): ResultAsync<string | null, DomainError>;
  /**
   * Every message's `(id, parentMessageId)` for the conversation — the parent
   * index a fork deletion walks to find the deleted branch's exclusive
   * messages. Read-only on `messages`; the delete itself is the chat slice's.
   */
  parentChainRows(
    conversationId: string
  ): ResultAsync<
    readonly { readonly id: string; readonly parentMessageId: string | null }[],
    DomainError
  >;
  /**
   * Every message's identity and sender for the conversation — the input a
   * regenerate guard walks (tip → target, via `parentMessageId`) to detect an
   * OTHER user's message intervening between the current tip and the regenerate
   * target. Read-only on `messages`; the regenerate itself is the chat slice's.
   */
  senderChainRows(conversationId: string): ResultAsync<readonly SenderChainRow[], DomainError>;
  /**
   * The generating model behind every assistant reply parented to
   * `parentMessageId` — one row per (reply, model), so a multi-model turn's
   * siblings stay distinguishable. The input a regenerate's premium-tier
   * exemption is judged against: the exemption's premise is that the model was
   * already chosen on the turn being replaced, and this is what says which
   * models those were. Read-only on `messages`/`content_items`; the regenerate
   * itself is the chat slice's.
   */
  assistantReplyModels(params: {
    readonly conversationId: string;
    readonly parentMessageId: string;
  }): ResultAsync<readonly AssistantReplyModelRow[], DomainError>;
  /**
   * A page of the conversation's messages at or above `minEpoch` (the caller's
   * visibility floor), ordered by `sequenceNumber`, each with its content items
   * ordered by `position`. `afterSequence` is the exclusive cursor (null for the
   * first page). Read-only on `messages`/`content_items`.
   */
  history(params: {
    readonly conversationId: string;
    readonly minEpoch: number;
    readonly afterSequence: number | null;
    readonly limit: number;
  }): ResultAsync<HistoryMessageRow[], DomainError>;
}

/** Where a message sits and who wrote it, without its content. */
export interface MessageHeader {
  readonly epochNumber: number;
  readonly senderType: MessageSenderType;
  /** Null once the sender's account deletion has nulled it. */
  readonly senderId: string | null;
}

/** One assistant reply paired with one model that produced content on it. */
interface AssistantReplyModelRow {
  readonly messageId: string;
  readonly modelId: string;
}

export interface SenderChainRow {
  readonly id: string;
  readonly parentMessageId: string | null;
  readonly senderType: MessageSenderType;
  readonly senderId: string | null;
  /**
   * The row's position in the conversation's one sequence space — what the
   * linear regenerate delete scopes on, so the guard that must judge that
   * delete's blast radius reads the same number the delete does.
   */
  readonly sequenceNumber: number;
}

export interface ForksStore {
  list(conversationId: string): ResultAsync<ForkListRecord[], DomainError>;
  byId(conversationId: string, forkId: string): ResultAsync<ForkRecord | null, DomainError>;
  /**
   * `byId` with `SELECT … FOR UPDATE` on the fork row. Taken by a settling
   * chat turn before it resolves the fork's tip so the turn and a concurrent
   * `PUT /forks/:id/tip` (both tip movers) serialize on the fork row: whichever
   * takes the lock first commits, the other re-reads and its CAS fails. Pure
   * read paths stay on `byId`.
   */
  lockById(conversationId: string, forkId: string): ResultAsync<ForkRecord | null, DomainError>;
  /**
   * 'name-taken' maps the (conversationId, name) unique violation;
   * 'id-taken' maps a client-minted id already used by some other
   * conversation's fork (the table's primary key is global).
   */
  insert(params: {
    readonly id: string | null;
    readonly conversationId: string;
    readonly name: string;
    readonly tipMessageId: string | null;
    readonly createdAt?: Date;
  }): ResultAsync<ForkRecord | 'name-taken' | 'id-taken', DomainError>;
  rename(params: {
    readonly conversationId: string;
    readonly forkId: string;
    readonly name: string;
  }): ResultAsync<ForkRecord | 'name-taken' | null, DomainError>;
  /**
   * The fork-tip CAS: `UPDATE … WHERE tipMessageId IS NOT DISTINCT FROM
   * expected`; null when the expected state did not hold.
   */
  updateTip(params: {
    readonly conversationId: string;
    readonly forkId: string;
    readonly expectedTipMessageId: string | null;
    readonly tipMessageId: string;
  }): ResultAsync<ForkRecord | null, DomainError>;
  remove(params: {
    readonly conversationId: string;
    readonly forkId: string;
  }): ResultAsync<boolean, DomainError>;
  removeAll(conversationId: string): ResultAsync<void, DomainError>;
}

export interface SharedLinkRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly displayName: string | null;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

/**
 * A link plus its seated privilege, for the owner-facing list view. Privilege
 * lives on the link's guest `conversation_members` row (not on `shared_links`);
 * `listForConversation` joins the active guest to project it. Revoked links are
 * excluded from that list, so within it a memberless link (one with no active
 * guest) reports the column default `write`.
 */
interface SharedLinkListRecord extends SharedLinkRecord {
  readonly privilege: MemberPrivilege;
}

export interface SharedMessageRecord {
  /**
   * The `shared_messages` row id — the public read's `:shareId`. The media
   * presign route keys `:shareId` on it too, so the capability stays scoped to
   * exactly this shared message's content items.
   */
  readonly id: string;
  readonly messageId: string;
  /** The content key re-wrapped under the share secret — what the visitor's URL fragment opens. */
  readonly wrappedContentKey: Uint8Array;
  /** When the share row was created. */
  readonly createdAt: Date;
  /** When the shared message itself was created; the share may come much later. */
  readonly messageCreatedAt: Date;
  /**
   * The shared message's own location fields and its epoch-wrapped content key.
   * Every content item's ciphertext binds this tuple plus `epochWrappedContentKey`
   * as AEAD associated data at write, so a reader that cannot reproduce them
   * byte-for-byte cannot open the blob at all.
   */
  readonly conversationId: string;
  readonly epochNumber: number;
  readonly senderId: string | null;
  readonly epochWrappedContentKey: Uint8Array;
  /** Set when the sender's account deletion erased the message's content. */
  readonly deletedAt: Date | null;
  /** The shared message's content items (text bytes inline; media by id). */
  readonly contentItems: ContentItemRow[];
}

/** A link with the auth hash it was minted under — what a re-mint must match to converge. */
export interface SharedLinkMintRecord extends SharedLinkRecord {
  readonly linkAuthHash: Uint8Array;
}

export interface SharedLinksStore {
  /**
   * `INSERT … ON CONFLICT DO NOTHING`; null when the public key or the auth
   * hash already exists (the client-generated key is the natural dedupe guard,
   * so racing mints of the same key converge on one row).
   */
  insert(params: {
    readonly conversationId: string;
    readonly linkPublicKey: Uint8Array;
    /** SHA-256 of the link auth token, computed by the minting client. */
    readonly linkAuthHash: Uint8Array;
    readonly displayName: string | null;
    readonly expiresAt: Date | null;
    /** The minting member — a link dies with the account that issued it. */
    readonly createdBy: string;
  }): ResultAsync<SharedLinkRecord | null, DomainError>;
  /** The mint's natural-key read. The public key is key material here, never a credential. */
  byPublicKey(linkPublicKey: Uint8Array): ResultAsync<SharedLinkMintRecord | null, DomainError>;
  /** The link a guest credential resolves to: lookup by the hash of its auth token. */
  byAuthHash(linkAuthHash: Uint8Array): ResultAsync<SharedLinkRecord | null, DomainError>;
  /** Every non-revoked link for the conversation (revoked excluded here; expired still included and filtered by the read path), each with its seated privilege. */
  listForConversation(conversationId: string): ResultAsync<SharedLinkListRecord[], DomainError>;
  /** Public read: a link by id, with no conversation scope (the reader is unauthenticated). */
  byId(linkId: string): ResultAsync<SharedLinkRecord | null, DomainError>;
  /**
   * The revoke claim: `UPDATE … SET revokedAt = now() WHERE id = … AND
   * conversationId = … AND revokedAt IS NULL`; null when 0 rows matched
   * (already revoked, wrong conversation, or missing — the caller
   * disambiguates).
   */
  revoke(params: {
    readonly conversationId: string;
    readonly linkId: string;
  }): ResultAsync<SharedLinkRecord | null, DomainError>;
  /**
   * The unrevoke claim (admin path): `UPDATE … SET revokedAt = NULL WHERE
   * id = … AND conversationId = … AND revokedAt IS NOT NULL`; null when 0
   * rows matched (already live, wrong conversation, or missing — the caller
   * disambiguates).
   */
  unrevoke(params: {
    readonly conversationId: string;
    readonly linkId: string;
  }): ResultAsync<SharedLinkRecord | null, DomainError>;
  /**
   * Display-name write, gated to a live link: conditional
   * `UPDATE … SET displayName WHERE id = … AND conversationId = … AND
   * revokedAt IS NULL`; false when 0 rows matched (missing, wrong conversation,
   * or revoked — the caller answers not-found). Serves both the admin rename
   * and a guest renaming its own link.
   */
  updateDisplayName(params: {
    readonly conversationId: string;
    readonly linkId: string;
    readonly displayName: string;
  }): ResultAsync<boolean, DomainError>;
}

export interface SharedMessagesStore {
  insert(params: {
    readonly messageId: string;
    readonly createdBy: string;
    readonly wrappedContentKey: Uint8Array;
  }): ResultAsync<{ readonly id: string; readonly createdAt: Date }, DomainError>;
  /**
   * One standalone share by its id — the public read's scoping unit. Returns
   * exactly that share and its message's content items; null when the id
   * matches nothing.
   */
  byId(shareId: string): ResultAsync<SharedMessageRecord | null, DomainError>;
}

export interface ConversationsStores {
  readonly conversations: ConversationsStore;
  readonly members: MembersStore;
  readonly epochs: EpochsStore;
  readonly users: UsersReader;
  readonly messages: MessagesReader;
  readonly forks: ForksStore;
  readonly sharedLinks: SharedLinksStore;
  readonly sharedMessages: SharedMessagesStore;
}

/** Bound per call site: the pipeline's `c.var.db` or an open transaction. */
export type ConversationsStoresFactory = (db: DbWriter) => ConversationsStores;
