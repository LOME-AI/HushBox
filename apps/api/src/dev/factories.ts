import { eq, inArray } from 'drizzle-orm';
import { conversations, users } from '@hushbox/db';
import {
  asEpochPublicKey,
  createFirstEpoch,
  encryptContentEnvelope,
  encryptTextForEpoch,
  generateContentKey,
  wrapContentKeyToEpoch,
} from '@hushbox/crypto';
import { runSettlement } from '../lib/idempotency/index.js';
import {
  createConversationsStores,
  reserveSequenceBlockWithinTx,
} from '../slices/conversations/index.js';
import { createChatStores } from '../slices/chat/index.js';
import {
  chargeWithinTx,
  createBillingStores,
  refreshWalletSnapshot,
} from '../slices/billing/index.js';
import { mediaObjectKey } from '../slices/media/index.js';
import { listDescriptors } from '../slices/models/index.js';
import { DEV_MEDIA_FIXTURES } from './media-fixtures.js';
import { isAvailabilityCode } from '../lib/errors/index.js';
import type { Redis } from '@upstash/redis';
import type { MediaGenerationFacts } from '@hushbox/shared';
import type { EpochPublicKey } from '@hushbox/crypto';
import type { Database } from '@hushbox/db';
import type { ChatContentItemInput } from '../slices/chat/index.js';
import type { Storage } from '../slices/media/index.js';
import type { SettlementTx } from '../lib/idempotency/index.js';
import type { Result } from '../lib/result/index.js';
import type { DomainError } from '../lib/errors/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';

/**
 * Dev/E2E seed factories over the NEW schema, composed from the slices'
 * published surfaces (conversations stores for conversations/epochs/members,
 * chat stores for messages/content, crypto for the envelope) so seeded rows
 * are structurally identical to what the real pipeline writes: wrap-once
 * content keys, full-location AAD, batchId turn grouping, reserved
 * sequence blocks.
 */

/** Raised for the legacy 404/400 cases (unknown persona emails). */
export class DevSeedError extends Error {}

/**
 * Raised when a seed step's underlying infra (storage/R2) is unavailable — a
 * distinct class from `DevSeedError` so `liftDevWork` can surface it as a
 * truthful 503 UNAVAILABLE instead of laundering a storage outage into an
 * opaque 404. Infra unavailability is not a missing target.
 */
export class DevSeedStorageUnavailableError extends Error {}

/** Result unwrap for seed steps: an infra failure aborts the whole seed. */
export function unwrapSeed<T, E>(result: Result<T, E>, step: string): T {
  if (result.isErr()) throw new DevSeedError(`dev seed: ${step} failed`);
  return result.value;
}

/**
 * Result unwrap for a seed's storage put: an availability-class failure aborts
 * the seed with the distinct `DevSeedStorageUnavailableError`; any other code
 * is an ordinary seed failure. Keeps a storage outage from being reported as a
 * missing target.
 */
export function unwrapStoragePut<T>(result: Result<T, DomainError>, step: string): T {
  if (result.isErr()) {
    const { code } = result.error;
    if (isAvailabilityCode(code)) {
      throw new DevSeedStorageUnavailableError(`dev seed: ${step} unavailable (${code})`);
    }
    throw new DevSeedError(`dev seed: ${step} failed`);
  }
  return result.value;
}

/** Non-null unwrap for seed invariants (missing sequence, conflicting insert). */
export function requireSeed<T>(value: T | null | undefined, step: string): T {
  if (value === null || value === undefined) {
    throw new DevSeedError(`dev seed: ${step} missing`);
  }
  return value;
}

interface SeedUser {
  readonly id: string;
  readonly username: string;
  readonly email: string;
  readonly publicKey: Uint8Array;
}

async function findUsersByEmail(db: Database, emails: readonly string[]): Promise<SeedUser[]> {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      publicKey: users.publicKey,
    })
    .from(users)
    .where(inArray(users.email, [...emails]));
  return rows;
}

