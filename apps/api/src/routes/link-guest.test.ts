import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';

import { linkGuestRoute } from './link-guest.js';

const TEST_CONVERSATION_ID = 'conv-link-guest-001';
const TEST_LINK_PUBLIC_KEY = new Uint8Array(32).fill(42);
// URL-safe base64 of 32 bytes of 42 (0x2A)
const TEST_LINK_PUBLIC_KEY_BASE64 = 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio';

interface ErrorBody {
  code: string;
}

interface AccessResponseBody {
  conversation: {
    id: string;
    title: string;
    currentEpoch: number;
    titleEpochNumber: number;
  };
  privilege: string;
  wraps: {
    epochNumber: number;
    wrap: string;
    confirmationHash: string;
    visibleFromEpoch: number;
  }[];
  chainLinks: {
    epochNumber: number;
    chainLink: string;
    confirmationHash: string;
  }[];
  messages: {
    id: string;
    conversationId: string;
    encryptedBlob: string;
    senderType: string;
    senderId: string | null;
    senderDisplayName: string | null;
    payerId: string | null;
    cost: string | null;
    epochNumber: number;
    sequenceNumber: number;
    createdAt: string;
  }[];
  members: {
    id: string;
    userId: string | null;
    username: string | null;
    privilege: string;
  }[];
  links: {
    id: string;
    displayName: string | null;
    privilege: string;
    createdAt: string;
  }[];
}

// ── Mock DB infrastructure ──

interface AccessMockDbConfig {
  sharedLink?: {
    id: string;
    conversationId: string;
    linkPublicKey: Uint8Array;
    privilege: string;
    revokedAt: Date | null;
  } | null;
  member?: {
    id: string;
    conversationId: string;
    linkId: string;
    privilege: string;
    visibleFromEpoch: number;
  } | null;
  wraps?:
    | {
        epochNumber: number;
        wrap: Uint8Array;
        confirmationHash: Uint8Array;
        visibleFromEpoch: number;
      }[]
    | undefined;
  chainLinks?:
    | {
        epochNumber: number;
        chainLink: Uint8Array;
        confirmationHash: Uint8Array;
      }[]
    | undefined;
  conversation?: {
    id: string;
    title: Uint8Array;
    currentEpoch: number;
    titleEpochNumber: number;
  } | null;
  messages?:
    | {
        id: string;
        conversationId: string;
        encryptedBlob: Uint8Array;
        senderType: string;
        senderId: string | null;
        senderDisplayName: string | null;
        payerId: string | null;
        cost: string | null;
        epochNumber: number;
        sequenceNumber: number;
        createdAt: Date;
      }[]
    | undefined;
  membersList?:
    | {
        id: string;
        userId: string | null;
        privilege: string;
        username: string | null;
      }[]
    | undefined;
  linksList?:
    | {
        id: string;
        displayName: string | null;
        privilege: string;
        createdAt: Date;
      }[]
    | undefined;
}

/**
 * Creates a mock Drizzle DB for the link-guest access route.
 *
 * The route performs 6 sequential SELECT queries:
 * 1. sharedLinks lookup (select with limit+then)
 * 2. conversationMembers lookup (select with limit+then)
 * 3. epochMembers + epochs join for wraps (select with then)
 * 4. epochs for chainLinks (select with then)
 * 5. conversations lookup (select with limit+then)
 * 6. messages lookup (select with then)
 */
/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
function createQueryChainFactory(
  selectResults: unknown[][],
  indexRef: { value: number }
): () => Record<string, unknown> {
  const createQueryChain = (): Record<string, unknown> => ({
    from: () => createQueryChain(),
    where: () => createQueryChain(),
    innerJoin: () => createQueryChain(),
    leftJoin: () => createQueryChain(),
    orderBy: () => createQueryChain(),
    limit: () => ({
      then: (resolve: (v: unknown[]) => unknown) => {
        const result = selectResults[indexRef.value++] ?? [];
        return Promise.resolve(resolve(result));
      },
    }),
    then: (resolve: (v: unknown[]) => unknown) => {
      const result = selectResults[indexRef.value++] ?? [];
      return Promise.resolve(resolve(result));
    },
  });
  return createQueryChain;
}
/* eslint-enable unicorn/no-thenable */

