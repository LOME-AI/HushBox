import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { fromBase64, toBase64 } from '@hushbox/shared';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { okAsync } from '../../../../lib/result/index.js';
import {
  adminRevokeSharedLink,
  adminUnrevokeSharedLink,
  changeLinkName,
  changeLinkPrivilege,
  createSharedLink,
  createSharedMessage,
  listSharedLinks,
  readSharedMessage,
  revokeSharedLink,
} from './shares.js';
import { conversationRecord, fakeStores, memberRecord } from '../test-fixtures.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { MemberPrivilege } from '@hushbox/shared';
import type { RotationBody } from '../schemas.js';
import type {
  ActiveLinkGuest,
  ContentItemRow,
  MemberKeyRecord,
  MessageHeader,
  SharedLinkMintRecord,
  SharedLinkRecord,
  SharedMessageRecord,
} from '../../ports/index.js';

const KEY = toBase64(new Uint8Array([7, 7, 7]));
const OWNER_KEY = new Uint8Array([1, 1, 1]);
const LINK_KEY = new Uint8Array([7, 7, 7]);
const LINK_AUTH_HASH = new Uint8Array([5, 5, 5]);
const B64 = toBase64(new Uint8Array([2, 2, 2]));
const CONV = 'conv-1';
const LINK = 'link-1';
const MESSAGE_CREATED_AT = new Date(TEST_DAY_START - DAY_MS);

function linkRecord(overrides: Partial<SharedLinkRecord> = {}): SharedLinkRecord {
  return {
    id: LINK,
    conversationId: CONV,
    displayName: 'a link',
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date(0),
    ...overrides,
  };
}

/** A link as the mint's natural-key read returns it, carrying the hash it was minted under. */
function mintRecord(
  overrides: Partial<SharedLinkRecord> = {},
  linkAuthHash: Uint8Array = LINK_AUTH_HASH
): SharedLinkMintRecord {
  return { ...linkRecord(overrides), linkAuthHash };
}

function sharedMessage(overrides: Partial<SharedMessageRecord> = {}): SharedMessageRecord {
  return {
    id: 'shared-msg-1',
    messageId: 'msg-1',
    wrappedContentKey: new Uint8Array([1, 2]),
    createdAt: new Date(0),
    messageCreatedAt: MESSAGE_CREATED_AT,
    conversationId: CONV,
    epochNumber: 1,
    senderId: 'sender-1',
    epochWrappedContentKey: new Uint8Array([3, 4]),
    deletedAt: null,
    contentItems: [],
    ...overrides,
  };
}

function contentItemRow(overrides: Partial<ContentItemRow> = {}): ContentItemRow {
  return {
    id: 'ci-1',
    messageId: 'msg-1',
    position: 0,
    contentType: 'text',
    mimeType: null,
    sizeBytes: null,
    width: null,
    height: null,
    durationMs: null,
    encryptedBlob: new Uint8Array([1, 2, 3]),
    costNanoUsd: null,
    modelId: null,
    isSmartModel: false,
    reasoningTokens: null,
    reasoningEffort: null,
    reasoningDurationMs: null,
    inputTokens: null,
    outputTokens: null,
    ...overrides,
  };
}

function memberKey(overrides: Partial<MemberKeyRecord>): MemberKeyRecord {
  return {
    memberId: 'm-owner',
    userId: 'owner',
    linkId: null,
    publicKey: OWNER_KEY,
    privilege: 'owner',
    visibleFromEpoch: 1,
    ...overrides,
  };
}

/** A rotation body whose wrap set covers exactly `memberKeys`. */
function rotationBody(expectedEpoch: number, memberKeys: Uint8Array[]): RotationBody {
  return {
    expectedEpoch,
    epochPublicKey: B64,
    confirmationHash: B64,
    chainLink: B64,
    memberWraps: memberKeys.map((key) => ({ memberPublicKey: toBase64(key), wrap: B64 })),
    encryptedTitle: B64,
  };
}

/** The live guest seat behind a link, carrying the privilege it was seated at. */
function activeGuest(privilege: MemberPrivilege): ActiveLinkGuest {
  return {
    member: memberRecord({ id: 'm-guest', userId: null, privilege }),
    publicKey: LINK_KEY,
    displayName: 'a link',
  };
}

/** The epoch/conversation store fragment that lets `applyRotation` run to completion. */
const rotationStores = {
  conversations: {
    lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
    claimRotation: () => okAsync(true),
  },
  epochs: {
    byNumber: () => okAsync({ id: 'epoch-1' }),
    insert: () => okAsync({ id: 'epoch-2' }),
    insertWraps: () => okAsync(),
    deleteWrapsExceptKeys: () => okAsync(),
    deleteWrapsForKeys: () => okAsync(),
  },
};

