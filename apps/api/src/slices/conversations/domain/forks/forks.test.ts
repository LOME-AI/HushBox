import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../../lib/result/index.js';
import { createFork, listForks, nextAutoName, renameFork } from './forks.js';
import { conversationRecord, fakeStores, memberRecord } from '../test-fixtures.js';
import type { ForkListRecord } from '../../ports/index.js';

const writer = memberRecord({ userId: 'writer', privilege: 'write' });

function forkRecord(overrides: Partial<ForkListRecord> = {}): ForkListRecord {
  return {
    id: 'f1',
    name: 'Main',
    tipMessageId: 'msg1',
    tipEpochNumber: 1,
    createdAt: new Date(0),
    ...overrides,
  };
}

function createForkParams(): Parameters<typeof createFork>[1] {
  return {
    conversationId: 'c1',
    callerUserId: 'writer',
    id: 'f-new',
    fromMessageId: 'msg1',
    name: 'Alt',
  };
}

function lockedWriterOverrides(): Parameters<typeof fakeStores>[0] {
  return {
    conversations: { lockForUpdate: () => okAsync(conversationRecord()) },
    members: { activeByUser: () => okAsync(writer) },
    messages: { inConversation: () => okAsync(true), latestId: () => okAsync('msg2') },
  };
}

describe('nextAutoName', () => {
  it('starts at Fork 1 when no auto-names exist', () => {
    expect(nextAutoName(['Main', 'Alt take'])).toBe('Fork 1');
  });

  it('continues one past the highest existing auto-name', () => {
    expect(nextAutoName(['Main', 'Fork 2', 'Fork 9'])).toBe('Fork 10');
  });

  it('ignores names that merely resemble the pattern', () => {
    expect(nextAutoName(['Fork x', 'fork 3', 'Fork 07b'])).toBe('Fork 1');
  });
});

/**
 * The name pre-checks run under the conversation lock, so a unique-violation
 * surfacing from the store afterwards is an invariant break — stageable only
 * with fakes.
 */
describe('createFork collision defects under the lock', () => {
  it('treats a Main-fork collision in an empty fork set as a defect', async () => {
    let inserts = 0;
    const stores = fakeStores({
      ...lockedWriterOverrides(),
      forks: {
        byId: () => okAsync(null),
        list: () => okAsync([]),
        // Main is the SECOND insert of the empty-set path: the requested branch
        // goes in first so its refusals leave nothing behind.
        insert: () => {
          inserts += 1;
          return okAsync(inserts === 1 ? forkRecord() : ('name-taken' as const));
        },
      },
    });
    await expect(createFork(stores, createForkParams())).rejects.toThrow(/Main fork collided/);
  });

  it('treats a Main-fork id collision in an empty fork set as a defect', async () => {
    let inserts = 0;
    const stores = fakeStores({
      ...lockedWriterOverrides(),
      forks: {
        byId: () => okAsync(null),
        list: () => okAsync([]),
        // Main's id is server-minted, so a collision on it is as impossible —
        // and as much a defect — as one on its reserved name.
        insert: () => {
          inserts += 1;
          return okAsync(inserts === 1 ? forkRecord() : ('id-taken' as const));
        },
      },
    });
    await expect(createFork(stores, createForkParams())).rejects.toThrow(/Main fork collided/);
  });

  it('treats a first-branch name collision after the pre-check as a defect', async () => {
    const stores = fakeStores({
      ...lockedWriterOverrides(),
      forks: {
        byId: () => okAsync(null),
        list: () => okAsync([]),
        insert: () => okAsync('name-taken' as const),
      },
    });
    await expect(createFork(stores, createForkParams())).rejects.toThrow(
      /collided under the conversation lock/
    );
  });

  it('treats an additional-fork name collision after the pre-check as a defect', async () => {
    const stores = fakeStores({
      ...lockedWriterOverrides(),
      forks: {
        byId: () => okAsync(null),
        list: () => okAsync([forkRecord()]),
        insert: () => okAsync('name-taken' as const),
      },
    });
    await expect(createFork(stores, createForkParams())).rejects.toThrow(
      /collided under the conversation lock/
    );
  });
});

describe('createFork on an identifier another conversation holds', () => {
  it('writes nothing when the first fork of a conversation reuses a taken id', async () => {
    const attempted: string[] = [];
    const stores = fakeStores({
      ...lockedWriterOverrides(),
      forks: {
        byId: () => okAsync(null),
        list: () => okAsync([]),
        insert: (params) => {
          attempted.push(params.name);
          return okAsync('id-taken' as const);
        },
      },
    });

    const result = await createFork(stores, createForkParams());

    expect(result._unsafeUnwrap()).toEqual({ refusal: 'conflict' });
    // Refusals ride the success channel and COMMIT, so the requested branch is
    // attempted FIRST: a conflict on it must leave the conversation forkless
    // rather than holding a Main row materialized on the way to refusing.
    expect(attempted).toEqual(['Alt']);
  });
});

