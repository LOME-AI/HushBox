import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── submitRotation mock (vi.hoisted ensures availability before vi.mock factory) ──
const mockSubmitRotation = vi.hoisted(() => vi.fn());

// ── broadcastToRoom mock ──
const mockBroadcastToRoom = vi.hoisted(() => vi.fn().mockResolvedValue({ sent: 0 }));
vi.mock('../lib/broadcast.js', () => ({
  broadcastToRoom: (...args: unknown[]) => mockBroadcastToRoom(...args),
}));

vi.mock('../services/keys/keys.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/keys/keys.js')>();
  return {
    ...original,
    submitRotation: (...args: unknown[]) => mockSubmitRotation(...args),
  };
});

import { StaleEpochError, WrapSetMismatchError } from '../services/keys/keys.js';
import { Hono } from 'hono';
import { membersRoute } from './members.js';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';

const TEST_USER_ID = 'user-member-123';
const TEST_CONVERSATION_ID = 'conv-member-456';
const TEST_TARGET_USER_ID = 'user-target-789';
const TEST_EPOCH_ID = 'epoch-current-001';
const TEST_TARGET_PUBLIC_KEY = new Uint8Array(32).fill(42);
const TEST_TARGET_USERNAME = 'target_user';
// Valid URL-safe base64 wrap value (48 bytes as base64)
const TEST_WRAP_BASE64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

interface MockMemberRow {
  id: string;
  userId: string | null;
  linkId: string | null;
  privilege: string;
  visibleFromEpoch: number;
  joinedAt: Date;
  username: string | null;
}

/**
 * Creates a mock Drizzle DB for the GET list-members route.
 * The middleware does: select→from→where→limit→then (returns requesterMember or [])
 * The handler does: select→from→leftJoin→where (returns full member list)
 */
function createMockDb(
  members: MockMemberRow[],
  middlewareMember?: { id: string; privilege: string; visibleFromEpoch: number } | null
): unknown {
  /* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
  const createFullChain = (): Record<string, unknown> => ({
    from: () => createFullChain(),
    where: () => createFullChain(),
    leftJoin: () => createFullChain(),
    innerJoin: () => createFullChain(),
    limit: () => ({
      then: (resolve: (v: unknown[]) => unknown) => {
        // First .limit().then() call is from the middleware
        const result = middlewareMember ? [middlewareMember] : [];
        return Promise.resolve(resolve(result));
      },
    }),
    then: (resolve: (v: unknown[]) => unknown) => {
      // .then() without .limit() is the handler's full member list query
      return Promise.resolve(resolve(members));
    },
  });
  /* eslint-enable unicorn/no-thenable */

  return {
    select: () => createFullChain(),
  };
}

function createMockSession(): SessionData {
  return {
    sessionId: `session-${TEST_USER_ID}`,
    userId: TEST_USER_ID,
    email: 'test@example.com',
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: false,
    pending2FA: false,
    pending2FAExpiresAt: 0,
    createdAt: Date.now(),
  };
}

function createMockUser(): AppEnv['Variables']['user'] {
  return {
    id: TEST_USER_ID,
    email: 'test@example.com',
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: false,
    publicKey: new Uint8Array(32),
  };
}

interface TestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  members?: MockMemberRow[];
  middlewareMember?: { id: string; privilege: string; visibleFromEpoch: number } | null;
}

function createTestApp(options: TestAppOptions = {}): Hono<AppEnv> {
  const { user = createMockUser(), members = [], middlewareMember } = options;
  // Default: if middlewareMember not explicitly provided, derive from members list
  const effectiveMiddlewareMember =
    middlewareMember === undefined
      ? (() => {
          const self = members.find((m) => m.userId === TEST_USER_ID);
          return self
            ? { id: self.id, privilege: self.privilege, visibleFromEpoch: self.visibleFromEpoch }
            : null;
        })()
      : middlewareMember;

  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', createMockDb(members, effectiveMiddlewareMember) as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', membersRoute);
  return app;
}

// ── Shared query chain helper ──