describe('createSharedLink', () => {
  const fullHistory = {
    conversationId: CONV,
    callerUserId: 'u1',
    linkPublicKey: KEY,
    linkAuthHash: toBase64(LINK_AUTH_HASH),
    displayName: 'a link' as string | null,
    expiresAt: null as string | null,
    privilege: 'read' as const,
    giveFullHistory: true,
    memberWrap: B64 as string | undefined,
    expectedEpoch: 1 as number | undefined,
    rotation: undefined,
  };

  const rotationParams = {
    conversationId: CONV,
    callerUserId: 'u1',
    linkPublicKey: KEY,
    linkAuthHash: toBase64(LINK_AUTH_HASH),
    displayName: 'a link' as string | null,
    expiresAt: null as string | null,
    privilege: 'write' as const,
    giveFullHistory: false,
    memberWrap: undefined,
    expectedEpoch: undefined,
    rotation: rotationBody(1, [OWNER_KEY, LINK_KEY]),
  };

  it('refuses not-found when the conversation does not exist', async () => {
    const stores = fakeStores({ conversations: { lockForUpdate: () => okAsync(null) } });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the caller is not an active member', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { lockActiveByUser: () => okAsync(null) },
    });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses forbidden when the caller lacks link-management privilege', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'write' })) },
    });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
  });

  it('converges on the existing link when its key already exists for this conversation', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        activeLinkGuest: () => okAsync(activeGuest('read')),
      },
      sharedLinks: { byPublicKey: () => okAsync(mintRecord()) },
    });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({
      link: expect.objectContaining({ id: LINK }),
      created: false,
    });
  });

  it('converges reporting the privilege the guest seat holds, not the one asked for', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        activeLinkGuest: () => okAsync(activeGuest('write')),
      },
      sharedLinks: { byPublicKey: () => okAsync(mintRecord()) },
    });
    // `fullHistory` asks for `read`; the seat carries `write`.
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({
      link: expect.objectContaining({ privilege: 'write' }),
      created: false,
    });
  });

  it('refuses to converge on a revoked link, taking the fresh-mint path instead', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        activeLinkGuest: () => okAsync(null),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
      },
      epochs: { byNumber: () => okAsync({ id: 'epoch-1' }) },
      sharedLinks: {
        byPublicKey: () => okAsync(mintRecord({ revokedAt: new Date(0) })),
        insert: () => okAsync(null),
      },
    });
    const result = await createSharedLink(stores, fullHistory);
    // The link public key is the natural key: a fresh mint of a key a dead link
    // still holds is refused rather than reviving that link.
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'conflict' });
  });

  it('refuses conflict when the key already exists here under another auth hash', async () => {
    let seatRead = false;
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        activeLinkGuest: () => {
          seatRead = true;
          return okAsync(activeGuest('read'));
        },
      },
      sharedLinks: {
        byPublicKey: () => okAsync(mintRecord({}, new Uint8Array([6, 6, 6]))),
      },
    });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'conflict' });
    expect(seatRead).toBe(false);
  });

  it('refuses conflict when the key already exists for another conversation', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'owner' })) },
      sharedLinks: { byPublicKey: () => okAsync(mintRecord({ conversationId: 'other' })) },
    });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'conflict' });
  });

  it('refuses member-limit when the conversation is at capacity', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(100),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
      },
      sharedLinks: { byPublicKey: () => okAsync(null) },
    });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'member-limit', limit: 100 });
  });

  it('seats a full-history guest and wraps the current epoch key, without rotating', async () => {
    let wraps: unknown = null;
    let cleared: unknown = null;
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
        insertLinkMember: () => okAsync({ id: 'member-9' }),
      },
      sharedLinks: { byPublicKey: () => okAsync(null), insert: () => okAsync(linkRecord()) },
      epochs: {
        byNumber: () => okAsync({ id: 'epoch-1' }),
        deleteWrapsForKeys: (conversationId, keys) => {
          cleared = { conversationId, keys };
          return okAsync();
        },
        insertWraps: (rows) => {
          wraps = rows;
          return okAsync();
        },
      },
    });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({
      link: expect.objectContaining({ id: LINK }),
      created: true,
      memberId: 'member-9',
      newEpochNumber: null,
    });
    expect(cleared).toEqual({ conversationId: CONV, keys: [LINK_KEY] });
    expect(wraps).toEqual([
      {
        epochId: 'epoch-1',
        memberPublicKey: LINK_KEY,
        wrap: expect.any(Uint8Array),
        visibleFromEpoch: 1,
      },
    ]);
  });

  it('stamps the minting member as the link creator', async () => {
    let inserted: unknown = null;
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
        insertLinkMember: () => okAsync({ id: 'member-9' }),
      },
      sharedLinks: {
        byPublicKey: () => okAsync(null),
        insert: (params) => {
          inserted = params;
          return okAsync(linkRecord());
        },
      },
      epochs: {
        byNumber: () => okAsync({ id: 'epoch-1' }),
        deleteWrapsForKeys: () => okAsync(),
        insertWraps: () => okAsync(),
      },
    });

    const result = await createSharedLink(stores, fullHistory);

    expect(result.isOk()).toBe(true);
    expect(inserted).toEqual(expect.objectContaining({ createdBy: 'u1' }));
  });

  it('stores the auth hash the minting client submitted', async () => {
    let inserted: unknown = null;
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
        insertLinkMember: () => okAsync({ id: 'member-9' }),
      },
      sharedLinks: {
        byPublicKey: () => okAsync(null),
        insert: (params) => {
          inserted = params;
          return okAsync(linkRecord());
        },
      },
      epochs: {
        byNumber: () => okAsync({ id: 'epoch-1' }),
        deleteWrapsForKeys: () => okAsync(),
        insertWraps: () => okAsync(),
      },
    });

    const result = await createSharedLink(stores, fullHistory);

    expect(result.isOk()).toBe(true);
    expect(inserted).toEqual(expect.objectContaining({ linkAuthHash: LINK_AUTH_HASH }));
  });

  it('refuses stale-epoch when a full-history wrap was built for another epoch', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 3 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
      },
      sharedLinks: { byPublicKey: () => okAsync(null) },
    });
    const result = await createSharedLink(stores, { ...fullHistory, expectedEpoch: 1 });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'stale-epoch', currentEpoch: 3 });
  });

  it('refuses validation when a full-history mint is missing its wrap material', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
      },
      sharedLinks: { byPublicKey: () => okAsync(null) },
    });
    const result = await createSharedLink(stores, {
      ...fullHistory,
      memberWrap: undefined,
      expectedEpoch: undefined,
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'validation' });
  });

  it('treats a missing current epoch row as a defect on the full-history path', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
      },
      sharedLinks: { byPublicKey: () => okAsync(null) },
      epochs: { byNumber: () => okAsync(null) },
    });
    await expect(createSharedLink(stores, fullHistory)).rejects.toThrow(
      /current epoch row missing/
    );
  });

  it('answers conflict when the link insert loses a concurrent cross-conversation race', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
      },
      sharedLinks: { byPublicKey: () => okAsync(null), insert: () => okAsync(null) },
      epochs: { byNumber: () => okAsync({ id: 'epoch-1' }) },
    });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'conflict' });
  });

  it('treats a lost link-member insert as a defect under the conversation lock', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
        insertLinkMember: () => okAsync(null),
      },
      sharedLinks: { byPublicKey: () => okAsync(null), insert: () => okAsync(linkRecord()) },
      epochs: { byNumber: () => okAsync({ id: 'epoch-1' }) },
    });
    await expect(createSharedLink(stores, fullHistory)).rejects.toThrow(/link member insert lost/);
  });

  it('seats a rotation guest and rotates the epoch, seating the link key', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
        claimRotation: rotationStores.conversations.claimRotation,
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
        insertLinkMember: () => okAsync({ id: 'member-r' }),
      },
      sharedLinks: { byPublicKey: () => okAsync(null), insert: () => okAsync(linkRecord()) },
      epochs: rotationStores.epochs,
    });
    const result = await createSharedLink(stores, rotationParams);
    expect(result._unsafeUnwrap()).toEqual({
      link: expect.objectContaining({ id: LINK }),
      created: true,
      memberId: 'member-r',
      newEpochNumber: 2,
    });
  });

  it('writes the title on a rotation mint run by a non-owner admin', async () => {
    const claims: (Uint8Array | null)[] = [];
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
        claimRotation: ({ encryptedTitle }) => {
          claims.push(encryptedTitle);
          return okAsync(true);
        },
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ userId: 'u1', privilege: 'admin' })),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
        insertLinkMember: () => okAsync({ id: 'member-r' }),
      },
      sharedLinks: { byPublicKey: () => okAsync(null), insert: () => okAsync(linkRecord()) },
      epochs: rotationStores.epochs,
    });
    const result = await createSharedLink(stores, rotationParams);
    expect(result._unsafeUnwrap()).toMatchObject({ newEpochNumber: 2 });
    // The guest's floor is the new epoch, so a title left below it would be
    // unopenable for them — the seat, not the caller's ownership, decides.
    expect(claims).toEqual([fromBase64(B64)]);
  });

  it('answers conflict when a rotation-path link insert loses a cross-conversation race', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
      },
      sharedLinks: { byPublicKey: () => okAsync(null), insert: () => okAsync(null) },
    });
    const result = await createSharedLink(stores, rotationParams);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'conflict' });
  });

  it('refuses validation when a rotation mint is missing its rotation payload', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
      },
      sharedLinks: { byPublicKey: () => okAsync(null) },
    });
    const result = await createSharedLink(stores, { ...rotationParams, rotation: undefined });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'validation' });
  });

  it('refuses stale-epoch when the rotation was built for another epoch', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 5 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
      },
      sharedLinks: { byPublicKey: () => okAsync(null) },
    });
    const result = await createSharedLink(stores, rotationParams);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'stale-epoch', currentEpoch: 5 });
  });

  it('refuses wrap-set-mismatch when the rotation wrap set does not cover the members plus link', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        // Two existing members but the rotation only carries owner + link.
        activeVisibilityByKey: () =>
          okAsync(
            new Map([
              [toBase64(OWNER_KEY), 1],
              [toBase64(new Uint8Array([9, 9, 9])), 1],
            ])
          ),
      },
      sharedLinks: { byPublicKey: () => okAsync(null) },
    });
    const result = await createSharedLink(stores, rotationParams);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'wrap-set-mismatch' });
  });

  it('parses an expiry instant and serializes the stored timestamps', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
        insertLinkMember: () => okAsync({ id: 'member-9' }),
      },
      sharedLinks: {
        byPublicKey: () => okAsync(null),
        insert: () => okAsync(linkRecord({ revokedAt: new Date(5), expiresAt: new Date(10) })),
      },
      epochs: {
        byNumber: () => okAsync({ id: 'epoch-1' }),
        deleteWrapsForKeys: () => okAsync(),
        insertWraps: () => okAsync(),
      },
    });
    const result = await createSharedLink(stores, {
      ...fullHistory,
      expiresAt: isoAt(TEST_DAY_START),
    });
    expect(result._unsafeUnwrap()).toEqual({
      link: {
        id: LINK,
        displayName: 'a link',
        privilege: 'read',
        revokedAt: new Date(5).toISOString(),
        expiresAt: new Date(10).toISOString(),
        createdAt: new Date(0).toISOString(),
      },
      created: true,
      memberId: 'member-9',
      newEpochNumber: null,
    });
  });
});

