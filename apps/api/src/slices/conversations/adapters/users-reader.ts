import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import { fromPromise } from '../../../lib/result/index.js';
import { storeFailure } from './store-failure.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { UsersReader } from '../ports/stores.js';

export function createUsersReader(db: DbWriter): UsersReader {
  return {
    byId: (userId) =>
      fromPromise(
        db
          .select({ id: users.id, username: users.username, publicKey: users.publicKey })
          .from(users)
          .where(eq(users.id, userId)),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    lockForKeyShare: (userId) =>
      fromPromise(
        db.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('key share'),
        storeFailure
      ).map((rows) => rows[0] ?? null),
  };
}
