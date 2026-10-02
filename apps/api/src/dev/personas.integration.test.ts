import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversations,
  createDb,
  messages,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { DEV_EMAIL_DOMAIN } from '@hushbox/shared';
import { seedConversationWithEpoch } from '../test-support/conversation-seed.js';
import { listDevPersonas } from './personas.js';
import type { DevPersona } from '@hushbox/shared';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for persona listing integration tests`);
  }
  return value;
}

const db = createDb(requiredEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });

const createdUserIds: string[] = [];

interface SeededPersona {
  readonly id: string;
  readonly email: string;
  readonly username: string;
}

async function seedPersona(options: {
  readonly emailVerified?: boolean;
  readonly conversationCount?: number;
  readonly messagesPerConversation?: number;
  readonly purchasedNanoUsd?: bigint;
  readonly freeNanoUsd?: bigint;
}): Promise<SeededPersona> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const email = `persona-${suffix}@${DEV_EMAIL_DOMAIN}`;
  const username = `pq${suffix}`;
  const [row] = await db
    .insert(users)
    .values(
      userFactory.build({
        email,
        username,
        emailVerified: options.emailVerified ?? false,
      })
    )
    .returning({ id: users.id });
  if (row === undefined) throw new Error('persona seed failed');
  createdUserIds.push(row.id);

  for (let index = 0; index < (options.conversationCount ?? 0); index += 1) {
    const { conversationId } = await seedConversationWithEpoch(db, { userId: row.id });
    const perConversation = options.messagesPerConversation ?? 0;
    if (perConversation > 0) {
      await db.insert(messages).values(
        Array.from({ length: perConversation }, (_unused, position) => ({
          conversationId,
          senderType: 'user' as const,
          wrappedContentKey: new Uint8Array([1, 2, 3, 4]),
          epochNumber: 1,
          sequenceNumber: position + 1,
        }))
      );
    }
  }

  const walletValues = [
    ...(options.purchasedNanoUsd === undefined
      ? []
      : [{ userId: row.id, type: 'purchased' as const, balanceNanoUsd: options.purchasedNanoUsd }]),
    ...(options.freeNanoUsd === undefined
      ? []
      : [{ userId: row.id, type: 'free' as const, balanceNanoUsd: options.freeNanoUsd }]),
  ];
  if (walletValues.length > 0) await db.insert(wallets).values(walletValues);

  return { id: row.id, email, username };
}

/** Counts the statements one `listDevPersonas` call sends over the pool. */
async function queriesFor(type: 'dev' | 'test'): Promise<number> {
  const spy = vi.spyOn(db.$client, 'query');
  try {
    await listDevPersonas(db, type);
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

async function personaFor(email: string): Promise<DevPersona | undefined> {
  const personas = await listDevPersonas(db, 'dev');
  return personas.find((persona) => persona.email === email);
}

let rich: SeededPersona;
let bare: SeededPersona;
let extras: SeededPersona[];

beforeAll(async () => {
  rich = await seedPersona({
    emailVerified: true,
    conversationCount: 2,
    messagesPerConversation: 3,
    purchasedNanoUsd: 5_000_000_000n,
    freeNanoUsd: 1_234_000_000n,
  });
  bare = await seedPersona({});
  extras = [];
  for (let index = 0; index < 4; index += 1) {
    extras.push(
      await seedPersona({
        conversationCount: 1,
        messagesPerConversation: 2,
        freeNanoUsd: 5_000_000n,
      })
    );
  }
}, 120_000);

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(wallets).where(inArray(wallets.userId, createdUserIds));
    await db.delete(conversations).where(inArray(conversations.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

/** The pinned cost: personas, conversation totals, message totals, wallets. */
const PERSONA_QUERY_COUNT = 4;

describe('listDevPersonas query cost', () => {
  it('costs the same pinned number of queries however many personas exist', async () => {
    const overDevDomain = await queriesFor('dev');
    const overTestDomain = await queriesFor('test');
    expect(overDevDomain).toBe(PERSONA_QUERY_COUNT);
    expect(overTestDomain).toBe(PERSONA_QUERY_COUNT);
  });
});

describe('listDevPersonas response', () => {
  it('reports a persona’s conversation, message and wallet totals', async () => {
    expect(await personaFor(rich.email)).toEqual({
      id: rich.id,
      username: rich.username,
      email: rich.email,
      emailVerified: true,
      stats: { conversationCount: 2, messageCount: 6, projectCount: 0 },
      credits: '$6.23',
    });
  });

  it('reports zeroes for a persona with no conversations and no wallets', async () => {
    expect(await personaFor(bare.email)).toEqual({
      id: bare.id,
      username: bare.username,
      email: bare.email,
      emailVerified: false,
      stats: { conversationCount: 0, messageCount: 0, projectCount: 0 },
      credits: '$0.00',
    });
  });

  it('reports every seeded persona of the domain', async () => {
    const personas = await listDevPersonas(db, 'dev');
    const listed = new Set(personas.map((persona) => persona.email));
    for (const persona of extras) expect(listed.has(persona.email)).toBe(true);
  });
});
