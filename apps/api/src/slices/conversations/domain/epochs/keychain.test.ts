import { describe, expect, it } from 'vitest';
import { toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { getKeyChain, getKeyChainBatch } from './keychain.js';
import { conversationRecord, fakeStores, memberRecord, userRow } from '../test-fixtures.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { EpochChainRecord, EpochChainScope, EpochWrapRecord } from '../../ports/index.js';

const CALLER_KEY = new Uint8Array(32).fill(7);

function wrapRecord(overrides: Partial<EpochWrapRecord> = {}): EpochWrapRecord {
  return {
    conversationId: 'c1',
    epochNumber: 1,
    wrap: new Uint8Array([1]),
    visibleFromEpoch: 1,
    ...overrides,
  };
}

function epochRecord(overrides: Partial<EpochChainRecord> = {}): EpochChainRecord {
  return {
    epochNumber: 1,
    epochPublicKey: new Uint8Array([3]),
    confirmationHash: new Uint8Array([2]),
    previousEpochNumber: null,
    chainLink: null,
    ...overrides,
  };
}

const emptyChains = (): ResultAsync<
  ReadonlyMap<string, readonly EpochChainRecord[]>,
  DomainError
> => okAsync(new Map<string, readonly EpochChainRecord[]>());

const nonePending = (): ResultAsync<ReadonlySet<string>, DomainError> => okAsync(new Set<string>());

describe('getKeyChain', () => {
  it('answers not-found for a missing conversation', async () => {
    const stores = fakeStores({ conversations: { get: () => okAsync(null) } });
    const result = await getKeyChain(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('treats a missing users row for an authenticated member as a defect', async () => {
    const stores = fakeStores({
      conversations: { get: () => okAsync(conversationRecord()) },
      members: { activeByUser: () => okAsync(memberRecord()) },
      users: { byId: () => okAsync(null) },
    });
    await expect(
      getKeyChain(stores, { conversationId: 'c1', caller: { kind: 'user', userId: 'owner' } })
    ).rejects.toThrow(/no users row/);
  });

  it('answers not-found for a member holding no wraps', async () => {
    const stores = fakeStores({
      conversations: { get: () => okAsync(conversationRecord()) },
      members: { activeByUser: () => okAsync(memberRecord()) },
      users: { byId: (id) => userRow(id, CALLER_KEY) },
      epochs: {
        wrapsForKey: () => okAsync([]),
        epochChains: emptyChains,
        conversationsWithDepartedHolders: nonePending,
      },
    });
    const result = await getKeyChain(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });
});

describe('getKeyChainBatch', () => {
  it('treats a missing users row for an authenticated caller as a defect', async () => {
    const stores = fakeStores({ users: { byId: () => okAsync(null) } });
    await expect(
      getKeyChainBatch(stores, { conversationIds: ['c1'], callerUserId: 'owner' })
    ).rejects.toThrow(/no users row/);
  });

  it('splits accessible conversations from missing ones and dedupes ids', async () => {
    const stores = fakeStores({
      users: { byId: (id) => userRow(id, CALLER_KEY) },
      conversations: { byIds: () => okAsync([conversationRecord({ id: 'c1' })]) },
      members: { activeIdsForUser: () => okAsync(['c1']) },
      epochs: {
        wrapsForKey: () => okAsync([wrapRecord()]),
        epochChains: emptyChains,
        conversationsWithDepartedHolders: nonePending,
      },
    });
    const result = await getKeyChainBatch(stores, {
      conversationIds: ['c1', 'c1', 'gone'],
      callerUserId: 'owner',
    });
    const view = result._unsafeUnwrap();
    expect(Object.keys(view.keys)).toEqual(['c1']);
    expect(view.keys['c1']?.currentEpoch).toBe(1);
    expect(view.missing).toEqual(['gone']);
  });

  it('names a conversation the caller left as missing rather than reading its keys', async () => {
    const stores = fakeStores({
      users: { byId: (id) => userRow(id, CALLER_KEY) },
      conversations: { byIds: () => okAsync([conversationRecord({ id: 'c1' })]) },
      members: { activeIdsForUser: () => okAsync([]) },
      epochs: {
        wrapsForKey: () => okAsync([]),
        epochChains: emptyChains,
        conversationsWithDepartedHolders: nonePending,
      },
    });
    const result = await getKeyChainBatch(stores, {
      conversationIds: ['c1'],
      callerUserId: 'stranger',
    });
    expect(result._unsafeUnwrap()).toEqual({ keys: {}, missing: ['c1'] });
  });

  it('asks each store once for the whole id set', async () => {
    const calls: string[] = [];
    const stores = fakeStores({
      users: {
        byId: (id) => {
          calls.push('users.byId');
          return userRow(id, CALLER_KEY);
        },
      },
      conversations: {
        byIds: (ids) => {
          calls.push(`conversations.byIds(${String(ids.length)})`);
          return okAsync(ids.map((id) => conversationRecord({ id })));
        },
      },
      members: {
        activeIdsForUser: (ids) => {
          calls.push(`members.activeIdsForUser(${String(ids.length)})`);
          return okAsync([...ids]);
        },
      },
      epochs: {
        wrapsForKey: (ids) => {
          calls.push(`epochs.wrapsForKey(${String(ids.length)})`);
          return okAsync(ids.map((id) => wrapRecord({ conversationId: id })));
        },
        epochChains: (scopes) => {
          calls.push(`epochs.epochChains(${String(scopes.length)})`);
          return okAsync(new Map<string, readonly EpochChainRecord[]>());
        },
        conversationsWithDepartedHolders: (ids) => {
          calls.push(`epochs.conversationsWithDepartedHolders(${String(ids.length)})`);
          return okAsync(new Set<string>());
        },
      },
    });

    const batched = await getKeyChainBatch(stores, {
      conversationIds: ['c1', 'c2', 'c3'],
      callerUserId: 'owner',
    });
    expect(batched.isOk()).toBe(true);

    expect(calls).toEqual([
      'users.byId',
      'conversations.byIds(3)',
      'members.activeIdsForUser(3)',
      'epochs.wrapsForKey(3)',
      'epochs.epochChains(3)',
      'epochs.conversationsWithDepartedHolders(3)',
    ]);
  });

  it('scopes each conversation chain read to the floor its own wraps set', async () => {
    let scoped: readonly EpochChainScope[] = [];
    const stores = fakeStores({
      users: { byId: (id) => userRow(id, CALLER_KEY) },
      conversations: {
        byIds: (ids) => okAsync(ids.map((id) => conversationRecord({ id, currentEpoch: 9 }))),
      },
      members: { activeIdsForUser: (ids) => okAsync([...ids]) },
      epochs: {
        wrapsForKey: () =>
          okAsync([
            wrapRecord({ conversationId: 'c1', epochNumber: 4, visibleFromEpoch: 4 }),
            wrapRecord({ conversationId: 'c1', epochNumber: 6, visibleFromEpoch: 6 }),
            wrapRecord({ conversationId: 'c2', epochNumber: 2, visibleFromEpoch: 2 }),
          ]),
        epochChains: (scopes) => {
          scoped = scopes;
          return okAsync(new Map<string, readonly EpochChainRecord[]>());
        },
        conversationsWithDepartedHolders: nonePending,
      },
    });

    const batched = await getKeyChainBatch(stores, {
      conversationIds: ['c1', 'c2'],
      callerUserId: 'owner',
    });
    expect(batched.isOk()).toBe(true);

    expect(scoped).toEqual([
      { conversationId: 'c1', fromEpoch: 4 },
      { conversationId: 'c2', fromEpoch: 2 },
    ]);
  });

  it('leaves a conversation the caller holds no wraps in out of the chain read', async () => {
    let scoped: readonly EpochChainScope[] = [];
    const stores = fakeStores({
      users: { byId: (id) => userRow(id, CALLER_KEY) },
      conversations: { byIds: (ids) => okAsync(ids.map((id) => conversationRecord({ id }))) },
      members: { activeIdsForUser: (ids) => okAsync([...ids]) },
      epochs: {
        wrapsForKey: () => okAsync([wrapRecord({ conversationId: 'c2' })]),
        epochChains: (scopes) => {
          scoped = scopes;
          return okAsync(new Map<string, readonly EpochChainRecord[]>());
        },
        conversationsWithDepartedHolders: nonePending,
      },
    });

    const result = await getKeyChainBatch(stores, {
      conversationIds: ['c1', 'c2'],
      callerUserId: 'owner',
    });

    expect(scoped).toEqual([{ conversationId: 'c2', fromEpoch: 1 }]);
    expect(result._unsafeUnwrap().missing).toEqual(['c1']);
  });
});

describe('key-chain response shape', () => {
  const B = (bytes: number[]): Uint8Array => new Uint8Array(bytes);

  function singleConversationStores(pending: ReadonlySet<string>): ReturnType<typeof fakeStores> {
    return fakeStores({
      conversations: { get: () => okAsync(conversationRecord({ currentEpoch: 2 })) },
      members: { activeByUser: () => okAsync(memberRecord()) },
      users: { byId: (id) => userRow(id, CALLER_KEY) },
      epochs: {
        wrapsForKey: () =>
          okAsync([
            wrapRecord({ epochNumber: 1, wrap: B([11]) }),
            wrapRecord({ epochNumber: 2, wrap: B([12]) }),
          ]),
        epochChains: () =>
          okAsync(
            new Map([
              [
                'c1',
                [
                  epochRecord({
                    epochNumber: 1,
                    epochPublicKey: B([21]),
                    confirmationHash: B([31]),
                  }),
                  epochRecord({
                    epochNumber: 2,
                    epochPublicKey: B([22]),
                    confirmationHash: B([32]),
                    previousEpochNumber: 1,
                    chainLink: B([41]),
                  }),
                ],
              ],
            ])
          ),
        conversationsWithDepartedHolders: () => okAsync(pending),
      },
    });
  }

  it('serializes one record per epoch, the wraps and the current epoch', async () => {
    const result = await getKeyChain(singleConversationStores(new Set()), {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    expect(result._unsafeUnwrap()).toEqual({
      epochs: [
        {
          epochNumber: 1,
          epochPublicKey: toBase64(B([21])),
          confirmationHash: toBase64(B([31])),
          previousEpochNumber: null,
          chainLink: null,
        },
        {
          epochNumber: 2,
          epochPublicKey: toBase64(B([22])),
          confirmationHash: toBase64(B([32])),
          previousEpochNumber: 1,
          chainLink: toBase64(B([41])),
        },
      ],
      wraps: [
        { epochNumber: 1, wrap: toBase64(B([11])) },
        { epochNumber: 2, wrap: toBase64(B([12])) },
      ],
      currentEpoch: 2,
      rotationPending: false,
    });
  });

  it('reports rotation pending when a departed seat still holds the current epoch', async () => {
    const result = await getKeyChain(singleConversationStores(new Set(['c1'])), {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    expect(result._unsafeUnwrap()).toMatchObject({ rotationPending: true });
  });
});