describe('listSharedLinks', () => {
  it('refuses not-found when the caller is not an active member', async () => {
    const stores = fakeStores({ members: { activeByUser: () => okAsync(null) } });
    const result = await listSharedLinks(stores, {
      conversationId: CONV,
      caller: { kind: 'user', userId: 'u1' },
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('lists the conversation links for an active member', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'read' })) },
      sharedLinks: {
        listForConversation: () =>
          okAsync([
            { ...linkRecord(), privilege: 'write' as const },
            { ...linkRecord({ id: 'link-2' }), privilege: 'read' as const },
          ]),
      },
    });
    const result = await listSharedLinks(stores, {
      conversationId: CONV,
      caller: { kind: 'user', userId: 'u1' },
    });
    expect(result._unsafeUnwrap()).toMatchObject({ links: [{ id: LINK }, { id: 'link-2' }] });
  });

  it("carries each link's seated privilege into the view", async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: {
        listForConversation: () =>
          okAsync([
            { ...linkRecord(), privilege: 'write' as const },
            { ...linkRecord({ id: 'link-2' }), privilege: 'read' as const },
          ]),
      },
    });
    const result = await listSharedLinks(stores, {
      conversationId: CONV,
      caller: { kind: 'user', userId: 'u1' },
    });
    expect(result._unsafeUnwrap()).toEqual({
      links: [
        expect.objectContaining({ id: LINK, privilege: 'write' }),
        expect.objectContaining({ id: 'link-2', privilege: 'read' }),
      ],
    });
  });
});

