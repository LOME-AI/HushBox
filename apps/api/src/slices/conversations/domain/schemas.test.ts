import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toBase64 } from '@hushbox/shared';
import {
  HOUR_MS,
  SECOND_MS,
  TEST_DAY_START,
  freezeClock,
  isoAt,
  testUuidV7,
} from '@hushbox/shared/test-time';
import {
  addMemberBodySchema,
  createLinkBodySchema,
  createSharedMessageBodySchema,
  shareIdParameterSchema,
  linkParameterSchema,
  listConversationsQuerySchema,
  muteBodySchema,
  pinBodySchema,
  removeMemberBodySchema,
  revokeLinkBodySchema,
  updateForkTipBodySchema,
} from './schemas.js';

const B64 = toBase64(new Uint8Array([1, 2, 3]));
const UUID = testUuidV7(1);

const rotation = {
  expectedEpoch: 1,
  epochPublicKey: B64,
  confirmationHash: B64,
  chainLink: B64,
  memberWraps: [{ memberPublicKey: B64, wrap: B64 }],
  encryptedTitle: B64,
};

describe('addMemberBodySchema', () => {
  const base = { userId: UUID, privilege: 'write', giveFullHistory: true };

  it('accepts a full-history add carrying a wrap and the expected epoch', () => {
    expect(addMemberBodySchema.safeParse({ ...base, wrap: B64, expectedEpoch: 1 }).success).toBe(
      true
    );
  });

  it('rejects a full-history add without a wrap', () => {
    expect(addMemberBodySchema.safeParse({ ...base, expectedEpoch: 1 }).success).toBe(false);
  });

  it('rejects a full-history add without an expected epoch', () => {
    expect(addMemberBodySchema.safeParse({ ...base, wrap: B64 }).success).toBe(false);
  });

  it('accepts a rotation add without history', () => {
    expect(
      addMemberBodySchema.safeParse({ ...base, giveFullHistory: false, rotation }).success
    ).toBe(true);
  });

  it('rejects a no-history add without a rotation', () => {
    expect(addMemberBodySchema.safeParse({ ...base, giveFullHistory: false }).success).toBe(false);
  });

  it('rejects granting the owner privilege', () => {
    expect(
      addMemberBodySchema.safeParse({ ...base, privilege: 'owner', wrap: B64, expectedEpoch: 1 })
        .success
    ).toBe(false);
  });
});

describe('removeMemberBodySchema', () => {
  it('requires a rotation', () => {
    expect(removeMemberBodySchema.safeParse({}).success).toBe(false);
    expect(removeMemberBodySchema.safeParse({ rotation }).success).toBe(true);
  });
});