async function requireUser(db: Database, email: string): Promise<SeedUser> {
  const [user] = await findUsersByEmail(db, [email]);
  if (user === undefined) throw new DevSeedError(`User not found: ${email}`);
  return user;
}

/**
 * Pinned-id idempotence: the profile seed re-runs against a populated DB,
 * so a factory called with a deterministic id short-circuits when that
 * conversation already exists (the first run's rows, including messages,
 * stand). Random-id callers (`/dev` routes) never hit this.
 */
async function pinnedConversationExists(db: Database, id: string | undefined): Promise<boolean> {
  if (id === undefined) return false;
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, id));
  return rows.length > 0;
}

/**
 * The seed model ids are resolved from the live catalog (never hardcoded)
 * so a retired model id can never break the E2E retry path, which picks the
 * existing AI message's model. Cycles when fewer than `count` text models
 * are exposed.
 */
export async function pickSeedTextModels(
  db: Database,
  telemetry: Telemetry,
  requested: number
): Promise<string[]> {
  const descriptors = await listDescriptors({ db, telemetry });
  const textIds = descriptors
    .unwrapOr([])
    .filter((descriptor) => descriptor.outputs.includes('text'))
    .map((descriptor) => descriptor.id)
    .toSorted((a, b) => a.localeCompare(b));
  if (textIds.length === 0) {
    throw new DevSeedError('dev seed: no text models exposed in the model catalog');
  }
  return Array.from({ length: requested }, (_, index) =>
    requireSeed(textIds[index % textIds.length], 'model pick')
  );
}

interface EpochSetup {
  readonly conversationId: string;
  readonly epochPublicKey: Uint8Array;
}

/**
 * Creates the conversation row, first epoch, wraps and member rows for an
 * ordered member set (owner first) through the conversations stores.
 */
interface SeedConversationShellOptions {
  /** Plaintext title, encrypted to the epoch (empty string ⇒ untitled). */
  readonly title: string;
  // A caller may pin a deterministic conversation id (the marketing seed
  // navigates screenshots to a known `/chat/{id}`); runtime `/dev` callers
  // pass none and get a fresh random id.
  readonly conversationId?: string | undefined;
}

async function seedConversationShell(
  db: Database,
  members: readonly SeedUser[],
  pendingEmails: ReadonlySet<string>,
  options: SeedConversationShellOptions
): Promise<EpochSetup> {
  const conversationId = options.conversationId ?? crypto.randomUUID();
  const owner = requireSeed(members[0], 'owner');
  const epoch = createFirstEpoch(
    members.map((member) => member.publicKey),
    conversationId,
    1
  );

  // One transaction, matching the production epoch-1 bootstrap: a conversation
  // row names its current epoch through a deferred foreign key, so the row and
  // the epoch it points at must reach COMMIT together. Two sequential awaits on
  // a non-transactional connection are two autocommits, and the deferral cannot
  // span them.
  await db.transaction(async (tx) => {
    const stores = createConversationsStores(tx);

    requireSeed(
      unwrapSeed(
        await stores.conversations.insert({
          id: conversationId,
          ownerUserId: owner.id,
          title: encryptTextForEpoch(epoch.epochPublicKey, options.title, {
            conversationId,
            epochNumber: 1,
          }),
        }),
        'conversation insert'
      ),
      'conversation row'
    );

    const epochRow = unwrapSeed(
      await stores.epochs.insert({
        conversationId,
        epochNumber: 1,
        previousEpochId: null,
        epochPublicKey: epoch.epochPublicKey,
        confirmationHash: epoch.confirmationHash,
        chainLink: null,
      }),
      'epoch insert'
    );

    unwrapSeed(
      await stores.epochs.insertWraps(
        epoch.memberWraps.map((wrap) => ({
          epochId: epochRow.id,
          memberPublicKey: wrap.memberPublicKey,
          wrap: wrap.wrap,
          visibleFromEpoch: 1,
        }))
      ),
      'epoch wraps insert'
    );

    for (const [index, member] of members.entries()) {
      unwrapSeed(
        await stores.members.insert({
          conversationId,
          userId: member.id,
          privilege: index === 0 ? 'owner' : 'admin',
          visibleFromEpoch: 1,
          // Owner is never pending; otherwise honour the pending set (used to
          // seed the decline-invite E2E flow).
          acceptedAt: index === 0 || !pendingEmails.has(member.email) ? new Date() : null,
          invitedByUserId: index === 0 ? null : owner.id,
        }),
        'member insert'
      );
    }
  });

  return { conversationId, epochPublicKey: epoch.epochPublicKey };
}

