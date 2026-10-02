/**
 * The shared seed for a test that needs an ordinary conversation row.
 *
 * `conversations.current_epoch` is a deferred foreign key into `epochs`, so a
 * conversation row and the epoch it names must reach COMMIT together. A fixture
 * that inserts them as two autocommitted statements is refused by the database,
 * and one that inserts the conversation alone is refused outright. Routing a test
 * through this function is what keeps that pair atomic in one place instead of in
 * every suite that needs a conversation.
 *
 * It lives outside `apps/api/src/slices/` because it writes two slices' tables directly;
 * single-writer-per-table exempts this tree for exactly that reason.
 */
import { and, eq, sql } from 'drizzle-orm';
import { conversationMembers, conversations, epochMembers, epochs, users } from '@hushbox/db';
import type { DbWriter } from '../lib/idempotency/index.js';

/** Filler bytes for the columns a caller did not pin. */
const PLACEHOLDER = new Uint8Array([1, 2, 3, 4]);

interface SeedConversationOptions {
  /** Owner of the conversation. */
  readonly userId: string;
  /** Pins the conversation id; omit for a database-minted one. */
  readonly id?: string | undefined;
  readonly title?: Uint8Array | undefined;
  readonly titleEpochNumber?: number | undefined;
  /**
   * The epoch the conversation names. Every epoch from 1 up to it is seeded, so
   * a rotated conversation gets the chain its number implies.
   */
  readonly currentEpoch?: number | undefined;
  readonly conversationBudgetNanoUsd?: bigint | undefined;
  /** Applied to the named (highest) epoch; earlier epochs get placeholders. */
  readonly epochPublicKey?: Uint8Array | undefined;
  readonly confirmationHash?: Uint8Array | undefined;
}

interface SeededConversation {
  readonly conversationId: string;
  /** Row id of the epoch the conversation names — the wrap target. */
  readonly epochId: string;
}

export async function seedConversationWithEpoch(
  db: DbWriter,
  options: SeedConversationOptions
): Promise<SeededConversation> {
  const currentEpoch = options.currentEpoch ?? 1;
  const confirmationHash = options.confirmationHash ?? PLACEHOLDER;

  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .insert(conversations)
      .values({
        ...(options.id === undefined ? {} : { id: options.id }),
        userId: options.userId,
        title: options.title ?? PLACEHOLDER,
        ...(options.titleEpochNumber === undefined
          ? {}
          : { titleEpochNumber: options.titleEpochNumber }),
        currentEpoch,
        ...(options.conversationBudgetNanoUsd === undefined
          ? {}
          : { conversationBudgetNanoUsd: options.conversationBudgetNanoUsd }),
      })
      .returning({ id: conversations.id });
    if (conversation === undefined) throw new Error('conversation seed failed');

    const epochRows = await tx
      .insert(epochs)
      .values(
        Array.from({ length: currentEpoch }, (_unused, index) => ({
          conversationId: conversation.id,
          epochNumber: index + 1,
          epochPublicKey:
            index + 1 === currentEpoch ? (options.epochPublicKey ?? PLACEHOLDER) : PLACEHOLDER,
          confirmationHash,
        }))
      )
      .returning({ id: epochs.id, epochNumber: epochs.epochNumber });

    const named = epochRows.find((row) => row.epochNumber === currentEpoch);
    if (named === undefined) throw new Error('epoch seed failed');
    return { conversationId: conversation.id, epochId: named.id };
  });
}

interface SeatCurrentEpochHolderOptions {
  readonly conversationId: string;
  /** An existing user; its public key is replaced by the one the wrap is keyed to. */
  readonly userId: string;
  /** Stamps the seat's `left_at`: a departure no rotation has yet dropped the key for. */
  readonly departed?: boolean | undefined;
}

/**
 * Seats a write member whose own key holds a wrap in the conversation's current
 * epoch, and returns that member row's id. A departed seat keeps its wrap, which is
 * the state a pending rotation is derived from.
 */
export async function seatCurrentEpochHolder(
  db: DbWriter,
  options: SeatCurrentEpochHolderOptions
): Promise<string> {
  const publicKey = crypto.getRandomValues(new Uint8Array(32));
  await db.update(users).set({ publicKey }).where(eq(users.id, options.userId));
  const [member] = await db
    .insert(conversationMembers)
    .values({
      conversationId: options.conversationId,
      userId: options.userId,
      privilege: 'write',
      visibleFromEpoch: 1,
      ...(options.departed === true ? { leftAt: sql`now()` } : {}),
    })
    .returning({ id: conversationMembers.id });
  if (member === undefined) throw new Error('member seed failed');
  const [current] = await db
    .select({ id: epochs.id })
    .from(epochs)
    .innerJoin(
      conversations,
      and(
        eq(conversations.id, epochs.conversationId),
        eq(conversations.currentEpoch, epochs.epochNumber)
      )
    )
    .where(eq(epochs.conversationId, options.conversationId));
  if (current === undefined) throw new Error('current epoch not found');
  await db.insert(epochMembers).values({
    epochId: current.id,
    memberPublicKey: publicKey,
    wrap: PLACEHOLDER,
    visibleFromEpoch: 1,
  });
  return member.id;
}