describe('revokeSharedLink', () => {
  const params = {
    conversationId: CONV,
    linkId: LINK,
    callerUserId: 'u1',
    rotation: rotationBody(1, [OWNER_KEY]),
  };

  /** Active keys where the owner remains and the revoked link is still present. */
  const keysWithLink = (): ResultAsync<MemberKeyRecord[], never> =>
    okAsync([
      memberKey({}),
      memberKey({
        memberId: 'm-link',
        userId: null,
        linkId: LINK,
        publicKey: LINK_KEY,
        privilege: 'read',
      }),
    ]);

  function revokeStores(
    overrides: Parameters<typeof fakeStores>[0]
  ): ReturnType<typeof fakeStores> {
    return fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
        claimRotation: rotationStores.conversations.claimRotation,
      },
      members: {
        activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        activeKeysOrdered: keysWithLink,
        markLeftByLink: () => okAsync({ id: 'm-link' }),
        ...overrides.members,
      },
      sharedLinks: {
        byId: () => okAsync(linkRecord()),
        revoke: () => okAsync(linkRecord({ revokedAt: new Date(1) })),
        ...overrides.sharedLinks,
      },
      epochs: rotationStores.epochs,
      ...Object.fromEntries(
        Object.entries(overrides).filter(([key]) => key !== 'members' && key !== 'sharedLinks')
      ),
    });
  }

  it('refuses not-found when the conversation does not exist', async () => {
    const stores = fakeStores({ conversations: { lockForUpdate: () => okAsync(null) } });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the caller is not an active member', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { activeByUser: () => okAsync(null) },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses forbidden when the caller lacks link-management privilege', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'write' })) },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
  });

  it('refuses not-found when the link does not exist', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { byId: () => okAsync(null) },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the link belongs to another conversation', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { byId: () => okAsync(linkRecord({ conversationId: 'other' })) },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('is an idempotent no-op when the link is already revoked', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { byId: () => okAsync(linkRecord({ revokedAt: new Date(1) })) },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ revoked: true, alreadyRevoked: true });
  });

  it('refuses stale-epoch when the departure rotation targets another epoch', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 4 })),
      },
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { byId: () => okAsync(linkRecord()) },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'stale-epoch', currentEpoch: 4 });
  });

  it('refuses wrap-set-mismatch when the departure set does not cover the remaining members', async () => {
    const stores = revokeStores({
      members: {
        activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        // Two remaining members but the rotation only carries the owner.
        activeKeysOrdered: () =>
          okAsync([
            memberKey({}),
            memberKey({ memberId: 'm2', userId: 'u2', publicKey: new Uint8Array([3, 3, 3]) }),
            memberKey({ memberId: 'm-link', userId: null, linkId: LINK, publicKey: LINK_KEY }),
          ]),
      },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'wrap-set-mismatch' });
  });

  it('revokes a live link: marks the guest left, rotates the epoch out, and evicts the link', async () => {
    const stores = revokeStores({});
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({
      revoked: true,
      memberId: 'm-link',
      newEpochNumber: 2,
      evicteePrincipalIds: [LINK],
    });
  });

  it('claims the revoke rotation with no title when a non-owner admin runs it', async () => {
    const claims: (Uint8Array | null)[] = [];
    const stores = revokeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
        claimRotation: ({ encryptedTitle }) => {
          claims.push(encryptedTitle);
          return okAsync(true);
        },
      },
    });
    // `conversationRecord` is owned by `owner`; this caller is the admin `u1`,
    // so its rotation carries a title the conversation never authorized.
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toMatchObject({ revoked: true });
    expect(claims).toEqual([null]);
  });

  it('revokes a member-less link (no active guest) with a null member id', async () => {
    const stores = revokeStores({
      members: {
        activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        activeKeysOrdered: () => okAsync([memberKey({})]),
        markLeftByLink: () => okAsync(null),
      },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({
      revoked: true,
      memberId: null,
      newEpochNumber: 2,
      evicteePrincipalIds: [LINK],
    });
  });

  it('treats a missed revoke under the conversation lock as a defect', async () => {
    const stores = revokeStores({
      sharedLinks: { byId: () => okAsync(linkRecord()), revoke: () => okAsync(null) },
    });
    await expect(revokeSharedLink(stores, params)).rejects.toThrow(/revoke matched no row/);
  });
});