/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
function createQueryChainFactory(
  selectResults: unknown[][],
  indexRef: { value: number }
): () => Record<string, unknown> {
  const createQueryChain = (): Record<string, unknown> => ({
    from: () => createQueryChain(),
    where: () => createQueryChain(),
    leftJoin: () => createQueryChain(),
    innerJoin: () => createQueryChain(),
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

// ── Add-member mock infrastructure ──

interface AddMockMemberRow {
  id: string;
  privilege: string;
}

interface AddMockTargetUser {
  id: string;
  publicKey: Uint8Array;
  username: string;
}

interface AddMockEpochRow {
  id: string;
  epochNumber: number;
}

interface AddMockConversationRow {
  id: string;
  currentEpoch: number;
}

interface AddMockDbConfig {
  requesterMember?: AddMockMemberRow | null;
  targetUser?: AddMockTargetUser | null;
  duplicateInsert?: boolean;
  conversation?: AddMockConversationRow | null;
  currentEpoch?: AddMockEpochRow | null;
  memberCount?: number;
}

/**
 * Creates a mock Drizzle DB that handles multiple sequential select queries
 * required by the add-member route (now with middleware query first):
 * 0. Middleware: requester membership lookup (select→from→where→limit→then)
 * 1. Target user lookup
 * 2. Conversation + current epoch lookup
 *
 * Transaction uses onConflictDoNothing for atomic duplicate detection.
 */
function createAddMemberMockDb(config: AddMockDbConfig): {
  db: unknown;
  capturedMemberInsertValues: unknown[];
} {
  const indexRef = { value: 0 };
  const selectResults: unknown[][] = [
    // Query 0: middleware's membership lookup
    config.requesterMember
      ? [
          {
            id: config.requesterMember.id,
            privilege: config.requesterMember.privilege,
            visibleFromEpoch: 1,
          },
        ]
      : [],
    // Query 1: target user lookup
    config.targetUser ? [config.targetUser] : [],
    // Query 2: conversation + epoch lookup (includes memberCount scalar subquery)
    config.conversation && config.currentEpoch
      ? [
          {
            conversation: config.conversation,
            epoch: config.currentEpoch,
            memberCount: config.memberCount ?? 1,
          },
        ]
      : [],
  ];
  const createQueryChain = createQueryChainFactory(selectResults, indexRef);

  const capturedMemberInsertValues: unknown[] = [];
  let insertCallIndex = 0;
  const txMock = {
    insert: () => {
      const callIndex = insertCallIndex++;
      if (callIndex === 0) {
        // conversationMembers INSERT with onConflictDoNothing().returning()
        return {
          values: (vals: unknown) => {
            capturedMemberInsertValues.push(vals);
            return {
              onConflictDoNothing: () => ({
                returning: () =>
                  Promise.resolve(
                    config.duplicateInsert
                      ? []
                      : [
                          {
                            id: 'new-member-id',
                            userId: TEST_TARGET_USER_ID,
                            privilege: 'write',
                            visibleFromEpoch: 1,
                            joinedAt: new Date('2025-01-01T00:00:00Z'),
                          },
                        ]
                  ),
              }),
            };
          },
        };
      }
      // epochMembers INSERT (no returning needed)
      return {
        values: () => Promise.resolve(),
      };
    },
  };

  const db = {
    select: () => createQueryChain(),
    transaction: async (function_: (tx: unknown) => Promise<unknown>) => function_(txMock),
  };

  return { db, capturedMemberInsertValues };
}

interface AddTestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  dbConfig?: AddMockDbConfig;
}

interface AddTestAppResult {
  app: Hono<AppEnv>;
  capturedMemberInsertValues: unknown[];
}

function createAddTestApp(options: AddTestAppOptions = {}): AddTestAppResult {
  const { user = createMockUser(), dbConfig = {} } = options;
  const { db, capturedMemberInsertValues } = createAddMemberMockDb(dbConfig);
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = {
      NODE_ENV: 'test',
    } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', db as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', membersRoute);
  return { app, capturedMemberInsertValues };
}

function createAddMemberBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    userId: TEST_TARGET_USER_ID,
    wrap: TEST_WRAP_BASE64,
    privilege: 'write',
    giveFullHistory: true,
    ...overrides,
  };
}

function createTestRotation(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    expectedEpoch: 1,
    epochPublicKey: 'dGVzdC1lcG9jaC1wdWJsaWMta2V5',
    confirmationHash: 'dGVzdC1jb25maXJtYXRpb24taGFzaA',
    chainLink: 'dGVzdC1jaGFpbi1saW5r',
    memberWraps: [
      {
        memberPublicKey: 'dGVzdC1tZW1iZXItcHVibGlj',
        wrap: 'dGVzdC13cmFw',
      },
    ],
    encryptedTitle: 'dGVzdC1lbmNyeXB0ZWQtdGl0bGU',
    ...overrides,
  };
}

// ── Remove-member mock infrastructure ──

const TEST_REMOVE_TARGET_MEMBER_ID = 'member-target-remove-001';

interface RemoveMockMemberRow {
  id: string;
  privilege: string;
  userId: string;
  conversationId?: string;
}

interface RemoveMockDbConfig {
  requesterMember?: RemoveMockMemberRow | null;
  targetMember?: RemoveMockMemberRow | null;
}

/**
 * Creates a mock Drizzle DB for the remove-member route (now with middleware query first):
 * 0. Middleware: requester membership lookup (select→from→where→limit→then)
 * 1. Target membership lookup (select with limit+then)
 * 2. Transaction: update leftAt, submitRotation
 */
function createRemoveMemberMockDb(config: RemoveMockDbConfig): unknown {
  const indexRef = { value: 0 };
  const selectResults: unknown[][] = [
    // Query 0: middleware's membership lookup
    config.requesterMember
      ? [
          {
            id: config.requesterMember.id,
            privilege: config.requesterMember.privilege,
            visibleFromEpoch: 1,
          },
        ]
      : [],
    // Query 1: target membership lookup
    config.targetMember ? [config.targetMember] : [],
  ];
  const createQueryChain = createQueryChainFactory(selectResults, indexRef);

  const txMock = {
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
    insert: () => ({
      values: () => Promise.resolve(),
    }),
  };

  return {
    select: () => createQueryChain(),
    transaction: async (function_: (tx: unknown) => Promise<unknown>) => function_(txMock),
  };
}

interface RemoveTestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  dbConfig?: RemoveMockDbConfig;
}

function createRemoveTestApp(options: RemoveTestAppOptions = {}): Hono<AppEnv> {
  const { user = createMockUser(), dbConfig = {} } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = {
      NODE_ENV: 'test',
    } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', createRemoveMemberMockDb(dbConfig) as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', membersRoute);
  return app;
}

function createRemoveMemberBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    memberId: TEST_REMOVE_TARGET_MEMBER_ID,
    rotation: createTestRotation(),
    ...overrides,
  };
}

// ── Leave mock infrastructure ──

interface LeaveMockDbConfig {
  requesterMember?: { id: string; privilege: string; userId: string } | null;
}

/**
 * Creates a mock Drizzle DB for the leave route (now with middleware query first):
 * 0. Middleware: requester membership lookup (select→from→where→limit→then)
 * 1. Owner case: db.delete chain
 * 2. Non-owner case: db.transaction with update + insert + update
 */