function resolveParentId(
  parent: SeedMessage['parent'],
  messageIds: readonly string[]
): string | null {
  if (parent === 'none') return null;
  // 'first' siblings always follow the seeded user message.
  if (parent === 'first') return requireSeed(messageIds[0], 'fan-out parent');
  return messageIds.at(-1) ?? null;
}

/**
 * A media message's persistence identity, minted BEFORE the transaction: the
 * ciphertext already sits in R2 under a key binding the message and content
 * ids, and its AAD binds them too, so both — and the epoch wrap the bytes were
 * encrypted under — exist before any row does. Settlement's media path
 * pre-mints the same way.
 */
interface SeedMediaContent {
  readonly messageId: string;
  readonly contentItemId: string;
  readonly wrappedContentKey: Uint8Array;
  readonly contentType: 'image' | 'video';
  readonly storageKey: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number | null;
}

interface SeedMessageBase {
  readonly senderType: 'user' | 'ai';
  readonly senderId: string;
  readonly modelId: string | null;
  readonly costNanoUsd: bigint | null;
  /** 'chain' parents onto the previous message; 'first' parents onto message 0. */
  readonly parent: 'chain' | 'first' | 'none';
  readonly batchId: string;
}

/** A seeded message carries either text to encrypt or an already-stored media object. */
type SeedMessage =
  | (SeedMessageBase & { readonly content: string; readonly media?: undefined })
  | (SeedMessageBase & { readonly media: SeedMediaContent });

/**
 * Who pays for a seeded turn, and the Redis its post-commit snapshot
 * write-through needs. `redis: null` is legal only for a seed with no costed
 * message; a costed one without it would leave admission's snapshot
 * stale-high, so it fails instead.
 */
interface SeedPayer {
  readonly userId: string;
  readonly redis: Redis | null;
}

/** A costed seed's resolved charge target: the debited wallet and its snapshot's Redis. */
interface SeedCharging {
  readonly walletId: string;
  readonly redis: Redis;
}

/**
 * The purchased wallet a seeded charge debits — the one registration
 * provisions, and the one a self-funded turn draws on while it holds a
 * positive balance. A user row inserted outside registration has none and
 * could not fund a turn in production either, so the seed refuses rather than
 * writing a costed turn nothing was charged for.
 */
async function resolveSeedCharging(db: Database, payer: SeedPayer): Promise<SeedCharging> {
  const stores = createBillingStores();
  const walletsRead = await stores.readWallets(db, payer.userId);
  const purchased = walletsRead.unwrapOr([]).find((wallet) => wallet.type === 'purchased');
  if (purchased === undefined) {
    throw new DevSeedError(`dev seed: no purchased wallet for payer ${payer.userId}`);
  }
  return { walletId: purchased.id, redis: requireSeed(payer.redis, 'snapshot redis') };
}

/** What a seeded charge records about the generation behind its content. */
type SeedChargeDimension =
  | { readonly modality: 'text' }
  | { readonly modality: 'image'; readonly media: MediaGenerationFacts }
  | { readonly modality: 'video' };

/**
 * The content-item row a seed message persists, paired with the epoch-wrapped
 * content key its message row carries and the dimension its charge records. A
 * text message mints the key pair here (fresh content key, envelope under the
 * full-location AAD); a media message carries the pair minted before its
 * ciphertext was stored.
 */
