import { count, eq, like } from 'drizzle-orm';
import { conversations, messages, users, wallets } from '@hushbox/db';
import { DEV_EMAIL_DOMAIN, TEST_EMAIL_DOMAIN } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { DevPersona } from '@hushbox/shared';

const NANO_PER_USD = 1_000_000_000n;

/** Wallet total (purchased + free) rendered as the legacy `$X.XX` credits string. */
export function formatCredits(purchasedNanoUsd: bigint, freeNanoUsd: bigint): string {
  const total = purchasedNanoUsd + freeNanoUsd;
  const negative = total < 0n;
  const magnitude = negative ? -total : total;
  const cents = (magnitude + NANO_PER_USD / 200n) / (NANO_PER_USD / 100n);
  const dollars = cents / 100n;
  const remainder = cents % 100n;
  return `${negative ? '-' : ''}$${String(dollars)}.${String(remainder).padStart(2, '0')}`;
}

/** Totals keyed by owner, for the personas the domain filter selected. */
function totalsByUser(rows: readonly { userId: string; total: number }[]): Map<string, number> {
  return new Map(rows.map((row) => [row.userId, row.total]));
}

/**
 * List dev or test personas with their stats. Semantic adaptations from
 * legacy: `projectCount` is always 0 (the projects feature was deliberately
 * deleted in the redesign; the field survives for response-shape parity) and
 * `credits` sums the purchased + free wallets.
 *
 * Every read is set-based over the whole domain. The seed mints personas per
 * E2E worker, so the domain grows with the worker count, and a per-persona
 * query makes this endpoint's cost grow with it. The wallet read needs no SQL
 * aggregate: the `wallets_user_type_unique` constraint caps it at one row per
 * type per persona, and the two types are what {@link formatCredits} takes.
 */
export async function listDevPersonas(db: Database, type: 'dev' | 'test'): Promise<DevPersona[]> {
  const emailPattern = `%@${type === 'test' ? TEST_EMAIL_DOMAIN : DEV_EMAIL_DOMAIN}`;

  const devUsers = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(like(users.email, emailPattern));

  const conversationRows = await db
    .select({ userId: users.id, total: count() })
    .from(conversations)
    .innerJoin(users, eq(users.id, conversations.userId))
    .where(like(users.email, emailPattern))
    .groupBy(users.id);

  const messageRows = await db
    .select({ userId: users.id, total: count() })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(users, eq(users.id, conversations.userId))
    .where(like(users.email, emailPattern))
    .groupBy(users.id);

  const walletRows = await db
    .select({ userId: users.id, type: wallets.type, balanceNanoUsd: wallets.balanceNanoUsd })
    .from(wallets)
    .innerJoin(users, eq(users.id, wallets.userId))
    .where(like(users.email, emailPattern));

  const conversationTotals = totalsByUser(conversationRows);
  const messageTotals = totalsByUser(messageRows);
  const balances = new Map<string, { purchased: bigint; free: bigint }>();
  for (const row of walletRows) {
    const balance = balances.get(row.userId) ?? { purchased: 0n, free: 0n };
    balances.set(row.userId, {
      purchased: row.type === 'purchased' ? row.balanceNanoUsd : balance.purchased,
      free: row.type === 'free' ? row.balanceNanoUsd : balance.free,
    });
  }

  return devUsers.map((user) => {
    const balance = balances.get(user.id);
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      emailVerified: user.emailVerified,
      stats: {
        conversationCount: conversationTotals.get(user.id) ?? 0,
        messageCount: messageTotals.get(user.id) ?? 0,
        projectCount: 0,
      },
      credits: formatCredits(balance?.purchased ?? 0n, balance?.free ?? 0n),
    };
  });
}
