import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { DB_CONNECT_TIMEOUT_MS, LOCAL_NEON_DEV_CONFIG, createDb, users } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { resolveAuthResetIdentities } from './route-work.js';
import { holdTableLock } from '../test-support/hold-table-lock.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for dev route-work integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const createdUserIds: string[] = [];

async function seedUser(): Promise<{ id: string; email: string }> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const email = `rw-${suffix}@route-work.test`;
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email,
        username: `rw${suffix}`,
        opaqueRegistration: new Uint8Array([1]),
        publicKey: new Uint8Array([1]),
        passwordWrappedPrivateKey: new Uint8Array([1]),
        recoveryWrappedPrivateKey: new Uint8Array([1]),
        recoveryPublicKey: new Uint8Array([1]),
      })
    )
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  return { id, email };
}

/** Past the pool's acquisition deadline, so a read queued behind the held one would expire. */
const HOLD_MS = DB_CONNECT_TIMEOUT_MS + 1500;

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('resolveAuthResetIdentities', () => {
  it(
    'resolves every identifier when the first lookup is held past the acquisition deadline',
    async () => {
      const user = await seedUser();
      const unregistered = `rw-${crypto.randomUUID().slice(0, 8)}@unregistered.test`;
      const requestDb = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
      try {
        const { released } = await holdTableLock(users, HOLD_MS);

        const identities = await resolveAuthResetIdentities(requestDb, [user.email, unregistered]);
        await released;

        expect(identities).toEqual([
          { canonical: user.email, userId: user.id },
          { canonical: unregistered, userId: null },
        ]);
      } finally {
        await requestDb.$client.end();
      }
    },
    HOLD_MS * 3
  );
});
