import { describe, expect, it } from 'vitest';
import { createPushMembershipReader } from './push-membership-reader.js';
import type { Database } from '@hushbox/db';

/**
 * A minimal drizzle read chain returning the supplied member rows. It discards
 * the `where` argument, so no test built on it can prove any of the read's three
 * conjuncts. Two are proven against real rows elsewhere: the conversation scope by
 * `apps/api/src/composition/push-notify.integration.test.ts`, whose recipient
 * assertions are exact equalities and go red when that conjunct is dropped, and the
 * left-member exclusion by `realtime-room-bindings.integration.test.ts`. The
 * `isNotNull(userId)` conjunct is not observable through this adapter's result at
 * all: the adapter's own `flatMap` drops a null-userId row regardless, so removing
 * either mechanism alone leaves every value a caller receives identical.
 */
function fakeMemberDb(
  rows: readonly { readonly userId: string | null; readonly muted: boolean }[]
): Database {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  } as unknown as Database;
}

describe('createPushMembershipReader', () => {
  it('maps each returned row to its user id and mute flag', async () => {
    const reader = createPushMembershipReader(
      fakeMemberDb([
        { userId: 'u1', muted: false },
        { userId: 'u2', muted: true },
      ])
    );
    const result = await reader.listActiveUserMembers('c1');
    expect(result._unsafeUnwrap()).toEqual([
      { userId: 'u1', muted: false },
      { userId: 'u2', muted: true },
    ]);
  });

  it('drops a defensive null-userId row', async () => {
    const reader = createPushMembershipReader(
      fakeMemberDb([
        { userId: null, muted: false },
        { userId: 'u2', muted: true },
      ])
    );
    const result = await reader.listActiveUserMembers('c1');
    expect(result._unsafeUnwrap()).toEqual([{ userId: 'u2', muted: true }]);
  });

  it('maps a read failure to an unavailable error', async () => {
    const failing = {
      select: () => ({ from: () => ({ where: () => Promise.reject(new Error('down')) }) }),
    } as unknown as Database;
    const result = await createPushMembershipReader(failing).listActiveUserMembers('c1');
    expect(result.isErr()).toBe(true);
  });
});
