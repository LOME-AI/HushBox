import { eq, or } from 'drizzle-orm';
import { users } from '@hushbox/db';
import { canonicalIdentifier, nanoUSD, serializeNanoUSD } from '@hushbox/shared';
import { setChecksumOverride } from '../middleware/checksum-override.js';
import { setVersionOverride } from '../middleware/version-override.js';
import { createBillingStores, seedUsageHistory } from '../slices/billing/index.js';
import { deleteSharedMessageById } from '../slices/conversations/index.js';
import {
  requireSeed,
  createDevConversation,
  createDevGroupChat,
  createDevMediaConversation,
  createDevMultiModelConversation,
  pickSeedTextModels,
} from './factories.js';
import type {
  conversationBodySchema,
  groupChatBodySchema,
  usageHistoryBodySchema,
} from './route-schemas.js';
import type { z } from 'zod';
import type { AuthResetIdentity } from './redis-resets.js';
import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { Storage } from '../slices/media/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';

/** Distinct, positive seed costs ((2+i)/1000 USD) so cost badges render. */
function multiModelCostNanoUsd(index: number): bigint {
  return BigInt(2 + index) * 1_000_000n;
}

/** The media seed's fixed content-item cost (0.003 USD). */
const MEDIA_SEED_COST_NANO_USD = 3_000_000n;

type ConversationBody = z.infer<typeof conversationBodySchema>;

type GroupChatBody = z.infer<typeof groupChatBodySchema>;

type UsageHistoryBody = z.infer<typeof usageHistoryBodySchema>;

export async function seedConversationWork(
  db: Database,
  redis: Redis,
  logger: Telemetry,
  body: ConversationBody
): Promise<{ conversationId: string }> {
  const { aiTurn, ...rest } = body;
  if (aiTurn !== undefined) {
    const models = await pickSeedTextModels(db, logger, aiTurn.responseCount);
    return createDevMultiModelConversation(db, redis, {
      ownerEmail: rest.ownerEmail,
      userContent: aiTurn.userContent,
      aiResponses: models.map((modelName, index) => ({
        content: `Echo: ${aiTurn.userContent}`,
        modelName,
        costNanoUsd: multiModelCostNanoUsd(index),
      })),
    });
  }
  const [seedAiModel] = await pickSeedTextModels(db, logger, 1);
  return createDevConversation(db, {
    ownerEmail: rest.ownerEmail,
    seedAiModel: requireSeed(seedAiModel, 'seed model'),
    ...(rest.messages === undefined ? {} : { messages: rest.messages }),
    ...(rest.title === undefined ? {} : { title: rest.title }),
  });
}

interface MediaSeedDeps {
  readonly db: Database;
  readonly storage: Storage;
  readonly redis: Redis;
  readonly logger: Telemetry;
}

export async function seedMediaWork(
  deps: MediaSeedDeps,
  body: { ownerEmail: string; userContent: string; mediaType: 'image' | 'video' }
): Promise<{ conversationId: string; assistantMessageId: string }> {
  const { db, storage, redis, logger } = deps;
  const [modelId] = await pickSeedTextModels(db, logger, 1);
  return createDevMediaConversation(db, storage, redis, {
    ...body,
    modelId: requireSeed(modelId, 'seed model'),
    costNanoUsd: MEDIA_SEED_COST_NANO_USD,
  });
}

export async function seedGroupChatWork(
  db: Database,
  logger: Telemetry,
  body: GroupChatBody
): Promise<{
  conversationId: string;
  members: { userId: string; username: string; email: string }[];
}> {
  const { messages: rawMessages, pendingMemberEmails, ...rest } = body;
  const [seedAiModel] = await pickSeedTextModels(db, logger, 1);
  return createDevGroupChat(db, {
    ...rest,
    seedAiModel: requireSeed(seedAiModel, 'seed model'),
    ...(pendingMemberEmails === undefined ? {} : { pendingMemberEmails }),
    ...(rawMessages === undefined ? {} : { messages: rawMessages }),
  });
}

/**
 * Backdated usage rows through billing's own seeding routine. Each record's
 * arbitration key is minted here rather than taken from the caller: the routine
 * deduplicates on it, so callers sharing a conversation would otherwise have
 * one caller's rows silently absorbed into the other's.
 */
export async function seedUsageHistoryWork(
  db: Database,
  body: UsageHistoryBody
): Promise<{ usageRecordsCreated: number; totalChargedNanoUsd: string }> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, body.ownerEmail.toLowerCase()));
  const userId = requireSeed(user, 'usage-history owner').id;
  const walletsRead = await createBillingStores().readWallets(db, userId);
  const wallet = requireSeed(
    walletsRead.unwrapOr([]).find((row) => row.type === 'purchased'),
    'usage-history purchased wallet'
  );
  const outcome = await seedUsageHistory(
    { db },
    {
      userId,
      walletId: wallet.id,
      conversationId: body.conversationId,
      records: body.records.map((spec) => ({
        stableKey: crypto.randomUUID(),
        modelId: spec.modelId,
        providerName: spec.providerName,
        modality: 'text' as const,
        billableCostNanoUsd: spec.costNanoUsd,
        tokens: { inputTokens: spec.inputTokens, outputTokens: spec.outputTokens },
        createdAt: new Date(spec.createdAt),
      })),
    }
  );
  return {
    usageRecordsCreated: outcome.usageRecordsCreated,
    totalChargedNanoUsd: serializeNanoUSD(nanoUSD(outcome.totalChargedNanoUsd)),
  };
}

/**
 * Each named identifier in the form the limiters key it, paired with the
 * account it resolves to. An identifier that resolves to none still carries the
 * email-keyed throttles, so it is returned with a null account rather than
 * refused — unlike `/dev/totp-replay`, whose whole subject is a user's markers.
 */
export async function resolveAuthResetIdentities(
  db: Database,
  identifiers: readonly string[]
): Promise<AuthResetIdentity[]> {
  // One lookup after the other: the request's database is serial and refuses
  // a lookup issued while another is in flight.
  const identities: AuthResetIdentity[] = [];
  for (const raw of identifiers) {
    const canonical = canonicalIdentifier(raw);
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(or(eq(users.email, canonical), eq(users.username, canonical)));
    identities.push({ canonical, userId: user?.id ?? null });
  }
  return identities;
}

export async function revokeShareWork(
  db: Database,
  shareId: string
): Promise<{ rowsAffected: number }> {
  return { rowsAffected: await deleteSharedMessageById(db, shareId) };
}

export function setVersionWork(version: string): Promise<{ version: string }> {
  setVersionOverride(version);
  return Promise.resolve({ version });
}

export function setChecksumWork(
  platform: string,
  checksum: string
): Promise<{ platform: string; checksum: string }> {
  setChecksumOverride(platform, checksum);
  return Promise.resolve({ platform, checksum });
}