describe('renameFork collision defect under the lock', () => {
  it('treats a rename collision after the pre-check as a defect', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord()) },
      members: { activeByUser: () => okAsync(writer) },
      forks: {
        list: () => okAsync([forkRecord({ id: 'f1', name: 'Alt' })]),
        rename: () => okAsync('name-taken' as const),
      },
    });
    await expect(
      renameFork(stores, {
        conversationId: 'c1',
        forkId: 'f1',
        callerUserId: 'writer',
        name: 'Renamed',
      })
    ).rejects.toThrow(/rename collided under the conversation lock/);
  });
});

describe('listForks epoch floor', () => {
  const params = { conversationId: 'c1', callerUserId: 'late' };
  const lateJoiner = memberRecord({ userId: 'late', privilege: 'write', visibleFromEpoch: 3 });

  it('omits a fork whose tip message predates the caller epoch floor', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(lateJoiner) },
      forks: {
        list: () =>
          okAsync([
            forkRecord({ id: 'f-old', name: 'Main', tipMessageId: 'pre-join', tipEpochNumber: 1 }),
            forkRecord({ id: 'f-new', name: 'Fork 1', tipMessageId: 'visible', tipEpochNumber: 3 }),
          ]),
      },
    });
    const result = await listForks(stores, params);
    expect(result._unsafeUnwrap()).toEqual({
      forks: [
        {
          id: 'f-new',
          name: 'Fork 1',
          tipMessageId: 'visible',
          createdAt: new Date(0).toISOString(),
        },
      ],
    });
  });

  it('lists a fork with no tip message, which carries no identifier to withhold', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(lateJoiner) },
      forks: {
        list: () =>
          okAsync([
            forkRecord({ id: 'f-empty', name: 'Main', tipMessageId: null, tipEpochNumber: null }),
          ]),
      },
    });
    const result = await listForks(stores, params);
    expect(result._unsafeUnwrap()).toEqual({
      forks: [
        { id: 'f-empty', name: 'Main', tipMessageId: null, createdAt: new Date(0).toISOString() },
      ],
    });
  });

  it('refuses not-found when the caller is not an active member', async () => {
    const stores = fakeStores({ members: { activeByUser: () => okAsync(null) } });
    const result = await listForks(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });
});

describe('createFork under the epoch floor', () => {
  const lateJoiner = memberRecord({ userId: 'late', privilege: 'write', visibleFromEpoch: 3 });
  const preJoinFork = forkRecord({
    id: 'f-new',
    name: 'Alt',
    tipMessageId: 'pre-join',
    tipEpochNumber: 1,
  });

  it('names the created fork even when the floor withholds it from the list', async () => {
    const main = forkRecord({
      id: 'f-main',
      name: 'Main',
      tipMessageId: 'visible',
      tipEpochNumber: 3,
    });
    let inserted = false;
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord()) },
      members: { activeByUser: () => okAsync(lateJoiner) },
      messages: { inConversation: () => okAsync(true) },
      forks: {
        byId: () => okAsync(null),
        list: () => okAsync(inserted ? [main, preJoinFork] : [main]),
        insert: () => {
          inserted = true;
          return okAsync(preJoinFork);
        },
      },
    });
    const result = await createFork(stores, {
      conversationId: 'c1',
      callerUserId: 'late',
      id: 'f-new',
      fromMessageId: 'pre-join',
      name: 'Alt',
    });
    expect(result._unsafeUnwrap()).toEqual({
      forks: [
        {
          id: 'f-main',
          name: 'Main',
          tipMessageId: 'visible',
          createdAt: new Date(0).toISOString(),
        },
      ],
      created: {
        id: 'f-new',
        name: 'Alt',
        tipMessageId: 'pre-join',
        createdAt: new Date(0).toISOString(),
      },
    });
  });

  it('names no created fork when a re-create converges on an existing one', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord()) },
      members: { activeByUser: () => okAsync(lateJoiner) },
      forks: {
        byId: () => okAsync(preJoinFork),
        list: () => okAsync([preJoinFork]),
      },
    });
    const result = await createFork(stores, {
      conversationId: 'c1',
      callerUserId: 'late',
      id: 'f-new',
      fromMessageId: 'pre-join',
      name: 'Alt',
    });
    expect(result._unsafeUnwrap()).toEqual({ forks: [], created: null });
  });
});