function seedContentPlan(
  seed: SeedMessage,
  epochPublicKey: EpochPublicKey,
  location: { readonly conversationId: string; readonly messageId: string }
): {
  readonly wrappedContentKey: Uint8Array;
  readonly item: ChatContentItemInput;
  readonly charge: SeedChargeDimension;
} {
  if (seed.media !== undefined) {
    const { contentType } = seed.media;
    return {
      wrappedContentKey: seed.media.wrappedContentKey,
      // One stored object per seeded media turn, so an image generation always
      // records a count; the video arm carries no dimension, matching the only
      // producer of these facts.
      charge:
        contentType === 'image'
          ? { modality: 'image', media: { imageCount: 1 } }
          : { modality: 'video' },
      item: {
        id: seed.media.contentItemId,
        messageId: location.messageId,
        position: 0,
        contentType: seed.media.contentType,
        storageKey: seed.media.storageKey,
        mimeType: seed.media.mimeType,
        sizeBytes: seed.media.sizeBytes,
        width: seed.media.width,
        height: seed.media.height,
        durationMs: seed.media.durationMs,
        modelId: seed.modelId,
        providerName: seed.modelId === null ? null : 'dev',
        costNanoUsd: seed.costNanoUsd,
        isSmartModel: false,
      },
    };
  }
  const contentItemId = crypto.randomUUID();
  const contentKey = generateContentKey();
  const wrappedContentKey = wrapContentKeyToEpoch(epochPublicKey, contentKey);
  return {
    wrappedContentKey,
    item: {
      id: contentItemId,
      messageId: location.messageId,
      position: 0,
      encryptedBlob: encryptContentEnvelope(
        contentKey,
        wrappedContentKey,
        {
          conversationId: location.conversationId,
          messageId: location.messageId,
          contentItemId,
          position: 0,
          epochNumber: 1,
          senderId: seed.senderId,
        },
        { plaintext: new TextEncoder().encode(seed.content), compression: 'raw' }
      ),
      modelId: seed.modelId,
      providerName: seed.modelId === null ? null : 'dev',
      costNanoUsd: seed.costNanoUsd,
    },
    charge: { modality: 'text' },
  };
}

/**
 * Persists seed messages exactly the way settlement does: a reserved
 * sequence block, a fresh wrap-once content key per message, the
 * full-location AAD (including senderId) on every content envelope, and —
 * for every message carrying a cost — the matching `usage_records` charge in
 * the SAME transaction. Saved ⟺ billed is an insert-time invariant: a
 * content item with a cost and no usage record is a state settlement cannot
 * produce, so a seed that wrote one would be a fixture no production run can
 * reach.
 */