describe('adminRevokeSharedLink', () => {
  const params = { conversationId: CONV, linkId: LINK };

  it('refuses not-found when the conversation does not exist', async () => {
    const stores = fakeStores({ conversations: { lockForUpdate: () => okAsync(null) } });
    const result = await adminRevokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the link does not exist', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      sharedLinks: { byId: () => okAsync(null) },
    });
    const result = await adminRevokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the link belongs to another conversation', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      sharedLinks: { byId: () => okAsync(linkRecord({ conversationId: 'other' })) },
    });
    const result = await adminRevokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('is an idempotent no-op when the link is already revoked', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      sharedLinks: { byId: () => okAsync(linkRecord({ revokedAt: new Date(1) })) },
    });
    const result = await adminRevokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ revoked: true, alreadyRevoked: true });
  });

  // The fake stores throw on any un-overridden call, so this test also proves
  // the admin path performs NO member-privilege read and NO epoch rotation —
  // the founder-settled deviation from the member revoke path.
  it('revokes a live link without any privilege gate or rotation, marking the guest left', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { markLeftByLink: () => okAsync({ id: 'm-link' }) },
      sharedLinks: {
        byId: () => okAsync(linkRecord()),
        revoke: () => okAsync(linkRecord({ revokedAt: new Date(1) })),
      },
    });
    const result = await adminRevokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({
      revoked: true,
      memberId: 'm-link',
      evicteePrincipalIds: [LINK],
    });
  });

  it('revokes a member-less link (no active guest) with a null member id', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { markLeftByLink: () => okAsync(null) },
      sharedLinks: {
        byId: () => okAsync(linkRecord()),
        revoke: () => okAsync(linkRecord({ revokedAt: new Date(1) })),
      },
    });
    const result = await adminRevokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({
      revoked: true,
      memberId: null,
      evicteePrincipalIds: [LINK],
    });
  });

  it('treats a missed revoke under the conversation lock as a defect', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      sharedLinks: { byId: () => okAsync(linkRecord()), revoke: () => okAsync(null) },
    });
    await expect(adminRevokeSharedLink(stores, params)).rejects.toThrow(
      /admin revoke matched no row/
    );
  });

  it('rejects a member id the outcome schema does not declare (a defect, not a refusal)', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { markLeftByLink: () => okAsync({ id: 7 as unknown as string }) },
      sharedLinks: {
        byId: () => okAsync(linkRecord()),
        revoke: () => okAsync(linkRecord({ revokedAt: new Date(1) })),
      },
    });
    await expect(adminRevokeSharedLink(stores, params)).rejects.toThrow(ZodError);
  });
});

describe('adminUnrevokeSharedLink', () => {
  const params = { conversationId: CONV, linkId: LINK };

  it('refuses not-found when the conversation does not exist', async () => {
    const stores = fakeStores({ conversations: { lockForUpdate: () => okAsync(null) } });
    const result = await adminUnrevokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the link does not exist', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      sharedLinks: { byId: () => okAsync(null) },
    });
    const result = await adminUnrevokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the link belongs to another conversation', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      sharedLinks: { byId: () => okAsync(linkRecord({ conversationId: 'other' })) },
    });
    const result = await adminUnrevokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('is an idempotent no-op when the link is already live', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      sharedLinks: { byId: () => okAsync(linkRecord()) },
    });
    const result = await adminUnrevokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ unrevoked: true, alreadyLive: true });
  });

  // The fake stores throw on any un-overridden call, so this test also proves
  // unrevoke clears `revokedAt` and touches NOTHING else — no member write,
  // no rotation; the departed guest re-enters via the normal link flow.
  it('clears revokedAt on a revoked link and nothing else', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      sharedLinks: {
        byId: () => okAsync(linkRecord({ revokedAt: new Date(1) })),
        unrevoke: () => okAsync(linkRecord()),
      },
    });
    const result = await adminUnrevokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ unrevoked: true });
  });

  it('treats a missed unrevoke under the conversation lock as a defect', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      sharedLinks: {
        byId: () => okAsync(linkRecord({ revokedAt: new Date(1) })),
        unrevoke: () => okAsync(null),
      },
    });
    await expect(adminUnrevokeSharedLink(stores, params)).rejects.toThrow(
      /admin unrevoke matched no row/
    );
  });
});