describe('mute and pin bodies', () => {
  it('requires a boolean muted flag', () => {
    expect(muteBodySchema.safeParse({ muted: true }).success).toBe(true);
    expect(muteBodySchema.safeParse({ muted: 'yes' }).success).toBe(false);
  });

  it('requires a boolean pinned flag', () => {
    expect(pinBodySchema.safeParse({ pinned: false }).success).toBe(true);
    expect(pinBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('fork tip bodies', () => {
  it('accepts a tip update expecting no prior tip', () => {
    expect(
      updateForkTipBodySchema.safeParse({ tipMessageId: UUID, expectedTipMessageId: null }).success
    ).toBe(true);
  });

  it('rejects a tip update without the expected-state field', () => {
    expect(updateForkTipBodySchema.safeParse({ tipMessageId: UUID }).success).toBe(false);
  });
});

describe('listConversationsQuerySchema', () => {
  it('coerces the limit and bounds it at 100', () => {
    expect(listConversationsQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(listConversationsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('accepts an absent cursor', () => {
    expect(listConversationsQuerySchema.safeParse({}).success).toBe(true);
  });
});

describe('createLinkBodySchema', () => {
  const fullHistory = {
    linkPublicKey: B64,
    linkAuthHash: B64,
    privilege: 'read' as const,
    giveFullHistory: true,
    memberWrap: B64,
    expectedEpoch: 1,
  };

  beforeEach(() => {
    freezeClock(TEST_DAY_START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts a full-history mint with a display name and ISO expiry', () => {
    expect(
      createLinkBodySchema.safeParse({
        ...fullHistory,
        displayName: 'My share',
        expiresAt: isoAt(TEST_DAY_START + HOUR_MS),
      }).success
    ).toBe(true);
  });

  it('rejects an expiry that has already lapsed', () => {
    expect(
      createLinkBodySchema.safeParse({
        ...fullHistory,
        expiresAt: isoAt(TEST_DAY_START - SECOND_MS),
      }).success
    ).toBe(false);
  });

  it('rejects an expiry at the current instant', () => {
    expect(
      createLinkBodySchema.safeParse({ ...fullHistory, expiresAt: isoAt(TEST_DAY_START) }).success
    ).toBe(false);
  });

  it('accepts an expiry one second away', () => {
    expect(
      createLinkBodySchema.safeParse({
        ...fullHistory,
        expiresAt: isoAt(TEST_DAY_START + SECOND_MS),
      }).success
    ).toBe(true);
  });

  it('accepts a rotation mint carrying a rotation and no full history', () => {
    expect(
      createLinkBodySchema.safeParse({
        linkPublicKey: B64,
        linkAuthHash: B64,
        privilege: 'write',
        giveFullHistory: false,
        rotation,
      }).success
    ).toBe(true);
  });

  it('rejects a full-history mint missing its wrap material', () => {
    expect(
      createLinkBodySchema.safeParse({
        linkPublicKey: B64,
        linkAuthHash: B64,
        privilege: 'read',
        giveFullHistory: true,
      }).success
    ).toBe(false);
  });

  it('rejects a mint without full history and without a rotation', () => {
    expect(
      createLinkBodySchema.safeParse({
        linkPublicKey: B64,
        linkAuthHash: B64,
        privilege: 'read',
        giveFullHistory: false,
      }).success
    ).toBe(false);
  });

  it('rejects a mint without an auth hash', () => {
    expect(
      createLinkBodySchema.safeParse({ ...fullHistory, linkAuthHash: undefined }).success
    ).toBe(false);
  });

  it('rejects a non-base64 auth hash', () => {
    expect(createLinkBodySchema.safeParse({ ...fullHistory, linkAuthHash: '@@@' }).success).toBe(
      false
    );
  });

  it('rejects an admin privilege grant for a link guest', () => {
    expect(createLinkBodySchema.safeParse({ ...fullHistory, privilege: 'admin' }).success).toBe(
      false
    );
  });

  it('rejects a non-base64 public key', () => {
    expect(createLinkBodySchema.safeParse({ ...fullHistory, linkPublicKey: '@@@' }).success).toBe(
      false
    );
  });

  it('rejects a non-ISO expiry', () => {
    expect(createLinkBodySchema.safeParse({ ...fullHistory, expiresAt: 'tomorrow' }).success).toBe(
      false
    );
  });

  it('accepts a display name at the 100-char cap', () => {
    expect(
      createLinkBodySchema.safeParse({ ...fullHistory, displayName: 'x'.repeat(100) }).success
    ).toBe(true);
  });

  it('rejects a display name over the 100-char cap', () => {
    expect(
      createLinkBodySchema.safeParse({ ...fullHistory, displayName: 'x'.repeat(101) }).success
    ).toBe(false);
  });
});

describe('revokeLinkBodySchema', () => {
  it('requires a departure rotation', () => {
    expect(revokeLinkBodySchema.safeParse({ rotation }).success).toBe(true);
    expect(revokeLinkBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('createSharedMessageBodySchema', () => {
  it('accepts a message id and wrapped content key', () => {
    expect(
      createSharedMessageBodySchema.safeParse({
        messageId: UUID,
        wrappedContentKey: B64,
      }).success
    ).toBe(true);
  });

  it('rejects a non-uuid message id', () => {
    expect(
      createSharedMessageBodySchema.safeParse({
        messageId: 'nope',
        wrappedContentKey: B64,
      }).success
    ).toBe(false);
  });

  it('rejects a body without a wrapped content key', () => {
    expect(createSharedMessageBodySchema.safeParse({ messageId: UUID }).success).toBe(false);
  });
});

describe('link parameter schemas', () => {
  it('accepts a conversation id and link id pair', () => {
    expect(linkParameterSchema.safeParse({ conversationId: UUID, linkId: UUID }).success).toBe(
      true
    );
  });

  it('accepts a bare share id for the public read', () => {
    expect(shareIdParameterSchema.safeParse({ shareId: UUID }).success).toBe(true);
  });

  it('rejects a non-uuid share id', () => {
    expect(shareIdParameterSchema.safeParse({ shareId: 'nope' }).success).toBe(false);
  });
});