function createLeaveMockDb(config: LeaveMockDbConfig): unknown {
  const indexRef = { value: 0 };
  const selectResults: unknown[][] = [
    // Query 0: middleware's membership lookup
    config.requesterMember
      ? [
          {
            id: config.requesterMember.id,
            privilege: config.requesterMember.privilege,
            visibleFromEpoch: 1,
          },
        ]
      : [],
  ];
  const createQueryChain = createQueryChainFactory(selectResults, indexRef);

  const txMock = {
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
    insert: () => ({
      values: () => Promise.resolve(),
    }),
  };

  return {
    select: () => createQueryChain(),
    delete: () => ({
      where: () => Promise.resolve(),
    }),
    transaction: async (function_: (tx: unknown) => Promise<unknown>) => function_(txMock),
  };
}

interface LeaveTestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  dbConfig?: LeaveMockDbConfig;
}

function createLeaveTestApp(options: LeaveTestAppOptions = {}): Hono<AppEnv> {
  const { user = createMockUser(), dbConfig = {} } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = {
      NODE_ENV: 'test',
    } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', createLeaveMockDb(dbConfig) as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', membersRoute);
  return app;
}

// ── Update-privilege mock infrastructure ──

const TEST_TARGET_MEMBER_ID = 'member-target-999';

interface PrivilegeMockDbConfig {
  requesterMember?: { id: string; privilege: string; userId: string } | null;
  targetMember?: { id: string; privilege: string; userId: string } | null;
}

/**
 * Creates a mock Drizzle DB for the update-privilege route (now with middleware query first):
 * 0. Middleware: requester membership lookup (select→from→where→limit→then)
 * 1. Target membership lookup (select with limit+then)
 * 2. Update privilege (update chain)
 */
function createPrivilegeMockDb(config: PrivilegeMockDbConfig): unknown {
  const indexRef = { value: 0 };
  const selectResults: unknown[][] = [
    // Query 0: middleware's membership lookup
    config.requesterMember
      ? [
          {
            id: config.requesterMember.id,
            privilege: config.requesterMember.privilege,
            visibleFromEpoch: 1,
          },
        ]
      : [],
    // Query 1: target membership lookup
    config.targetMember ? [config.targetMember] : [],
  ];
  const createQueryChain = createQueryChainFactory(selectResults, indexRef);

  return {
    select: () => createQueryChain(),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  };
}

interface PrivilegeTestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  dbConfig?: PrivilegeMockDbConfig;
}

function createPrivilegeTestApp(options: PrivilegeTestAppOptions = {}): Hono<AppEnv> {
  const { user = createMockUser(), dbConfig = {} } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', createPrivilegeMockDb(dbConfig) as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', membersRoute);
  return app;
}

function createPrivilegeBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    memberId: TEST_TARGET_MEMBER_ID,
    privilege: 'write',
    ...overrides,
  };
}