describe('createSharedMessage', () => {
  function header(overrides: Partial<MessageHeader> = {}): MessageHeader {
    return { epochNumber: 1, senderType: 'assistant', senderId: null, ...overrides };
  }

  const params = {
    conversationId: CONV,
    callerUserId: 'u1',
    messageId: 'msg-1',
    wrappedContentKey: toBase64(new Uint8Array([9])),
  };

  it('refuses not-found when the caller is not an active member', async () => {
    const stores = fakeStores({ members: { lockActiveByUser: () => okAsync(null) } });
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the message is not in the conversation', async () => {
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'write' })) },
      messages: { inConversation: () => okAsync(false), headerInConversation: () => okAsync(null) },
    });
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses forbidden when the caller cannot send messages', async () => {
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'read' })) },
    });
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
  });

  it('refuses not-found when the message predates the caller epoch floor', async () => {
    let inserted = false;
    const stores = fakeStores({
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'write', visibleFromEpoch: 3 })),
      },
      messages: {
        inConversation: () => okAsync(true),
        headerInConversation: () => okAsync(header({ epochNumber: 2 })),
      },
      sharedMessages: {
        insert: () => {
          inserted = true;
          return okAsync({ id: 'share-1', createdAt: new Date(0) });
        },
      },
    });
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
    expect(inserted).toBe(false);
  });

  it('creates a standalone shared message stamped with the creating user', async () => {
    let captured: { messageId: string; createdBy: string } | null = null;
    const stores = fakeStores({
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'write', visibleFromEpoch: 3 })),
      },
      messages: {
        inConversation: () => okAsync(true),
        headerInConversation: () => okAsync(header({ epochNumber: 3 })),
      },
      sharedMessages: {
        insert: (p) => {
          captured = { messageId: p.messageId, createdBy: p.createdBy };
          return okAsync({ id: 'share-1', createdAt: new Date(0) });
        },
      },
    });
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ shareId: 'share-1' });
    expect(captured).toEqual({ messageId: 'msg-1', createdBy: 'u1' });
  });

  /** Stores for a write member, visible at floor, whose insert records whether it ran. */
  function gateStores(messageHeader: MessageHeader): {
    stores: ReturnType<typeof fakeStores>;
    wasInserted: () => boolean;
  } {
    let inserted = false;
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'write' })) },
      messages: { headerInConversation: () => okAsync(messageHeader) },
      sharedMessages: {
        insert: () => {
          inserted = true;
          return okAsync({ id: 'share-1', createdAt: new Date(TEST_DAY_START) });
        },
      },
    });
    return { stores, wasInserted: () => inserted };
  }

  it('refuses forbidden when the message is another member’s', async () => {
    const { stores, wasInserted } = gateStores(header({ senderType: 'user', senderId: 'u2' }));
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
    expect(wasInserted()).toBe(false);
  });

  it('refuses forbidden when the message’s human sender has been erased', async () => {
    const { stores, wasInserted } = gateStores(header({ senderType: 'user', senderId: null }));
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
    expect(wasInserted()).toBe(false);
  });

  it('refuses forbidden for a system message, which is neither the caller’s nor the model’s', async () => {
    const { stores, wasInserted } = gateStores(header({ senderType: 'system', senderId: null }));
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
    expect(wasInserted()).toBe(false);
  });

  it('shares the caller’s own message', async () => {
    const { stores } = gateStores(header({ senderType: 'user', senderId: 'u1' }));
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ shareId: 'share-1' });
  });

  it('shares a model-written message for a member who did not prompt it', async () => {
    const { stores } = gateStores(header({ senderType: 'assistant', senderId: 'someone-else' }));
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ shareId: 'share-1' });
  });

  it('answers another member’s pre-floor message not-found, never forbidden', async () => {
    const stores = fakeStores({
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'write', visibleFromEpoch: 3 })),
      },
      messages: {
        headerInConversation: () =>
          okAsync(header({ epochNumber: 2, senderType: 'user', senderId: 'u2' })),
      },
    });
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });
});