async function persistSeedMessages(
  db: Database,
  setup: EpochSetup,
  seedMessages: readonly SeedMessage[],
  payer: SeedPayer
): Promise<string[]> {
  if (seedMessages.length === 0) return [];
  const chatStores = createChatStores();
  const billingStores = createBillingStores();
  const epochPublicKey = asEpochPublicKey(setup.epochPublicKey);
  const costed = seedMessages.some((seed) => seed.costNanoUsd !== null);
  const charging = costed ? await resolveSeedCharging(db, payer) : null;
  // One seeded turn is one run, so its siblings' charges share a runId the
  // way settlement groups a multi-model turn's charges.
  const runId = crypto.randomUUID();
  const now = new Date();

  const messageIds = await runSettlement(db, async (tx: SettlementTx) => {
    const txConversations = createConversationsStores(tx);
    const block = unwrapSeed(
      await reserveSequenceBlockWithinTx(txConversations, {
        conversationId: setup.conversationId,
        count: seedMessages.length,
      }),
      'sequence reservation'
    );

    const messageIds: string[] = [];
    for (const [index, seed] of seedMessages.entries()) {
      const sequenceNumber = requireSeed(block[index], 'sequence number');
      const messageId = seed.media?.messageId ?? crypto.randomUUID();
      const parentMessageId = resolveParentId(seed.parent, messageIds);

      const plan = seedContentPlan(seed, epochPublicKey, {
        conversationId: setup.conversationId,
        messageId,
      });
      await chatStores.insertMessageWithinTx(tx, {
        id: messageId,
        conversationId: setup.conversationId,
        senderType: seed.senderType === 'ai' ? 'assistant' : 'user',
        senderId: seed.senderId,
        wrappedContentKey: plan.wrappedContentKey,
        epochNumber: 1,
        sequenceNumber,
        parentMessageId,
        batchId: seed.batchId,
      });

      await chatStores.insertContentItemWithinTx(tx, plan.item);
      if (seed.costNanoUsd !== null) {
        await chargeWithinTx(billingStores, tx, {
          walletId: requireSeed(charging, 'payer charging').walletId,
          payerUserId: payer.userId,
          sender: { kind: 'user', userId: seed.senderId },
          runId,
          contentItemId: plan.item.id,
          modelId: requireSeed(seed.modelId, 'charge model'),
          providerName: 'dev',
          ...plan.charge,
          // The seeded cost is the whole charge: settlement's split between
          // billable model cost and the additive storage fee is not
          // observable on any row it writes, so there is nothing to synthesise.
          billableCostNanoUsd: seed.costNanoUsd,
          storageFeeNanoUsd: 0n,
          isEstimated: false,
          idempotencyKey: `seed:usage:${plan.item.id}`,
          now,
        });
      }
      messageIds.push(messageId);
    }
    if (charging !== null) {
      await billingStores.stampRunConversationWithinTx(tx, runId, setup.conversationId);
    }
    return messageIds;
  });

  if (charging !== null) {
    // Post-commit, and best-effort: admission's snapshot is advisory and CASes
    // on ledgerSeq, so a failed write-through self-heals on the next one — but
    // an unrefreshed snapshot reads stale-high for its whole TTL, which is a
    // spendable figure that lies. A Redis hiccup must not fail a seed the
    // database has already committed, so the failure is swallowed the way the
    // production charge path and `setWalletBalance` swallow theirs.
    await refreshWalletSnapshot(
      { db, redis: charging.redis, stores: billingStores },
      charging.walletId
    ).unwrapOr(null);
  }
  return messageIds;
}

interface CreateDevConversationParams {
  readonly ownerEmail: string;
  readonly seedAiModel: string;
  readonly messages?: readonly { content: string; senderType: 'user' | 'ai' }[] | undefined;
  /** Plaintext conversation title; encrypted to the epoch. Defaults to empty. */
  readonly title?: string | undefined;
  /** Optional deterministic conversation id; defaults to a fresh random uuid. */
  readonly id?: string | undefined;
}

interface CreateDevConversationResult {
  readonly conversationId: string;
}

/** Single-user conversation, optionally pre-populated with a linear chain of messages. */
export async function createDevConversation(
  db: Database,
  params: CreateDevConversationParams
): Promise<CreateDevConversationResult> {
  if (params.id !== undefined && (await pinnedConversationExists(db, params.id))) {
    return { conversationId: params.id };
  }
  const owner = await requireUser(db, params.ownerEmail);
  const setup = await seedConversationShell(db, [owner], new Set(), {
    title: params.title ?? '',
    conversationId: params.id,
  });
  const batchId = crypto.randomUUID();
  await persistSeedMessages(
    db,
    setup,
    (params.messages ?? []).map((message) => ({
      senderType: message.senderType,
      senderId: owner.id,
      content: message.content,
      modelId: message.senderType === 'ai' ? params.seedAiModel : null,
      costNanoUsd: null,
      parent: 'chain',
      batchId,
    })),
    { userId: owner.id, redis: null }
  );
  return { conversationId: setup.conversationId };
}

