import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { assertNoPendingDeparture } from './pending.js';
import { fakeStores } from '../test-fixtures.js';

describe('assertNoPendingDeparture', () => {
  it('passes a conversation whose current epoch no departed seat holds', async () => {
    const stores = fakeStores({
      epochs: { conversationsWithDepartedHolders: () => okAsync(new Set<string>()) },
    });
    const result = await assertNoPendingDeparture(stores, 'c1');
    expect(result.isOk()).toBe(true);
  });

  it('refuses a pending conversation as a conflict carrying the rotation-pending code', async () => {
    const stores = fakeStores({
      epochs: { conversationsWithDepartedHolders: () => okAsync(new Set(['c1'])) },
    });
    const result = await assertNoPendingDeparture(stores, 'c1');
    const error = result._unsafeUnwrapErr();
    expect({ code: error.code, wireCode: error.wireCode }).toEqual({
      code: 'conflict',
      wireCode: ERROR_CODES.ROTATION_PENDING,
    });
  });

  it('asks about the one conversation it gates', async () => {
    const asked: (readonly string[])[] = [];
    const stores = fakeStores({
      epochs: {
        conversationsWithDepartedHolders: (ids) => {
          asked.push(ids);
          return okAsync(new Set<string>());
        },
      },
    });
    const result = await assertNoPendingDeparture(stores, 'c9');
    expect(result.isOk()).toBe(true);
    expect(asked).toEqual([['c9']]);
  });
});