describe('members route', () => {
  describe('GET /:conversationId', () => {
    it('returns 401 when not authenticated', async () => {
      const app = createTestApp({ user: null });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 when user is not a member', async () => {
      const app = createTestApp({ members: [], middlewareMember: null });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_FOUND');
    });

    it('returns members list for valid member', async () => {
      const members: MockMemberRow[] = [
        {
          id: 'member-1',
          userId: TEST_USER_ID,
          linkId: null,
          privilege: 'owner',
          visibleFromEpoch: 1,
          joinedAt: new Date('2024-06-01T12:00:00Z'),
          username: 'test_user',
        },
        {
          id: 'member-2',
          userId: 'user-other-456',
          linkId: null,
          privilege: 'write',
          visibleFromEpoch: 1,
          joinedAt: new Date('2024-06-02T12:00:00Z'),
          username: 'other_user',
        },
      ];
      const app = createTestApp({ members });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{ members: unknown[] }>();
      expect(body.members).toHaveLength(2);
    });

    it('filters out members with leftAt set via DB query', async () => {
      // The route uses `isNull(conversationMembers.leftAt)` in WHERE,
      // so the mock DB only returns active members. An empty result
      // where the user is absent means the mock simulates the filter.
      const activeMembers: MockMemberRow[] = [
        {
          id: 'member-1',
          userId: TEST_USER_ID,
          linkId: null,
          privilege: 'owner',
          visibleFromEpoch: 1,
          joinedAt: new Date('2024-06-01T12:00:00Z'),
          username: 'test_user',
        },
      ];
      const app = createTestApp({ members: activeMembers });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{ members: unknown[] }>();
      // Only active member returned (leftAt members excluded by query)
      expect(body.members).toHaveLength(1);
    });

    it('includes username from users table join', async () => {
      const members: MockMemberRow[] = [
        {
          id: 'member-1',
          userId: TEST_USER_ID,
          linkId: null,
          privilege: 'owner',
          visibleFromEpoch: 1,
          joinedAt: new Date('2024-06-01T12:00:00Z'),
          username: 'test_user',
        },
        {
          id: 'member-2',
          userId: 'user-other-789',
          linkId: null,
          privilege: 'write',
          visibleFromEpoch: 2,
          joinedAt: new Date('2024-07-01T12:00:00Z'),
          username: 'joined_user',
        },
      ];
      const app = createTestApp({ members });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        members: { username: string | null }[];
      }>();
      const usernames = body.members.map((m) => m.username);
      expect(usernames).toContain('test_user');
      expect(usernames).toContain('joined_user');
    });

    it('excludes link-only members from response', async () => {
      const members: MockMemberRow[] = [
        {
          id: 'member-1',
          userId: TEST_USER_ID,
          linkId: null,
          privilege: 'owner',
          visibleFromEpoch: 1,
          joinedAt: new Date('2024-06-01T12:00:00Z'),
          username: 'test_user',
        },
        {
          id: 'member-link-1',
          userId: null,
          linkId: 'link-abc',
          privilege: 'read',
          visibleFromEpoch: 1,
          joinedAt: new Date('2024-06-03T12:00:00Z'),
          username: null,
        },
      ];
      const app = createTestApp({ members });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{ members: { id: string }[] }>();
      expect(body.members).toHaveLength(1);
      expect(body.members[0]?.id).toBe('member-1');
    });

    it('serializes joinedAt as ISO string', async () => {
      const members: MockMemberRow[] = [
        {
          id: 'member-1',
          userId: TEST_USER_ID,
          linkId: null,
          privilege: 'owner',
          visibleFromEpoch: 1,
          joinedAt: new Date('2024-06-01T12:00:00.000Z'),
          username: 'test_user',
        },
      ];
      const app = createTestApp({ members });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        members: { joinedAt: string }[];
      }>();
      expect(body.members[0]?.joinedAt).toBe('2024-06-01T12:00:00.000Z');
    });

    it('includes all member fields in response', async () => {
      const members: MockMemberRow[] = [
        {
          id: 'member-full-1',
          userId: TEST_USER_ID,
          linkId: null,
          privilege: 'owner',
          visibleFromEpoch: 3,
          joinedAt: new Date('2024-06-01T12:00:00Z'),
          username: 'test_user',
        },
      ];
      const app = createTestApp({ members });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        members: {
          id: string;
          userId: string | null;
          linkId: string | null;
          username: string | null;
          privilege: string;
          visibleFromEpoch: number;
          joinedAt: string;
        }[];
      }>();
      const member = body.members[0];
      expect(member).toBeDefined();
      expect(member?.id).toBe('member-full-1');
      expect(member?.userId).toBe(TEST_USER_ID);
      expect(member?.linkId).toBeNull();
      expect(member?.username).toBe('test_user');
      expect(member?.privilege).toBe('owner');
      expect(member?.visibleFromEpoch).toBe(3);
      expect(typeof member?.joinedAt).toBe('string');
    });
  });

  describe('POST /:conversationId/add', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it('returns 401 when not authenticated', async () => {
      const { app } = createAddTestApp({ user: null });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAddMemberBody()),
      });

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 403 when requester has write privilege', async () => {
      const { app } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'write' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAddMemberBody()),
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('PRIVILEGE_INSUFFICIENT');
    });

    it('returns 403 when requester has read privilege', async () => {
      const { app } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'read' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAddMemberBody()),
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('PRIVILEGE_INSUFFICIENT');
    });

    it('returns 404 when requester is not a member', async () => {
      const { app } = createAddTestApp({
        dbConfig: {
          requesterMember: null,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAddMemberBody()),
      });

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_FOUND');
    });

    it('returns 404 when target user not found', async () => {
      const { app } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          targetUser: null,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAddMemberBody()),
      });

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_FOUND');
    });

    it('returns 409 when target is already an active member', async () => {
      const { app } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          targetUser: {
            id: TEST_TARGET_USER_ID,
            publicKey: TEST_TARGET_PUBLIC_KEY,
            username: TEST_TARGET_USERNAME,
          },
          duplicateInsert: true,
          conversation: { id: TEST_CONVERSATION_ID, currentEpoch: 1 },
          currentEpoch: { id: TEST_EPOCH_ID, epochNumber: 1 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAddMemberBody()),
      });

      expect(res.status).toBe(409);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('ALREADY_MEMBER');
    });

    it('returns 400 when conversation has reached member limit', async () => {
      const { app } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          targetUser: {
            id: TEST_TARGET_USER_ID,
            publicKey: TEST_TARGET_PUBLIC_KEY,
            username: TEST_TARGET_USERNAME,
          },
          conversation: { id: TEST_CONVERSATION_ID, currentEpoch: 1 },
          currentEpoch: { id: TEST_EPOCH_ID, epochNumber: 1 },
          memberCount: 100,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAddMemberBody()),
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('MEMBER_LIMIT_REACHED');
    });

    it('returns 201 and creates member when admin adds', async () => {
      const { app } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          targetUser: {
            id: TEST_TARGET_USER_ID,
            publicKey: TEST_TARGET_PUBLIC_KEY,
            username: TEST_TARGET_USERNAME,
          },

          conversation: { id: TEST_CONVERSATION_ID, currentEpoch: 1 },
          currentEpoch: { id: TEST_EPOCH_ID, epochNumber: 1 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAddMemberBody()),
      });

      expect(res.status).toBe(201);
    });

    it('returns 201 and creates member when owner adds', async () => {
      const { app } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'owner' },
          targetUser: {
            id: TEST_TARGET_USER_ID,
            publicKey: TEST_TARGET_PUBLIC_KEY,
            username: TEST_TARGET_USERNAME,
          },

          conversation: { id: TEST_CONVERSATION_ID, currentEpoch: 1 },
          currentEpoch: { id: TEST_EPOCH_ID, epochNumber: 1 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAddMemberBody()),
      });

      expect(res.status).toBe(201);
    });

    it('includes member info in response', async () => {
      const { app } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          targetUser: {
            id: TEST_TARGET_USER_ID,
            publicKey: TEST_TARGET_PUBLIC_KEY,
            username: TEST_TARGET_USERNAME,
          },

          conversation: { id: TEST_CONVERSATION_ID, currentEpoch: 1 },
          currentEpoch: { id: TEST_EPOCH_ID, epochNumber: 1 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAddMemberBody({ privilege: 'write', giveFullHistory: true })),
      });

      expect(res.status).toBe(201);
      const body = await res.json<{
        member: {
          id: string;
          userId: string;
          username: string;
          privilege: string;
          visibleFromEpoch: number;
          joinedAt: string;
        };
      }>();
      expect(body.member).toBeDefined();
      expect(body.member.id).toBe('new-member-id');
      expect(body.member.userId).toBe(TEST_TARGET_USER_ID);
      expect(body.member.username).toBe(TEST_TARGET_USERNAME);
      expect(body.member.privilege).toBe('write');
      expect(body.member.visibleFromEpoch).toBe(1);
      expect(typeof body.member.joinedAt).toBe('string');
    });

    it('inserts member with acceptedAt null and invitedByUserId set', async () => {
      const { app, capturedMemberInsertValues } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          targetUser: {
            id: TEST_TARGET_USER_ID,
            publicKey: TEST_TARGET_PUBLIC_KEY,
            username: TEST_TARGET_USERNAME,
          },
          conversation: { id: TEST_CONVERSATION_ID, currentEpoch: 1 },
          currentEpoch: { id: TEST_EPOCH_ID, epochNumber: 1 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAddMemberBody()),
      });

      expect(res.status).toBe(201);
      expect(capturedMemberInsertValues).toHaveLength(1);
      const insertedValues = capturedMemberInsertValues[0] as Record<string, unknown>;
      expect(insertedValues['acceptedAt']).toBeNull();
      expect(insertedValues['invitedByUserId']).toBe(TEST_USER_ID);
    });

    it('returns 400 when giveFullHistory=false without rotation', async () => {
      const { app } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: TEST_TARGET_USER_ID,
          privilege: 'write',
          giveFullHistory: false,
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when giveFullHistory=true without wrap', async () => {
      const { app } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: TEST_TARGET_USER_ID,
          privilege: 'write',
          giveFullHistory: true,
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 201 when adding member without history with rotation', async () => {
      mockSubmitRotation.mockResolvedValue({ newEpochNumber: 2, newEpochId: 'epoch-new-001' });

      const { app } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          targetUser: {
            id: TEST_TARGET_USER_ID,
            publicKey: TEST_TARGET_PUBLIC_KEY,
            username: TEST_TARGET_USERNAME,
          },
          conversation: { id: TEST_CONVERSATION_ID, currentEpoch: 1 },
          currentEpoch: { id: TEST_EPOCH_ID, epochNumber: 1 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: TEST_TARGET_USER_ID,
          privilege: 'write',
          giveFullHistory: false,
          rotation: createTestRotation(),
        }),
      });

      expect(res.status).toBe(201);
      expect(mockSubmitRotation).toHaveBeenCalledTimes(1);
    });

    it('sets visibleFromEpoch to expectedEpoch+1 when adding without history', async () => {
      mockSubmitRotation.mockResolvedValue({ newEpochNumber: 4, newEpochId: 'epoch-new-004' });

      const { app, capturedMemberInsertValues } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          targetUser: {
            id: TEST_TARGET_USER_ID,
            publicKey: TEST_TARGET_PUBLIC_KEY,
            username: TEST_TARGET_USERNAME,
          },
          conversation: { id: TEST_CONVERSATION_ID, currentEpoch: 3 },
          currentEpoch: { id: TEST_EPOCH_ID, epochNumber: 3 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: TEST_TARGET_USER_ID,
          privilege: 'write',
          giveFullHistory: false,
          rotation: createTestRotation({ expectedEpoch: 3 }),
        }),
      });

      expect(res.status).toBe(201);
      const insertedValues = capturedMemberInsertValues[0] as Record<string, unknown>;
      expect(insertedValues['visibleFromEpoch']).toBe(4);
    });

    it('returns 409 when submitRotation throws StaleEpochError', async () => {
      mockSubmitRotation.mockRejectedValue(new StaleEpochError(1));

      const { app } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          targetUser: {
            id: TEST_TARGET_USER_ID,
            publicKey: TEST_TARGET_PUBLIC_KEY,
            username: TEST_TARGET_USERNAME,
          },
          conversation: { id: TEST_CONVERSATION_ID, currentEpoch: 1 },
          currentEpoch: { id: TEST_EPOCH_ID, epochNumber: 1 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: TEST_TARGET_USER_ID,
          privilege: 'write',
          giveFullHistory: false,
          rotation: createTestRotation(),
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json<{
        code: string;
        details: { currentEpoch: number };
      }>();
      expect(body.code).toBe('STALE_EPOCH');
      expect(body.details.currentEpoch).toBe(1);
    });

    it('returns 400 when submitRotation throws WrapSetMismatchError on add', async () => {
      mockSubmitRotation.mockRejectedValue(new WrapSetMismatchError(2, 3));

      const { app } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          targetUser: {
            id: TEST_TARGET_USER_ID,
            publicKey: TEST_TARGET_PUBLIC_KEY,
            username: TEST_TARGET_USERNAME,
          },
          conversation: { id: TEST_CONVERSATION_ID, currentEpoch: 1 },
          currentEpoch: { id: TEST_EPOCH_ID, epochNumber: 1 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: TEST_TARGET_USER_ID,
          privilege: 'write',
          giveFullHistory: false,
          rotation: createTestRotation(),
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('WRAP_SET_MISMATCH');
    });

    it('broadcasts rotation:complete when adding without history', async () => {
      mockSubmitRotation.mockResolvedValue({ newEpochNumber: 2, newEpochId: 'epoch-new-001' });
      mockBroadcastToRoom.mockClear();

      const { app } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          targetUser: {
            id: TEST_TARGET_USER_ID,
            publicKey: TEST_TARGET_PUBLIC_KEY,
            username: TEST_TARGET_USERNAME,
          },
          conversation: { id: TEST_CONVERSATION_ID, currentEpoch: 1 },
          currentEpoch: { id: TEST_EPOCH_ID, epochNumber: 1 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: TEST_TARGET_USER_ID,
          privilege: 'write',
          giveFullHistory: false,
          rotation: createTestRotation(),
        }),
      });

      expect(res.status).toBe(201);
      expect(mockBroadcastToRoom).toHaveBeenCalledWith(
        expect.anything(),
        TEST_CONVERSATION_ID,
        expect.objectContaining({
          type: 'rotation:complete',
          conversationId: TEST_CONVERSATION_ID,
          newEpochNumber: 2,
        })
      );
    });

    it('does not broadcast rotation:complete when adding with full history', async () => {
      mockBroadcastToRoom.mockClear();

      const { app } = createAddTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          targetUser: {
            id: TEST_TARGET_USER_ID,
            publicKey: TEST_TARGET_PUBLIC_KEY,
            username: TEST_TARGET_USERNAME,
          },
          conversation: { id: TEST_CONVERSATION_ID, currentEpoch: 1 },
          currentEpoch: { id: TEST_EPOCH_ID, epochNumber: 1 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAddMemberBody({ privilege: 'write', giveFullHistory: true })),
      });

      expect(res.status).toBe(201);

      // broadcastToRoom is called for member:added but NOT for rotation:complete
      const rotationCalls = mockBroadcastToRoom.mock.calls.filter(
        (call: unknown[]) =>
          call[2] &&
          typeof call[2] === 'object' &&
          'type' in call[2] &&
          call[2].type === 'rotation:complete'
      );
      expect(rotationCalls).toHaveLength(0);
    });
  });

  describe('POST /:conversationId/remove', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it('returns 401 when not authenticated', async () => {
      const app = createRemoveTestApp({ user: null });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRemoveMemberBody()),
      });

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 when requester is not a member', async () => {
      const app = createRemoveTestApp({
        dbConfig: {
          requesterMember: null,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRemoveMemberBody()),
      });

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_FOUND');
    });

    it('returns 404 when target member not found', async () => {
      const app = createRemoveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin', userId: TEST_USER_ID },
          targetMember: null,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRemoveMemberBody()),
      });

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('MEMBER_NOT_FOUND');
    });

    it('returns 400 when trying to remove self', async () => {
      const app = createRemoveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin', userId: TEST_USER_ID },
          targetMember: {
            id: 'member-1',
            privilege: 'admin',
            userId: TEST_USER_ID,
            conversationId: TEST_CONVERSATION_ID,
          },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRemoveMemberBody({ memberId: 'member-1' })),
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('CANNOT_REMOVE_SELF');
    });

    it('returns 403 when trying to remove owner', async () => {
      const app = createRemoveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin', userId: TEST_USER_ID },
          targetMember: {
            id: TEST_REMOVE_TARGET_MEMBER_ID,
            privilege: 'owner',
            userId: 'user-owner-999',
            conversationId: TEST_CONVERSATION_ID,
          },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRemoveMemberBody()),
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('CANNOT_REMOVE_OWNER');
    });

    it('returns 403 when write-privilege user tries to remove', async () => {
      const app = createRemoveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'write', userId: TEST_USER_ID },
          targetMember: {
            id: TEST_REMOVE_TARGET_MEMBER_ID,
            privilege: 'read',
            userId: 'user-target-555',
            conversationId: TEST_CONVERSATION_ID,
          },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRemoveMemberBody()),
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('PRIVILEGE_INSUFFICIENT');
    });

    it('returns 403 when admin tries to remove another admin', async () => {
      const app = createRemoveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin', userId: TEST_USER_ID },
          targetMember: {
            id: TEST_REMOVE_TARGET_MEMBER_ID,
            privilege: 'admin',
            userId: 'user-other-admin-666',
            conversationId: TEST_CONVERSATION_ID,
          },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRemoveMemberBody()),
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('PRIVILEGE_INSUFFICIENT');
    });

    it('returns 200 when admin removes write member', async () => {
      const app = createRemoveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin', userId: TEST_USER_ID },
          targetMember: {
            id: TEST_REMOVE_TARGET_MEMBER_ID,
            privilege: 'write',
            userId: 'user-write-777',
            conversationId: TEST_CONVERSATION_ID,
          },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRemoveMemberBody()),
      });

      expect(res.status).toBe(200);
    });

    it('returns 200 when owner removes admin member', async () => {
      const app = createRemoveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'owner', userId: TEST_USER_ID },
          targetMember: {
            id: TEST_REMOVE_TARGET_MEMBER_ID,
            privilege: 'admin',
            userId: 'user-admin-888',
            conversationId: TEST_CONVERSATION_ID,
          },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRemoveMemberBody()),
      });

      expect(res.status).toBe(200);
    });

    it('returns removed:true in response body', async () => {
      const app = createRemoveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'owner', userId: TEST_USER_ID },
          targetMember: {
            id: TEST_REMOVE_TARGET_MEMBER_ID,
            privilege: 'write',
            userId: 'user-write-999',
            conversationId: TEST_CONVERSATION_ID,
          },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRemoveMemberBody()),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ removed: boolean }>();
      expect(body.removed).toBe(true);
    });

    it('calls submitRotation during remove', async () => {
      const app = createRemoveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'owner', userId: TEST_USER_ID },
          targetMember: {
            id: TEST_REMOVE_TARGET_MEMBER_ID,
            privilege: 'write',
            userId: 'user-write-rotation',
            conversationId: TEST_CONVERSATION_ID,
          },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRemoveMemberBody()),
      });

      expect(res.status).toBe(200);
      expect(mockSubmitRotation).toHaveBeenCalledTimes(1);
    });

    it('returns 409 when submitRotation throws StaleEpochError on remove', async () => {
      mockSubmitRotation.mockRejectedValue(new StaleEpochError(3));

      const app = createRemoveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'owner', userId: TEST_USER_ID },
          targetMember: {
            id: TEST_REMOVE_TARGET_MEMBER_ID,
            privilege: 'write',
            userId: 'user-write-stale',
            conversationId: TEST_CONVERSATION_ID,
          },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRemoveMemberBody()),
      });

      expect(res.status).toBe(409);
      const body = await res.json<{
        code: string;
        details: { currentEpoch: number };
      }>();
      expect(body.code).toBe('STALE_EPOCH');
      expect(body.details.currentEpoch).toBe(3);
    });

    it('returns 400 when submitRotation throws WrapSetMismatchError on remove', async () => {
      mockSubmitRotation.mockRejectedValue(new WrapSetMismatchError(1, 2));

      const app = createRemoveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'owner', userId: TEST_USER_ID },
          targetMember: {
            id: TEST_REMOVE_TARGET_MEMBER_ID,
            privilege: 'write',
            userId: 'user-write-wrap-mismatch',
            conversationId: TEST_CONVERSATION_ID,
          },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRemoveMemberBody()),
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('WRAP_SET_MISMATCH');
    });

    it('broadcasts rotation:complete event after successful remove', async () => {
      mockBroadcastToRoom.mockClear();

      const app = createRemoveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'owner', userId: TEST_USER_ID },
          targetMember: {
            id: TEST_REMOVE_TARGET_MEMBER_ID,
            privilege: 'write',
            userId: 'user-write-broadcast',
            conversationId: TEST_CONVERSATION_ID,
          },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRemoveMemberBody()),
      });

      expect(res.status).toBe(200);
      expect(mockBroadcastToRoom).toHaveBeenCalledWith(
        expect.anything(),
        TEST_CONVERSATION_ID,
        expect.objectContaining({
          type: 'rotation:complete',
          conversationId: TEST_CONVERSATION_ID,
          newEpochNumber: 2,
        })
      );
    });
  });

  describe('PATCH /:conversationId/privilege', () => {
    it('returns 401 when not authenticated', async () => {
      const app = createPrivilegeTestApp({ user: null });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/privilege`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPrivilegeBody()),
      });

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 when requester is not a member', async () => {
      const app = createPrivilegeTestApp({
        dbConfig: {
          requesterMember: null,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/privilege`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPrivilegeBody()),
      });

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_FOUND');
    });

    it('returns 404 when target member not found', async () => {
      const app = createPrivilegeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'owner', userId: TEST_USER_ID },
          targetMember: null,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/privilege`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPrivilegeBody()),
      });

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('MEMBER_NOT_FOUND');
    });

    it('returns 403 when trying to change own privilege', async () => {
      const app = createPrivilegeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'owner', userId: TEST_USER_ID },
          targetMember: { id: 'member-1', privilege: 'owner', userId: TEST_USER_ID },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/privilege`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPrivilegeBody({ memberId: 'member-1' })),
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('CANNOT_CHANGE_OWN_PRIVILEGE');
    });

    it('returns 403 when write user tries to change privilege', async () => {
      const app = createPrivilegeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'write', userId: TEST_USER_ID },
          targetMember: { id: TEST_TARGET_MEMBER_ID, privilege: 'read', userId: 'user-other-123' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/privilege`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPrivilegeBody()),
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('PRIVILEGE_INSUFFICIENT');
    });

    it('returns 403 when admin tries to promote to admin', async () => {
      const app = createPrivilegeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin', userId: TEST_USER_ID },
          targetMember: { id: TEST_TARGET_MEMBER_ID, privilege: 'write', userId: 'user-other-123' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/privilege`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPrivilegeBody({ privilege: 'admin' })),
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('PRIVILEGE_INSUFFICIENT');
    });

    it('returns 403 when admin tries to change another admin', async () => {
      const app = createPrivilegeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin', userId: TEST_USER_ID },
          targetMember: { id: TEST_TARGET_MEMBER_ID, privilege: 'admin', userId: 'user-other-123' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/privilege`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPrivilegeBody({ privilege: 'read' })),
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('PRIVILEGE_INSUFFICIENT');
    });

    it('returns 200 when owner changes admin to write', async () => {
      const app = createPrivilegeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'owner', userId: TEST_USER_ID },
          targetMember: { id: TEST_TARGET_MEMBER_ID, privilege: 'admin', userId: 'user-other-123' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/privilege`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPrivilegeBody({ privilege: 'write' })),
      });

      expect(res.status).toBe(200);
    });

    it('returns 200 when admin changes write to read', async () => {
      const app = createPrivilegeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin', userId: TEST_USER_ID },
          targetMember: { id: TEST_TARGET_MEMBER_ID, privilege: 'write', userId: 'user-other-123' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/privilege`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPrivilegeBody({ privilege: 'read' })),
      });

      expect(res.status).toBe(200);
    });

    it('returns updated privilege in response', async () => {
      const app = createPrivilegeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'owner', userId: TEST_USER_ID },
          targetMember: { id: TEST_TARGET_MEMBER_ID, privilege: 'admin', userId: 'user-other-123' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/privilege`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPrivilegeBody({ privilege: 'write' })),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{
        updated: boolean;
        memberId: string;
        privilege: string;
      }>();
      expect(body.updated).toBe(true);
      expect(body.memberId).toBe(TEST_TARGET_MEMBER_ID);
      expect(body.privilege).toBe('write');
    });
  });

  describe('POST /:conversationId/leave', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it('returns 401 when not authenticated', async () => {
      const app = createLeaveTestApp({ user: null });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 when not a member', async () => {
      const app = createLeaveTestApp({
        dbConfig: {
          requesterMember: null,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_FOUND');
    });

    it('owner leaving deletes conversation and returns deleted:true', async () => {
      const app = createLeaveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-owner-1', privilege: 'owner', userId: TEST_USER_ID },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ deleted: boolean }>();
      expect(body.deleted).toBe(true);
    });

    it('returns 400 when rotation missing for non-owner leave', async () => {
      const app = createLeaveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-write-1', privilege: 'write', userId: TEST_USER_ID },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('ROTATION_REQUIRED');
    });

    it('non-owner leaving with rotation calls submitRotation and returns left:true', async () => {
      const app = createLeaveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-write-1', privilege: 'write', userId: TEST_USER_ID },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotation: createTestRotation() }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ left: boolean }>();
      expect(body.left).toBe(true);
      expect(mockSubmitRotation).toHaveBeenCalledTimes(1);
    });

    it('admin leaving with rotation triggers submitRotation', async () => {
      const app = createLeaveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-admin-1', privilege: 'admin', userId: TEST_USER_ID },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotation: createTestRotation() }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ left: boolean }>();
      expect(body.left).toBe(true);
      expect(mockSubmitRotation).toHaveBeenCalledTimes(1);
    });

    it('read-only member can leave with rotation', async () => {
      const app = createLeaveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-read-1', privilege: 'read', userId: TEST_USER_ID },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotation: createTestRotation() }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ left: boolean }>();
      expect(body.left).toBe(true);
    });

    it('returns 409 when submitRotation throws StaleEpochError on leave', async () => {
      mockSubmitRotation.mockRejectedValue(new StaleEpochError(5));

      const app = createLeaveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-write-1', privilege: 'write', userId: TEST_USER_ID },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotation: createTestRotation() }),
      });

      expect(res.status).toBe(409);
      const body = await res.json<{
        code: string;
        details: { currentEpoch: number };
      }>();
      expect(body.code).toBe('STALE_EPOCH');
      expect(body.details.currentEpoch).toBe(5);
    });

    it('broadcasts rotation:complete when non-owner leaves with rotation', async () => {
      mockBroadcastToRoom.mockClear();

      const app = createLeaveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-write-1', privilege: 'write', userId: TEST_USER_ID },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotation: createTestRotation() }),
      });

      expect(res.status).toBe(200);
      expect(mockBroadcastToRoom).toHaveBeenCalledWith(
        expect.anything(),
        TEST_CONVERSATION_ID,
        expect.objectContaining({
          type: 'rotation:complete',
          conversationId: TEST_CONVERSATION_ID,
          newEpochNumber: 2,
        })
      );
    });

    it('does not broadcast rotation:complete when owner leaves', async () => {
      mockBroadcastToRoom.mockClear();

      const app = createLeaveTestApp({
        dbConfig: {
          requesterMember: { id: 'member-owner-1', privilege: 'owner', userId: TEST_USER_ID },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);

      const rotationCalls = mockBroadcastToRoom.mock.calls.filter(
        (call: unknown[]) =>
          call[2] &&
          typeof call[2] === 'object' &&
          'type' in call[2] &&
          call[2].type === 'rotation:complete'
      );
      expect(rotationCalls).toHaveLength(0);
    });
  });

  // ── Accept mock infrastructure ──

  interface AcceptMockDbConfig {
    requesterMember?: { id: string; privilege: string; userId: string } | null;
  }

  /**
   * Creates a mock Drizzle DB for the accept route:
   * 0. Middleware: requester membership lookup (select→from→where→limit→then)
   * 1. Accept: update chain returning rows affected
   */
  function createAcceptMockDb(config: AcceptMockDbConfig): unknown {
    const indexRef = { value: 0 };
    const selectResults: unknown[][] = [
      // Query 0: middleware's membership lookup
      config.requesterMember
        ? [
            {
              id: config.requesterMember.id,
              privilege: config.requesterMember.privilege,
              visibleFromEpoch: 1,
            },
          ]
        : [],
    ];
    const createQueryChain = createQueryChainFactory(selectResults, indexRef);

    return {
      select: () => createQueryChain(),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () =>
              Promise.resolve(
                config.requesterMember
                  ? [{ id: config.requesterMember.id, acceptedAt: new Date() }]
                  : []
              ),
          }),
        }),
      }),
    };
  }

  interface AcceptTestAppOptions {
    user?: AppEnv['Variables']['user'] | null;
    dbConfig?: AcceptMockDbConfig;
  }

  function createAcceptTestApp(options: AcceptTestAppOptions = {}): Hono<AppEnv> {
    const { user = createMockUser(), dbConfig = {} } = options;
    const app = new Hono<AppEnv>();

    app.use('*', async (c, next) => {
      c.env = {
        NODE_ENV: 'test',
      } as unknown as AppEnv['Bindings'];
      c.set('user', user);
      c.set('session', user ? createMockSession() : null);
      c.set('sessionData', user ? createMockSession() : null);
      c.set('db', createAcceptMockDb(dbConfig) as AppEnv['Variables']['db']);
      await next();
    });

    app.route('/', membersRoute);
    return app;
  }

  describe('PATCH /:conversationId/accept', () => {
    it('returns 401 when not authenticated', async () => {
      const app = createAcceptTestApp({ user: null });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/accept`, {
        method: 'PATCH',
      });

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 when not a member', async () => {
      const app = createAcceptTestApp({
        dbConfig: {
          requesterMember: null,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/accept`, {
        method: 'PATCH',
      });

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_FOUND');
    });

    it('accepts membership and returns accepted:true', async () => {
      const app = createAcceptTestApp({
        dbConfig: {
          requesterMember: { id: 'member-write-1', privilege: 'write', userId: TEST_USER_ID },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/accept`, {
        method: 'PATCH',
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ accepted: boolean }>();
      expect(body.accepted).toBe(true);
    });

    it('idempotent — already accepted returns 200', async () => {
      const app = createAcceptTestApp({
        dbConfig: {
          requesterMember: { id: 'member-admin-1', privilege: 'admin', userId: TEST_USER_ID },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/accept`, {
        method: 'PATCH',
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ accepted: boolean }>();
      expect(body.accepted).toBe(true);
    });
  });
});