interface CreateDevMultiModelConversationParams {
  readonly ownerEmail: string;
  readonly userContent: string;
  readonly aiResponses: readonly { content: string; modelName: string; costNanoUsd: bigint }[];
  /** Plaintext conversation title; encrypted to the epoch. Defaults to empty. */
  readonly title?: string | undefined;
  /** Optional deterministic conversation id; defaults to a fresh random uuid. */
  readonly id?: string | undefined;
}

/**
 * One user message and N sibling AI messages persisted in one settlement —
 * the exact shape the multi-model turn writes: one shared batchId across
 * the user message and every AI sibling, each sibling parented onto the
 * user message, sequential sequence numbers, a visible cost per sibling.
 */
export async function createDevMultiModelConversation(
  db: Database,
  redis: Redis,
  params: CreateDevMultiModelConversationParams
): Promise<CreateDevConversationResult> {
  if (params.id !== undefined && (await pinnedConversationExists(db, params.id))) {
    return { conversationId: params.id };
  }
  const owner = await requireUser(db, params.ownerEmail);
  const setup = await seedConversationShell(db, [owner], new Set(), {
    title: params.title ?? '',
    conversationId: params.id,
  });
  const batchId = crypto.randomUUID();
  await persistSeedMessages(
    db,
    setup,
    [
      {
        senderType: 'user',
        senderId: owner.id,
        content: params.userContent,
        modelId: null,
        costNanoUsd: null,
        parent: 'none',
        batchId,
      },
      ...params.aiResponses.map(
        (response): SeedMessage => ({
          senderType: 'ai',
          senderId: owner.id,
          content: response.content,
          modelId: response.modelName,
          costNanoUsd: response.costNanoUsd,
          parent: 'first',
          batchId,
        })
      ),
    ],
    { userId: owner.id, redis }
  );
  return { conversationId: setup.conversationId };
}

interface CreateDevGroupChatParams {
  readonly ownerEmail: string;
  readonly memberEmails: readonly string[];
  readonly pendingMemberEmails?: readonly string[];
  readonly seedAiModel: string;
  readonly messages?: readonly {
    senderEmail?: string | undefined;
    content: string;
    senderType: 'user' | 'ai';
  }[];
  /** Plaintext conversation title; encrypted to the epoch. Defaults to empty. */
  readonly title?: string | undefined;
  /** Optional deterministic conversation id; defaults to a fresh random uuid. */
  readonly id?: string | undefined;
}

interface CreateDevGroupChatResult {
  readonly conversationId: string;
  readonly members: { userId: string; username: string; email: string }[];
}

/** Group conversation with first-epoch wraps for every member. */
export async function createDevGroupChat(
  db: Database,
  params: CreateDevGroupChatParams
): Promise<CreateDevGroupChatResult> {
  const allEmails = [params.ownerEmail, ...params.memberEmails];
  const found = await findUsersByEmail(db, allEmails);
  const owner = found.find((user) => user.email === params.ownerEmail);
  if (owner === undefined) throw new DevSeedError(`Owner not found: ${params.ownerEmail}`);
  const ordered = [
    owner,
    ...params.memberEmails.map((email) => {
      const member = found.find((user) => user.email === email);
      if (member === undefined) throw new DevSeedError(`Member not found: ${email}`);
      return member;
    }),
  ];

  if (params.id !== undefined && (await pinnedConversationExists(db, params.id))) {
    return {
      conversationId: params.id,
      members: ordered.map((member) => ({
        userId: member.id,
        username: member.username,
        email: member.email,
      })),
    };
  }

  const setup = await seedConversationShell(db, ordered, new Set(params.pendingMemberEmails), {
    title: params.title ?? '',
    conversationId: params.id,
  });
  const batchId = crypto.randomUUID();
  await persistSeedMessages(
    db,
    setup,
    (params.messages ?? []).map((message) => ({
      senderType: message.senderType,
      // AAD binds senderId; an unattributed legacy message (no senderEmail)
      // is attributed to the owner in the new shape (senderId is required).
      senderId:
        message.senderType === 'user' && message.senderEmail !== undefined
          ? (ordered.find((user) => user.email === message.senderEmail)?.id ?? owner.id)
          : owner.id,
      content: message.content,
      modelId: message.senderType === 'ai' ? params.seedAiModel : null,
      costNanoUsd: null,
      parent: 'chain',
      batchId,
    })),
    { userId: owner.id, redis: null }
  );

  return {
    conversationId: setup.conversationId,
    members: ordered.map((user) => ({
      userId: user.id,
      username: user.username,
      email: user.email,
    })),
  };
}

