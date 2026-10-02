import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { expectExposes } from '@hushbox/shared/test-assertions';
import { LOCAL_NEON_DEV_CONFIG, createDb, users } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { createIdentityStores } from '../../slices/identity/index.js';
import { runSettlement } from '../../lib/idempotency/index.js';
import {
  createAccountDefense,
  createAppAccountDefensePort,
  createSessionRevokeEnqueueRegistration,
  createWebhookVerifierFromEnv,
} from './billing-bindings.js';
import { createJobWakeCollector, grantJobWakes } from '../../lib/jobs/index.js';
import { bindRequestValue, requestScope } from '../../lib/context/index.js';
import type { SettlementTx } from '../../lib/idempotency/index.js';
import type { AppEnv } from '../../lib/context/index.js';
import type { IdentityUsersStore } from '../../slices/identity/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for billing-bindings integration tests');
}
const db = grantJobWakes(
  createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  createJobWakeCollector()
);
const stores = createIdentityStores(db);

const PREFIX = `zd${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
const createdUserIds: string[] = [];
const BYTES = new Uint8Array([1, 2, 3]);
let counter = 0;

async function seedUser(): Promise<{ id: string; email: string; username: string }> {
  counter += 1;
  const id = crypto.randomUUID();
  const email = `${PREFIX}u${String(counter)}@billing-bindings.test`;
  const username = `${PREFIX}u${String(counter)}`;
  const created = await runSettlement(db, (tx) =>
    stores.users.insertRegisteredWithinTx(tx, {
      ...userFactory.build({
        email,
        username,
        opaqueRegistration: BYTES,
        publicKey: BYTES,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      }),
      id,
    })
  );
  if (created.kind !== 'created') throw new Error('seed failed');
  createdUserIds.push(id);
  return { id, email, username };
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

function fakeStore(lock: IdentityUsersStore['lockForChargebackWithinTx']): IdentityUsersStore {
  return { lockForChargebackWithinTx: lock } as unknown as IdentityUsersStore;
}

// Runs a port call inside a real settlement (the fake store ignores the tx, so
// the transaction is a no-op) — mints a genuine SettlementTx without a brand cast.
function inSettlement(port: {
  lockForChargebackWithinTx: (tx: SettlementTx, userId: string) => Promise<unknown>;
}): (userId: string) => Promise<unknown> {
  return (userId) => runSettlement(db, (tx) => port.lockForChargebackWithinTx(tx, userId));
}

describe('createAccountDefense', () => {
  it('delegates the userId to the identity within-tx lock and returns its outcome', async () => {
    const calls: string[] = [];
    const port = createAccountDefense(() => ({
      users: fakeStore((_tx, userId) => {
        calls.push(userId);
        return Promise.resolve({ locked: true, email: 'victim@example.com', userName: 'victim' });
      }),
    }));
    const result = await inSettlement(port)('u1');
    expect(result).toEqual({ locked: true, email: 'victim@example.com', userName: 'victim' });
    expect(calls).toEqual(['u1']);
  });

  it('reports not-locked with a null email on the no-op (already-locked) path', async () => {
    const port = createAccountDefense(() => ({
      users: fakeStore(() => Promise.resolve({ locked: false, email: null, userName: null })),
    }));
    expect(await inSettlement(port)('u1')).toEqual({ locked: false, email: null, userName: null });
  });

  it('propagates a store failure — the lock is the must-succeed write that aborts the settlement', async () => {
    const port = createAccountDefense(() => ({
      users: fakeStore(() => Promise.reject(new Error('users update failed'))),
    }));
    await expect(inSettlement(port)('u1')).rejects.toThrow('users update failed');
  });

  it('resolves its dependencies freshly on every call', async () => {
    let resolves = 0;
    const port = createAccountDefense(() => {
      resolves += 1;
      return {
        users: fakeStore(() => Promise.resolve({ locked: false, email: null, userName: null })),
      };
    });
    await inSettlement(port)('a');
    await inSettlement(port)('b');
    expect(resolves).toBe(2);
  });
});

describe('createAppAccountDefensePort (context-bound)', () => {
  // Runs the defense port's within-tx lock inside a real settlement, resolving
  // the users store from hono's request context (as the webhook does).
  async function lock(
    userId: string
  ): Promise<{ locked: boolean; email: string | null; userName: string | null }> {
    const app = new Hono<AppEnv>();
    app.use(requestScope());
    app.post('/lock', async (c) => {
      bindRequestValue(c, 'db', db);
      const outcome = await runSettlement(db, (tx) =>
        createAppAccountDefensePort().lockForChargebackWithinTx(tx, userId)
      );
      return c.json(outcome);
    });
    const res = await app.request('/lock', { method: 'POST' });
    return await res.json();
  }

  it('locks the DB row through the context-bound users store', async () => {
    const user = await seedUser();
    const outcome = await lock(user.id);
    expect(outcome).toEqual({ locked: true, email: user.email, userName: user.username });
    const row = await db
      .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row[0]?.lockedAt).not.toBeNull();
    expect(row[0]?.lockReason).toBe('chargeback');
  });

  it('is idempotent — a second lock reports not-locked with a null email', async () => {
    const user = await seedUser();
    await lock(user.id);
    const second = await lock(user.id);
    expect(second).toEqual({ locked: false, email: null, userName: null });
  });
});

describe('createWebhookVerifierFromEnv', () => {
  it('binds the fail-closed Helcim verifier from the env secret', () => {
    expectExposes(
      createWebhookVerifierFromEnv({
        NODE_ENV: 'development',
        HELCIM_WEBHOOK_VERIFIER: 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=',
      }),
      'verify'
    );
    // Fail-closed, and read from the env rather than from anywhere else: with
    // the secret absent the bind throws instead of yielding a verifier.
    expect(() => createWebhookVerifierFromEnv({ NODE_ENV: 'development' })).toThrow(
      /verifier is not configured/
    );
  });
});

describe('createSessionRevokeEnqueueRegistration', () => {
  it('fails fast when the Redis binding is missing instead of degrading', () => {
    expect(() => createSessionRevokeEnqueueRegistration({ NODE_ENV: 'development' })).toThrow(
      /UPSTASH_REDIS/
    );
  });

  it('builds the registration when the Redis binding is present (HTTP-lazy, no socket)', () => {
    const registration = createSessionRevokeEnqueueRegistration({
      NODE_ENV: 'development',
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'test-token',
    });
    expect(registration.type).toBeTypeOf('string');
  });
});