function createAccessMockDb(config: AccessMockDbConfig): unknown {
  const indexRef = { value: 0 };
  const selectResults: unknown[][] = [
    // 1st: sharedLinks
    config.sharedLink ? [config.sharedLink] : [],
    // 2nd: conversationMembers
    config.member ? [config.member] : [],
    // 3rd: epoch wraps
    config.wraps ?? [],
    // 4th: chain links
    config.chainLinks ?? [],
    // 5th: conversation
    config.conversation ? [config.conversation] : [],
    // 6th: messages
    config.messages ?? [],
    // 7th: members list
    config.membersList ?? [],
    // 8th: links list
    config.linksList ?? [],
  ];

  const createQueryChain = createQueryChainFactory(selectResults, indexRef);
  return {
    select: () => createQueryChain(),
  };
}

function createTestApp(dbConfig: AccessMockDbConfig = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = { NODE_ENV: 'test' } as unknown as AppEnv['Bindings'];
    // No user/session — this is a public endpoint
    c.set('user', null);
    c.set('session', null);
    c.set('db', createAccessMockDb(dbConfig) as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', linkGuestRoute);
  return app;
}

function createAccessBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    conversationId: TEST_CONVERSATION_ID,
    linkPublicKey: TEST_LINK_PUBLIC_KEY_BASE64,
    ...overrides,
  };
}

// ── Shared test fixtures ──

function createDefaultSharedLink(): NonNullable<AccessMockDbConfig['sharedLink']> {
  return {
    id: 'link-001',
    conversationId: TEST_CONVERSATION_ID,
    linkPublicKey: TEST_LINK_PUBLIC_KEY,
    privilege: 'read',
    revokedAt: null,
  };
}

function createDefaultMember(): NonNullable<AccessMockDbConfig['member']> {
  return {
    id: 'member-001',
    conversationId: TEST_CONVERSATION_ID,
    linkId: 'link-001',
    privilege: 'read',
    visibleFromEpoch: 1,
  };
}

function createDefaultConversation(): NonNullable<AccessMockDbConfig['conversation']> {
  return {
    id: TEST_CONVERSATION_ID,
    title: new Uint8Array([116, 101, 115, 116]), // "test" in UTF-8
    currentEpoch: 2,
    titleEpochNumber: 1,
  };
}

function createDefaultWrap(): AccessMockDbConfig['wraps'] {
  return [
    {
      epochNumber: 1,
      wrap: new Uint8Array(48).fill(10),
      confirmationHash: new Uint8Array(32).fill(11),
      visibleFromEpoch: 1,
    },
    {
      epochNumber: 2,
      wrap: new Uint8Array(48).fill(20),
      confirmationHash: new Uint8Array(32).fill(21),
      visibleFromEpoch: 1,
    },
  ];
}

function createDefaultMessages(): NonNullable<AccessMockDbConfig['messages']> {
  return [
    {
      id: 'msg-001',
      conversationId: TEST_CONVERSATION_ID,
      encryptedBlob: new Uint8Array([1, 2, 3, 4]),
      senderType: 'user',
      senderId: 'user-001',
      senderDisplayName: 'Alice',
      payerId: 'user-001',
      cost: null,
      epochNumber: 1,
      sequenceNumber: 1,
      createdAt: new Date('2025-06-01T12:00:00Z'),
    },
    {
      id: 'msg-002',
      conversationId: TEST_CONVERSATION_ID,
      encryptedBlob: new Uint8Array([5, 6, 7, 8]),
      senderType: 'ai',
      senderId: null,
      senderDisplayName: null,
      payerId: 'user-001',
      cost: '0.00136000',
      epochNumber: 1,
      sequenceNumber: 2,
      createdAt: new Date('2025-06-01T12:01:00Z'),
    },
  ];
}

function createDefaultMembersList(): NonNullable<AccessMockDbConfig['membersList']> {
  return [
    {
      id: 'member-owner',
      userId: 'user-001',
      privilege: 'owner',
      username: 'alice',
    },
    {
      id: 'member-001',
      userId: null,
      privilege: 'read',
      username: null,
    },
  ];
}

function createDefaultLinksList(): NonNullable<AccessMockDbConfig['linksList']> {
  return [
    {
      id: 'link-001',
      displayName: 'Guest Link',
      privilege: 'read',
      createdAt: new Date('2025-06-01T10:00:00Z'),
    },
  ];
}