describe('readSharedMessage', () => {
  it('refuses not-found when the share does not exist', async () => {
    const stores = fakeStores({ sharedMessages: { byId: () => okAsync(null) } });
    const result = await readSharedMessage(stores, { shareId: 'share-x' });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('returns exactly the one shared message and its content items', async () => {
    let requestedShareId: string | null = null;
    const stores = fakeStores({
      sharedMessages: {
        byId: (shareId) => {
          requestedShareId = shareId;
          return okAsync(sharedMessage());
        },
      },
    });
    const result = await readSharedMessage(stores, { shareId: 'shared-msg-1' });
    expect(result._unsafeUnwrap()).toEqual({
      shareId: 'shared-msg-1',
      messageId: 'msg-1',
      wrappedContentKey: toBase64(new Uint8Array([1, 2])),
      createdAt: new Date(0).toISOString(),
      messageCreatedAt: MESSAGE_CREATED_AT.toISOString(),
      conversationId: CONV,
      epochNumber: 1,
      senderId: 'sender-1',
      epochWrappedContentKey: toBase64(new Uint8Array([3, 4])),
      deleted: false,
      contentItems: [],
    });
    expect(requestedShareId).toBe('shared-msg-1');
  });

  it('rejects a fractional epoch number the view schema declares integral (a defect)', async () => {
    const stores = fakeStores({
      sharedMessages: { byId: () => okAsync(sharedMessage({ epochNumber: 1.5 })) },
    });
    await expect(readSharedMessage(stores, { shareId: 'shared-msg-1' })).rejects.toThrow(ZodError);
  });

  it('returns the envelope AAD inputs the reader needs to decrypt the blob', async () => {
    const stores = fakeStores({
      sharedMessages: {
        byId: () =>
          okAsync(
            sharedMessage({
              conversationId: 'conv-9',
              epochNumber: 4,
              senderId: 'sender-9',
              epochWrappedContentKey: new Uint8Array([9, 9]),
            })
          ),
      },
    });
    const result = await readSharedMessage(stores, { shareId: 'shared-msg-1' });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    expect(view.conversationId).toBe('conv-9');
    expect(view.epochNumber).toBe(4);
    expect(view.senderId).toBe('sender-9');
    expect(view.epochWrappedContentKey).toBe(toBase64(new Uint8Array([9, 9])));
  });

  it('carries a null sender through, since a scrubbed sender cannot match the bound AAD', async () => {
    const stores = fakeStores({
      sharedMessages: { byId: () => okAsync(sharedMessage({ senderId: null })) },
    });
    const result = await readSharedMessage(stores, { shareId: 'shared-msg-1' });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    expect(view.senderId).toBeNull();
  });

  it('carries the persisted reasoning level and token count onto the unauthenticated read', async () => {
    const stores = fakeStores({
      sharedMessages: {
        byId: () =>
          okAsync(
            sharedMessage({
              contentItems: [contentItemRow({ reasoningTokens: 1204, reasoningEffort: 'high' })],
            })
          ),
      },
    });
    const result = await readSharedMessage(stores, { shareId: 'shared-msg-1' });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    expect(view.contentItems[0]?.reasoningTokens).toBe(1204);
    expect(view.contentItems[0]?.reasoningEffort).toBe('high');
  });

  it('carries the recorded reasoning time onto the unauthenticated read', async () => {
    const stores = fakeStores({
      sharedMessages: {
        byId: () =>
          okAsync(
            sharedMessage({
              contentItems: [
                contentItemRow({ id: 'ci-timed', reasoningDurationMs: 14_000 }),
                contentItemRow({ id: 'ci-untimed', position: 1 }),
              ],
            })
          ),
      },
    });
    const result = await readSharedMessage(stores, { shareId: 'shared-msg-1' });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    expect(view.contentItems[0]?.reasoningDurationMs).toBe(14_000);
    expect(view.contentItems[1]?.reasoningDurationMs).toBeNull();
  });

  it('keeps an unrecorded reasoning level distinct from one resolved to `off`', async () => {
    const stores = fakeStores({
      sharedMessages: {
        byId: () =>
          okAsync(
            sharedMessage({
              contentItems: [
                contentItemRow({ id: 'ci-off', reasoningTokens: 0, reasoningEffort: 'off' }),
                contentItemRow({ id: 'ci-none', position: 1 }),
              ],
            })
          ),
      },
    });
    const result = await readSharedMessage(stores, { shareId: 'shared-msg-1' });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    expect(view.contentItems[0]?.reasoningEffort).toBe('off');
    expect(view.contentItems[0]?.reasoningTokens).toBe(0);
    expect(view.contentItems[1]?.reasoningEffort).toBeNull();
    expect(view.contentItems[1]?.reasoningTokens).toBeNull();
  });

  it('serves the shared message own creation date, distinct from the share date', async () => {
    const stores = fakeStores({
      sharedMessages: { byId: () => okAsync(sharedMessage()) },
    });
    const result = await readSharedMessage(stores, { shareId: 'shared-msg-1' });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    expect(view.messageCreatedAt).toBe(MESSAGE_CREATED_AT.toISOString());
    expect(view.messageCreatedAt).not.toBe(view.createdAt);
  });

  it('serves the generating model id on an assistant item', async () => {
    const stores = fakeStores({
      sharedMessages: {
        byId: () =>
          okAsync(
            sharedMessage({ contentItems: [contentItemRow({ modelId: 'anthropic/claude' })] })
          ),
      },
    });
    const result = await readSharedMessage(stores, { shareId: 'shared-msg-1' });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    expect(view.contentItems[0]?.modelName).toBe('anthropic/claude');
  });

  it('serves the item smart-model flag', async () => {
    const stores = fakeStores({
      sharedMessages: {
        byId: () =>
          okAsync(sharedMessage({ contentItems: [contentItemRow({ isSmartModel: true })] })),
      },
    });
    const result = await readSharedMessage(stores, { shareId: 'shared-msg-1' });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    expect(view.contentItems[0]?.isSmartModel).toBe(true);
  });

  it('serves a null model on a user item', async () => {
    const stores = fakeStores({
      sharedMessages: {
        byId: () => okAsync(sharedMessage({ contentItems: [contentItemRow({ modelId: null })] })),
      },
    });
    const result = await readSharedMessage(stores, { shareId: 'shared-msg-1' });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    expect(view.contentItems[0]?.modelName).toBeNull();
  });

  it('withholds the billed cost the history read serves', async () => {
    const stores = fakeStores({
      sharedMessages: {
        byId: () =>
          okAsync(
            sharedMessage({
              contentItems: [
                contentItemRow({
                  costNanoUsd: 1_360_000n,
                  modelId: 'anthropic/claude',
                  isSmartModel: true,
                  reasoningTokens: 1204,
                  reasoningEffort: 'high',
                }),
              ],
            })
          ),
      },
    });
    const result = await readSharedMessage(stores, { shareId: 'shared-msg-1' });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    const item = view.contentItems[0];
    expect(item).not.toHaveProperty('cost');
  });

  it('withholds the input and output token counts the history read serves', async () => {
    const stores = fakeStores({
      sharedMessages: {
        byId: () =>
          okAsync(
            sharedMessage({
              contentItems: [contentItemRow({ inputTokens: 10, outputTokens: 20 })],
            })
          ),
      },
    });
    const result = await readSharedMessage(stores, { shareId: 'shared-msg-1' });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    const item = view.contentItems[0];
    expect(item).not.toHaveProperty('inputTokens');
    expect(item).not.toHaveProperty('outputTokens');
  });

  it('surfaces persisted pixel dimensions and duration on a media content item', async () => {
    const stores = fakeStores({
      sharedMessages: {
        byId: () =>
          okAsync(
            sharedMessage({
              contentItems: [
                contentItemRow({
                  contentType: 'image',
                  mimeType: 'image/png',
                  sizeBytes: 2048,
                  width: 800,
                  height: 1200,
                  durationMs: null,
                  encryptedBlob: null,
                }),
              ],
            })
          ),
      },
    });
    const result = await readSharedMessage(stores, { shareId: 'shared-msg-1' });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    const item = view.contentItems[0];
    expect(item?.width).toBe(800);
    expect(item?.height).toBe(1200);
    expect(item?.durationMs).toBeNull();
  });
});

describe('changeLinkPrivilege', () => {
  const params = {
    conversationId: CONV,
    callerUserId: 'admin-u',
    linkId: LINK,
    privilege: 'write' as const,
  };

  it('refuses a caller who is not a member (not-found)', async () => {
    const stores = fakeStores({ members: { activeByUser: () => okAsync(null) } });
    const result = await changeLinkPrivilege(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses a non-admin caller (forbidden)', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'write' })) },
    });
    const result = await changeLinkPrivilege(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
  });

  it('answers not-found for a missing link', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { byId: () => okAsync(null) },
    });
    const result = await changeLinkPrivilege(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('answers not-found for a revoked link', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { byId: () => okAsync(linkRecord({ revokedAt: new Date(1) })) },
    });
    const result = await changeLinkPrivilege(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('answers not-found for a link of another conversation', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { byId: () => okAsync(linkRecord({ conversationId: 'other' })) },
    });
    const result = await changeLinkPrivilege(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('updates the guest member row and returns its id', async () => {
    let updated: { conversationId: string; linkId: string; privilege: string } | null = null;
    const stores = fakeStores({
      members: {
        activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        updatePrivilegeByLink: (p) => {
          updated = p;
          return okAsync({ id: 'guest-member-1' });
        },
      },
      sharedLinks: { byId: () => okAsync(linkRecord()) },
    });
    const result = await changeLinkPrivilege(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ changed: true, memberId: 'guest-member-1' });
    expect(updated).toEqual({ conversationId: CONV, linkId: LINK, privilege: 'write' });
  });

  it('reports a null member id when the link seats no active guest', async () => {
    const stores = fakeStores({
      members: {
        activeByUser: () => okAsync(memberRecord({ privilege: 'owner' })),
        updatePrivilegeByLink: () => okAsync(null),
      },
      sharedLinks: { byId: () => okAsync(linkRecord()) },
    });
    const result = await changeLinkPrivilege(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ changed: true, memberId: null });
  });
});

describe('changeLinkName', () => {
  const params = {
    conversationId: CONV,
    callerUserId: 'admin-u',
    linkId: LINK,
    displayName: 'renamed',
  };

  it('refuses a caller who is not a member (not-found)', async () => {
    const stores = fakeStores({ members: { activeByUser: () => okAsync(null) } });
    const result = await changeLinkName(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses a non-admin caller (forbidden)', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'write' })) },
    });
    const result = await changeLinkName(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
  });

  it('renames a live link', async () => {
    let written: { conversationId: string; linkId: string; displayName: string } | null = null;
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: {
        updateDisplayName: (p) => {
          written = p;
          return okAsync(true);
        },
      },
    });
    const result = await changeLinkName(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ success: true });
    expect(written).toEqual({ conversationId: CONV, linkId: LINK, displayName: 'renamed' });
  });

  it('answers not-found when the link is missing or revoked', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'owner' })) },
      sharedLinks: { updateDisplayName: () => okAsync(false) },
    });
    const result = await changeLinkName(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });
});
