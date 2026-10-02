import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { okAsync } from '../../../../lib/result/index.js';
import { getConversationBudgets, setConversationBudget } from './budgets.js';
import { conversationRecord, fakeStores, memberRecord } from '../test-fixtures.js';
import type { MemberPrivilege } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { RedisClient } from '../../../billing/index.js';
import type { BudgetBilling } from './budgets.js';
import type { ConversationRecord } from '../../ports/index.js';

/**
 * The conversation-cap write's 0-row disambiguation tail is reachable only via
 * a mid-transaction race (the authz pre-check already saw the owner's row, so
 * the conditional UPDATE can miss only if the row was deleted or re-owned in
 * between). Real infra cannot produce that state deterministically, so these
 * cases stub the store: the first `get` answers the pre-check, `updateBudget`
 * reports 0 rows, and the second `get` discriminates the two refusals.
 */
describe('setConversationBudget zero-row disambiguation', () => {
  function racingStores(rowAfterMiss: ConversationRecord | null): ReturnType<typeof fakeStores> {
    let reads = 0;
    return fakeStores({
      conversations: {
        get: () => {
          reads += 1;
          return okAsync(reads === 1 ? conversationRecord() : rowAfterMiss);
        },
        updateBudget: () => okAsync(null),
      },
    });
  }

  const params = { conversationId: 'c1', callerUserId: 'owner', capNanoUsd: 10n };

  it('answers forbidden when the update misses but the row still exists (re-owned mid-transaction)', async () => {
    const stores = racingStores(conversationRecord({ ownerUserId: 'other' }));
    const result = await setConversationBudget(stores, () => okAsync(0n), params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
  });

  it('answers not-found when the update misses and the row is gone (deleted mid-transaction)', async () => {
    const stores = racingStores(null);
    const result = await setConversationBudget(stores, () => okAsync(0n), params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });
});

/**
 * The display view's shape guard. Every peer read is stubbed because the guard
 * under test is the projection itself, not the composition: a privilege outside
 * the declared enum can only arrive from a store row, so the fake supplies one.
 */
describe('getConversationBudgets view validation', () => {
  const holdsRedis = {
    createScript: () => ({ exec: (keys: string[]) => Promise.resolve(keys.map(() => '0')) }),
  } as unknown as RedisClient;

  const billing = {
    readConversationSpent: () => okAsync(0n),
    readWallets: () => okAsync([]),
    readMemberBudget: () => okAsync(null),
  } as unknown as BudgetBilling;

  it('rejects a privilege the view schema does not declare (a defect, not a refusal)', async () => {
    const stores = fakeStores({
      conversations: { get: () => okAsync(conversationRecord()) },
      members: {
        activeByUser: () => okAsync(memberRecord()),
        listActive: () =>
          okAsync([
            {
              id: 'm2',
              userId: 'u2',
              linkId: null,
              username: 'peer',
              privilege: 'superuser' as unknown as MemberPrivilege,
              visibleFromEpoch: 1,
              joinedAt: new Date(0),
              acceptedAt: null,
            },
          ]),
      },
    });
    await expect(
      getConversationBudgets(
        { stores, billing, db: {} as unknown as Database, redis: holdsRedis },
        { conversationId: 'c1', callerUserId: 'owner', now: new Date(0) }
      )
    ).rejects.toThrow(ZodError);
  });
});