interface CreateDevMediaConversationParams {
  readonly ownerEmail: string;
  readonly userContent: string;
  readonly mediaType: 'image' | 'video';
  readonly modelId: string;
  readonly costNanoUsd: bigint;
  /** Plaintext conversation title; encrypted to the epoch. Defaults to empty. */
  readonly title?: string | undefined;
  /** Optional deterministic conversation id; defaults to a fresh random uuid. */
  readonly id?: string | undefined;
}

interface CreateDevMediaConversationResult {
  readonly conversationId: string;
  readonly assistantMessageId: string;
}

/**
 * Seeds a finished image/video turn mirroring the generation pipeline: one
 * envelope's content key both wraps into the assistant message and encrypts
 * the bytes stored under the production `media/{conv}/{msg}/{uuid}` key, so
 * the client unwraps once and decrypts the download. The bytes are stored
 * before any row exists; a later failure leaves an orphan the GC reclaims
 * (min-age grace protects the fresh object).
 */
export async function createDevMediaConversation(
  db: Database,
  storage: Storage,
  redis: Redis,
  params: CreateDevMediaConversationParams
): Promise<CreateDevMediaConversationResult> {
  const owner = await requireUser(db, params.ownerEmail);
  const setup = await seedConversationShell(db, [owner], new Set(), {
    title: params.title ?? '',
    conversationId: params.id,
  });
  const fixture = DEV_MEDIA_FIXTURES[params.mediaType];
  const epochPublicKey = asEpochPublicKey(setup.epochPublicKey);
  const batchId = crypto.randomUUID();

  const assistantMessageId = crypto.randomUUID();
  const contentItemId = crypto.randomUUID();
  const storageKey = mediaObjectKey({
    conversationId: setup.conversationId,
    messageId: assistantMessageId,
    objectId: contentItemId,
  });

  const contentKey = generateContentKey();
  const wrappedContentKey = wrapContentKeyToEpoch(epochPublicKey, contentKey);
  // Same wrap-once envelope as text content (full-location AAD): the client
  // unwraps the message's content key once and decrypts the download.
  const ciphertext = encryptContentEnvelope(
    contentKey,
    wrappedContentKey,
    {
      conversationId: setup.conversationId,
      messageId: assistantMessageId,
      contentItemId,
      position: 0,
      epochNumber: 1,
      senderId: owner.id,
    },
    { plaintext: fixture.bytes, compression: 'raw' }
  );

  unwrapStoragePut(
    await storage.put(storageKey, ciphertext, { contentType: 'application/octet-stream' }),
    'media upload'
  );

  await persistSeedMessages(
    db,
    setup,
    [
      {
        senderType: 'user',
        senderId: owner.id,
        content: params.userContent,
        modelId: null,
        costNanoUsd: null,
        parent: 'none',
        batchId,
      },
      {
        senderType: 'ai',
        senderId: owner.id,
        modelId: params.modelId,
        costNanoUsd: params.costNanoUsd,
        parent: 'chain',
        batchId,
        media: {
          messageId: assistantMessageId,
          contentItemId,
          wrappedContentKey,
          contentType: fixture.contentType,
          storageKey,
          mimeType: fixture.mimeType,
          sizeBytes: ciphertext.byteLength,
          width: fixture.width,
          height: fixture.height,
          durationMs: fixture.durationMs ?? null,
        },
      },
    ],
    { userId: owner.id, redis }
  );

  return { conversationId: setup.conversationId, assistantMessageId };
}