describe('link-guest route', () => {
  describe('POST /access', () => {
    it('returns 404 when shared link not found', async () => {
      const app = createTestApp({
        sharedLink: null,
      });

      const res = await app.request('/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAccessBody()),
      });

      expect(res.status).toBe(404);
      const body = await res.json<ErrorBody>();
      expect(body.code).toBe('LINK_NOT_FOUND');
    });

    it('returns 404 when shared link is revoked', async () => {
      // The revokedAt IS NULL filter in the query means a revoked link returns empty results
      // which is treated the same as not found
      const app = createTestApp({
        sharedLink: null, // revoked links are filtered out by the query
      });

      const res = await app.request('/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAccessBody()),
      });

      expect(res.status).toBe(404);
      const body = await res.json<ErrorBody>();
      expect(body.code).toBe('LINK_NOT_FOUND');
    });

    it('returns conversation data, wraps, chain links, and messages', async () => {
      const chainLinks = [
        {
          epochNumber: 2,
          chainLink: new Uint8Array([99, 100]),
          confirmationHash: new Uint8Array(32).fill(21),
        },
      ];

      const app = createTestApp({
        sharedLink: createDefaultSharedLink(),
        member: createDefaultMember(),
        wraps: createDefaultWrap(),
        chainLinks,
        conversation: createDefaultConversation(),
        messages: createDefaultMessages(),
      });

      const res = await app.request('/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAccessBody()),
      });

      expect(res.status).toBe(200);
      const body = await res.json<AccessResponseBody>();

      // Conversation metadata
      expect(body.conversation.id).toBe(TEST_CONVERSATION_ID);
      expect(body.conversation.currentEpoch).toBe(2);
      expect(body.conversation.titleEpochNumber).toBe(1);
      expect(typeof body.conversation.title).toBe('string'); // base64

      // Privilege
      expect(body.privilege).toBe('read');

      // Wraps
      expect(body.wraps).toHaveLength(2);
      const bodyWrap0 = body.wraps[0]!;
      expect(bodyWrap0.epochNumber).toBe(1);
      expect(typeof bodyWrap0.wrap).toBe('string'); // base64

      // Chain links
      expect(body.chainLinks).toHaveLength(1);
      const bodyCl0 = body.chainLinks[0]!;
      expect(bodyCl0.epochNumber).toBe(2);
      expect(typeof bodyCl0.chainLink).toBe('string'); // base64

      // Messages
      expect(body.messages).toHaveLength(2);
      const msg0 = body.messages[0]!;
      const msg1 = body.messages[1]!;
      expect(msg0.id).toBe('msg-001');
      expect(msg0.senderType).toBe('user');
      expect(msg0.cost).toBeNull();
      expect(msg0.epochNumber).toBe(1);
      expect(msg0.sequenceNumber).toBe(1);
      expect(msg1.cost).toBe('0.00136000');
    });

    it('filters messages by visibleFromEpoch', async () => {
      // Member visible from epoch 2 — messages from epoch 1 should be excluded
      const member = { ...createDefaultMember(), visibleFromEpoch: 2 };

      // Only epoch 2 messages in the result (the query filters at DB level)
      const epoch2Messages = [
        {
          id: 'msg-003',
          conversationId: TEST_CONVERSATION_ID,
          encryptedBlob: new Uint8Array([9, 10]),
          senderType: 'user',
          senderId: 'user-001',
          senderDisplayName: 'Alice',
          payerId: 'user-001',
          cost: null,
          epochNumber: 2,
          sequenceNumber: 3,
          createdAt: new Date('2025-06-02T12:00:00Z'),
        },
      ];

      const app = createTestApp({
        sharedLink: createDefaultSharedLink(),
        member,
        wraps: [
          {
            epochNumber: 2,
            wrap: new Uint8Array(48).fill(20),
            confirmationHash: new Uint8Array(32).fill(21),
            visibleFromEpoch: 2,
          },
        ],
        chainLinks: [],
        conversation: createDefaultConversation(),
        messages: epoch2Messages,
      });

      const res = await app.request('/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAccessBody()),
      });

      expect(res.status).toBe(200);
      const body = await res.json<AccessResponseBody>();
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]?.epochNumber).toBe(2);
    });

    it('filters chain links by visibleFromEpoch', async () => {
      const member = { ...createDefaultMember(), visibleFromEpoch: 2 };

      // Only epoch >= 2 chain links in the result (the query filters at DB level)
      const chainLinks = [
        {
          epochNumber: 2,
          chainLink: new Uint8Array([99, 100]),
          confirmationHash: new Uint8Array(32).fill(21),
        },
        {
          epochNumber: 3,
          chainLink: new Uint8Array([101, 102]),
          confirmationHash: new Uint8Array(32).fill(31),
        },
      ];

      const app = createTestApp({
        sharedLink: createDefaultSharedLink(),
        member,
        wraps: [
          {
            epochNumber: 2,
            wrap: new Uint8Array(48).fill(20),
            confirmationHash: new Uint8Array(32).fill(21),
            visibleFromEpoch: 2,
          },
        ],
        chainLinks,
        conversation: createDefaultConversation(),
        messages: [],
      });

      const res = await app.request('/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAccessBody()),
      });

      expect(res.status).toBe(200);
      const body = await res.json<AccessResponseBody>();
      expect(body.chainLinks).toHaveLength(2);
      expect(body.chainLinks[0]?.epochNumber).toBe(2);
      expect(body.chainLinks[1]?.epochNumber).toBe(3);
    });

    it('filters wraps by visibleFromEpoch', async () => {
      const member = { ...createDefaultMember(), visibleFromEpoch: 2 };

      // Wraps for epochs 1, 2, 3 — but member joined at epoch 2
      const wraps = [
        {
          epochNumber: 1,
          wrap: new Uint8Array(48).fill(10),
          confirmationHash: new Uint8Array(32).fill(11),
          visibleFromEpoch: 2,
        },
        {
          epochNumber: 2,
          wrap: new Uint8Array(48).fill(20),
          confirmationHash: new Uint8Array(32).fill(21),
          visibleFromEpoch: 2,
        },
        {
          epochNumber: 3,
          wrap: new Uint8Array(48).fill(30),
          confirmationHash: new Uint8Array(32).fill(31),
          visibleFromEpoch: 2,
        },
      ];

      const app = createTestApp({
        sharedLink: createDefaultSharedLink(),
        member,
        wraps,
        chainLinks: [],
        conversation: { ...createDefaultConversation(), currentEpoch: 3 },
        messages: [],
      });

      const res = await app.request('/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAccessBody()),
      });

      expect(res.status).toBe(200);
      const body = await res.json<AccessResponseBody>();

      // Only epochs 2 and 3 wraps should be returned (epoch 1 filtered by visibleFromEpoch)
      expect(body.wraps).toHaveLength(2);
      expect(body.wraps[0]?.epochNumber).toBe(2);
      expect(body.wraps[1]?.epochNumber).toBe(3);
    });

    it('serializes binary fields as base64', async () => {
      const app = createTestApp({
        sharedLink: createDefaultSharedLink(),
        member: createDefaultMember(),
        wraps: createDefaultWrap(),
        chainLinks: [
          {
            epochNumber: 2,
            chainLink: new Uint8Array([99, 100]),
            confirmationHash: new Uint8Array(32).fill(21),
          },
        ],
        conversation: createDefaultConversation(),
        messages: createDefaultMessages(),
      });

      const res = await app.request('/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAccessBody()),
      });

      expect(res.status).toBe(200);
      const body = await res.json<AccessResponseBody>();

      // All binary fields should be strings (base64), not arrays or objects
      expect(typeof body.conversation.title).toBe('string');
      expect(body.conversation.title.length).toBeGreaterThan(0);

      for (const wrap of body.wraps) {
        expect(typeof wrap.wrap).toBe('string');
        expect(wrap.wrap.length).toBeGreaterThan(0);
      }

      for (const cl of body.chainLinks) {
        expect(typeof cl.chainLink).toBe('string');
        expect(cl.chainLink.length).toBeGreaterThan(0);
      }

      for (const msg of body.messages) {
        expect(typeof msg.encryptedBlob).toBe('string');
        expect(msg.encryptedBlob.length).toBeGreaterThan(0);
        // createdAt should be ISO string
        expect(msg.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    });

    it('returns members and links in the response', async () => {
      const app = createTestApp({
        sharedLink: createDefaultSharedLink(),
        member: createDefaultMember(),
        wraps: createDefaultWrap(),
        chainLinks: [],
        conversation: createDefaultConversation(),
        messages: [],
        membersList: createDefaultMembersList(),
        linksList: createDefaultLinksList(),
      });

      const res = await app.request('/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAccessBody()),
      });

      expect(res.status).toBe(200);
      const body = await res.json<AccessResponseBody>();

      expect(body.members).toHaveLength(2);
      const member0 = body.members[0]!;
      const member1 = body.members[1]!;
      expect(member0.id).toBe('member-owner');
      expect(member0.userId).toBe('user-001');
      expect(member0.username).toBe('alice');
      expect(member0.privilege).toBe('owner');
      expect(member1.userId).toBeNull();
      expect(member1.username).toBeNull();

      expect(body.links).toHaveLength(1);
      const link0 = body.links[0]!;
      expect(link0.id).toBe('link-001');
      expect(link0.displayName).toBe('Guest Link');
      expect(link0.privilege).toBe('read');
      expect(link0.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns 400 when body is missing required fields', async () => {
      const app = createTestApp({});

      const res = await app.request('/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns empty messages array for new conversation', async () => {
      const app = createTestApp({
        sharedLink: createDefaultSharedLink(),
        member: createDefaultMember(),
        wraps: createDefaultWrap(),
        chainLinks: [],
        conversation: createDefaultConversation(),
        messages: [],
      });

      const res = await app.request('/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAccessBody()),
      });

      expect(res.status).toBe(200);
      const body = await res.json<AccessResponseBody>();
      expect(body.messages).toEqual([]);
      expect(body.chainLinks).toEqual([]);
    });
  });

  describe('PATCH /name', () => {
    // ── Mock DB for the name update route ──

    interface NameMockDbConfig {
      sharedLink?: {
        id: string;
        conversationId: string;
        linkPublicKey: Uint8Array;
        revokedAt: Date | null;
      } | null;
      updateResult?: { rowCount: number };
    }

    function createNameMockDb(config: NameMockDbConfig): unknown {
      const indexRef = { value: 0 };
      const selectResults: unknown[][] = [
        // 1st select: sharedLinks lookup
        config.sharedLink ? [config.sharedLink] : [],
      ];

      const createQueryChain = createQueryChainFactory(selectResults, indexRef);
      return {
        select: () => createQueryChain(),
        update: () => ({
          set: () => ({
            where: () => Promise.resolve(config.updateResult ?? { rowCount: 1 }),
          }),
        }),
      };
    }

    function createNameTestApp(dbConfig: NameMockDbConfig = {}): Hono<AppEnv> {
      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        c.env = { NODE_ENV: 'test' } as unknown as AppEnv['Bindings'];
        c.set('user', null);
        c.set('session', null);
        c.set('db', createNameMockDb(dbConfig) as AppEnv['Variables']['db']);
        await next();
      });

      app.route('/', linkGuestRoute);
      return app;
    }

    function createNameBody(overrides?: Record<string, unknown>): Record<string, unknown> {
      return {
        conversationId: TEST_CONVERSATION_ID,
        linkPublicKey: TEST_LINK_PUBLIC_KEY_BASE64,
        displayName: 'Guest Alice',
        ...overrides,
      };
    }

    it('returns 200 and updates display name', async () => {
      const app = createNameTestApp({
        sharedLink: {
          id: 'link-001',
          conversationId: TEST_CONVERSATION_ID,
          linkPublicKey: TEST_LINK_PUBLIC_KEY,
          revokedAt: null,
        },
      });

      const res = await app.request('/name', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createNameBody()),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ success: boolean }>();
      expect(body.success).toBe(true);
    });

    it('returns 404 when shared link not found', async () => {
      const app = createNameTestApp({
        sharedLink: null,
      });

      const res = await app.request('/name', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createNameBody()),
      });

      expect(res.status).toBe(404);
      const body = await res.json<ErrorBody>();
      expect(body.code).toBe('LINK_NOT_FOUND');
    });

    it('returns 400 when displayName is empty', async () => {
      const app = createNameTestApp({});

      const res = await app.request('/name', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createNameBody({ displayName: '' })),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when displayName exceeds max length', async () => {
      const app = createNameTestApp({});

      const res = await app.request('/name', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createNameBody({ displayName: 'A'.repeat(101) })),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when displayName is missing', async () => {
      const app = createNameTestApp({});

      const res = await app.request('/name', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: TEST_CONVERSATION_ID,
          linkPublicKey: TEST_LINK_PUBLIC_KEY_BASE64,
        }),
      });

      expect(res.status).toBe(400);
    });
  });
});
