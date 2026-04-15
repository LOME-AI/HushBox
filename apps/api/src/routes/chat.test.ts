import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Hono } from 'hono';
import {
  conversations as conversationsTable,
  conversationMembers as conversationMembersTable,
  memberBudgets as memberBudgetsTable,
  conversationSpending as conversationSpendingTable,
  messages as messagesTable,
  users as usersTable,
  wallets as walletsTable,
  epochs as epochsTable,
  usageRecords as usageRecordsTable,
  llmCompletions as llmCompletionsTable,
  ledgerEntries as ledgerEntriesTable,
} from '@hushbox/db';
// Mock @ai-sdk/gateway to bypass real network calls. fetchModels uses
// createGateway().getAvailableModels() — we mock both to return our mockModels
// reshaped for the gateway response format.
vi.mock('@ai-sdk/gateway', () => {
  // Return a mock createGateway whose getAvailableModels returns our mockModels
  // mapped to GatewayModelEntry shape. The test's fetchMock for the deprecated
  // OpenRouter URLs is no longer needed for fetchModels, but kept for any
  // other code paths that still call fetch().
  return {
    createGateway: () => ({
      getAvailableModels: () =>
        Promise.resolve({
          models: (globalThis as { __TEST_MOCK_MODELS__?: unknown[] }).__TEST_MOCK_MODELS__ ?? [],
        }),
    }),
  };
});

import { chatRoute } from './chat.js';
import type { AppEnv } from '../types.js';
import { createMockAIClient } from '../services/ai/mock.js';
import {
  ERROR_CODE_BALANCE_RESERVED,
  ERROR_CODE_BILLING_MISMATCH,
  ERROR_CODE_PRIVILEGE_INSUFFICIENT,
} from '@hushbox/shared';
import { clearModelCache } from '@hushbox/shared/models';
import { generateKeyPair } from '@hushbox/crypto';

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// Generate a valid X25519 key pair so epoch encryption in saveChatTurn works.
const testEpochKeyPair = generateKeyPair();

const TEST_CONVERSATION_ID = '11111111-1111-1111-8111-111111111111';
const TEST_USER_ID = 'user-123';
const TEST_USER_MESSAGE_ID = '22222222-2222-2222-8222-222222222222';

interface MockConversation {
  id: string;
  userId: string;
  title: string;
  currentEpoch: number;
  nextSequence: number;
  conversationBudget?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface MockWallet {
  id: string;
  userId: string;
  type: string;
  balance: string;
}

interface MockUser {
  id: string;
  balance: string;
}

interface ErrorBody {
  code: string;
  details?: Record<string, unknown>;
}

interface MockFetchResponse {
  ok: boolean;
  statusText?: string;
  json: () => Promise<unknown>;
}

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<MockFetchResponse>>;

/** Build a valid stream request body with all required fields. */
function streamBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    models: ['openai/gpt-5'],
    userMessage: {
      id: TEST_USER_MESSAGE_ID,
      content: 'Hello',
    },
    messagesForInference: [{ role: 'user', content: 'Hello' }],
    fundingSource: 'personal_balance',
    ...overrides,
  });
}

const mockModels = [
  {
    id: 'openai/gpt-5',
    name: 'GPT-5',
    description: 'Premium model',
    context_length: 128_000,
    pricing: { prompt: '0.00001', completion: '0.00003' },
    supported_parameters: ['temperature'],
    created: Math.floor(Date.now() / 1000),
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
];

/**
 * Create a mock database for testing.
 * Supports the epoch-based saveChatTurn transaction pattern.
 */
interface MockConversationMember {
  id: string;
  userId: string;
  conversationId: string;
  privilege: string;
  visibleFromEpoch: number;
}

interface MockMemberBudget {
  budget: string;
  spent: string;
}

interface MockConversationSpending {
  totalSpent: string;
}

// eslint-disable-next-line complexity -- test helper with inherent setup branching (auto-wallets, optional insert handler, Map closures)
function createMockDb(options: {
  conversations?: MockConversation[];
  users?: MockUser[];
  wallets?: MockWallet[];
  onInsert?: (table: unknown, values: unknown) => void;
  conversationMemberRows?: MockConversationMember[];
  memberBudgetRows?: MockMemberBudget[];
  conversationSpendingRows?: MockConversationSpending[];
}) {
  const { conversations = [], users = [], onInsert } = options;
  const conversationMemberRows = options.conversationMemberRows ?? [
    {
      id: 'member-owner',
      userId: conversations[0]?.userId ?? 'unknown',
      conversationId: conversations[0]?.id ?? 'unknown',
      privilege: 'owner',
      visibleFromEpoch: 1,
    },
  ];
  const memberBudgetRows = options.memberBudgetRows ?? [];
  const conversationSpendingRows = options.conversationSpendingRows ?? [];

  // Auto-generate wallets from users if not explicitly provided
  const wallets: MockWallet[] =
    options.wallets ??
    users.map((u) => ({
      id: `wallet-${u.id}`,
      userId: u.id,
      type: 'purchased',
      balance: u.balance,
    }));

  // Track conversation sequence for saveChatTurn updates
  let nextSequence = conversations[0]?.nextSequence ?? 0;
  const currentEpoch = conversations[0]?.currentEpoch ?? 1;

  // Counter-based multi-user support: cycles through users array per query.
  // getUserTierInfo queries wallets (not users) to compute balance,
  // so wallets needs its own independent cycling counter.
  let usersQueryCount = 0;
  let lastQueriedUserIndex = 0;
  let walletsQueryCount = 0;

  /* eslint-disable unicorn/no-thenable -- test mock for Drizzle query builder which uses .then() */
  function createThenable<T>(value: T) {
    return {
      then: (resolve: (v: T) => unknown) => Promise.resolve(resolve(value)),
      limit: (n: number) => ({
        then: (resolve: (v: T) => unknown) => {
          const sliced = Array.isArray(value) ? (value.slice(0, n) as T) : value;
          return Promise.resolve(resolve(sliced));
        },
      }),
      orderBy: () => createThenable(value),
    };
  }
  /* eslint-enable unicorn/no-thenable */

  // Build db operations object with nested transaction support.
  // chargeForUsage calls db.transaction() on the passed-in tx,
  // so the mock ops object itself must support .transaction().
  interface MockDbOps {
    select: () => {
      from: (table: unknown) => {
        where: () => unknown;
        leftJoin: () => { where: () => unknown };
        innerJoin: () => { where: () => unknown };
      };
    };
    insert: (table: unknown) => {
      values: (values: unknown) => { returning: () => Promise<unknown[]> };
    };
    update: (table: unknown) => {
      set: (setValues: Record<string, unknown>) => { where: () => unknown };
    };
    delete: (table: unknown) => { where: () => Promise<void> };
    transaction: <T>(callback: (tx: MockDbOps) => Promise<T>) => Promise<T>;
  }

  // Map-based dispatch: resolve a where() call based on the table being queried.
  // Shared between direct `.from(table).where()` and `.from(table).leftJoin().where()` paths.
  const tableResolvers = new Map<unknown, () => ReturnType<typeof createThenable>>([
    [conversationsTable, () => createThenable(conversations)],
    [
      usersTable,
      () => {
        lastQueriedUserIndex = usersQueryCount % users.length;
        usersQueryCount++;
        const user = users[lastQueriedUserIndex];
        return createThenable(
          user
            ? [{ balance: user.balance, freeAllowanceCents: 0, freeAllowanceResetAt: new Date() }]
            : []
        );
      },
    ],
    [
      walletsTable,
      () => {
        const walletUserIndex = walletsQueryCount % users.length;
        walletsQueryCount++;
        const userForWallets = users[walletUserIndex];
        return createThenable(
          userForWallets ? wallets.filter((w) => w.userId === userForWallets.id) : wallets
        );
      },
    ],
    [epochsTable, () => createThenable([{ epochPublicKey: testEpochKeyPair.publicKey }])],
    [ledgerEntriesTable, () => createThenable([{ maxCreatedAt: null }])],
    [conversationMembersTable, () => createThenable(conversationMemberRows)],
    [memberBudgetsTable, () => createThenable(memberBudgetRows)],
    [conversationSpendingTable, () => createThenable(conversationSpendingRows)],
  ]);

  function resolveWhere(table: unknown) {
    return tableResolvers.get(table)?.() ?? createThenable([]);
  }

  const dbOps: MockDbOps = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => resolveWhere(table),
        // leftJoin support: getConversationBudgets joins conversationMembers with memberBudgets
        leftJoin: () => ({
          where: () => {
            // Join conversationMemberRows with memberBudgetRows (1:1 by index)
            const joined = conversationMemberRows.map((cm, index) => {
              const mb = memberBudgetRows[index];
              return {
                memberId: cm.id,
                userId: cm.userId,
                linkId: null,
                privilege: cm.privilege,
                budget: mb?.budget ?? null,
                spent: mb?.spent ?? null,
              };
            });
            return createThenable(joined);
          },
        }),
        // innerJoin support: submitRotation joins conversationMembers with users/sharedLinks
        innerJoin: () => ({
          where: () => resolveWhere(table),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        if (onInsert) {
          onInsert(table, values);
        }
        const returningFunction = () => {
          if (table === messagesTable) {
            return Promise.resolve([values]);
          }
          if (table === usageRecordsTable) {
            return Promise.resolve([{ id: 'usage-record-123' }]);
          }
          if (table === llmCompletionsTable) {
            return Promise.resolve([{ id: 'llm-completion-123' }]);
          }
          if (table === ledgerEntriesTable) {
            return Promise.resolve([{ id: 'ledger-entry-123' }]);
          }
          return Promise.resolve([values]);
        };
        return {
          returning: returningFunction,
          // updateGroupSpending uses insert().values().onConflictDoUpdate()
          onConflictDoUpdate: () => Promise.resolve(),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (setValues: Record<string, unknown>) => ({
        where: () => {
          if (table === conversationsTable && setValues['nextSequence']) {
            // saveChatTurn (increments by 2) / saveUserOnlyMessage (increments by 1)
            const seq = nextSequence;
            const userSeq = nextSequence;
            const aiSeq = nextSequence + 1;
            nextSequence += 2;
            /* eslint-disable unicorn/no-thenable -- mock Drizzle query result */
            return {
              returning: () => Promise.resolve([{ seq, userSeq, aiSeq, currentEpoch }]),
              then: (resolve: (v?: unknown) => unknown) => Promise.resolve(resolve()),
            };
            /* eslint-enable unicorn/no-thenable */
          }
          if (table === walletsTable) {
            // chargeForUsage: deduct from wallet
            const wallet = wallets[0];
            /* eslint-disable unicorn/no-thenable -- mock Drizzle query result */
            return {
              returning: () =>
                Promise.resolve(
                  wallet ? [{ id: wallet.id, type: wallet.type, balance: '9.99000000' }] : []
                ),
              then: (resolve: (v?: unknown) => unknown) => Promise.resolve(resolve()),
            };
            /* eslint-enable unicorn/no-thenable */
          }
          /* eslint-disable unicorn/no-thenable -- mock Drizzle query result */
          return {
            returning: () => Promise.resolve([{}]),
            then: (resolve: (v?: unknown) => unknown) => Promise.resolve(resolve()),
          };
          /* eslint-enable unicorn/no-thenable */
        },
      }),
    }),
    // delete support: submitRotation deletes old epochMembers
    delete: () => ({
      where: () => Promise.resolve(),
    }),
    // Nested transaction support: reuses same ops (mimics Drizzle savepoint behavior)
    transaction: async <T>(callback: (tx: MockDbOps) => Promise<T>): Promise<T> => {
      return callback(dbOps);
    },
  };

  return dbOps;
}

function createMockRedis(evalReturnValue = '0') {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(evalReturnValue),
    scan: vi.fn().mockResolvedValue([0, []]),
  };
}

function createTestApp(
  dbOptions?: Parameters<typeof createMockDb>[0],
  redisOverride?: ReturnType<typeof createMockRedis>,
  _unused?: unknown,
  aiClientOverride?: AppEnv['Variables']['aiClient']
) {
  const app = new Hono<AppEnv>();
  const mockUser = {
    id: TEST_USER_ID,
    email: 'test@example.com',
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: false,
    publicKey: new Uint8Array(32),
  };
  const mockSession = {
    sessionId: 'session-123',
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

  const defaultDbOptions = {
    conversations: [
      {
        id: TEST_CONVERSATION_ID,
        userId: TEST_USER_ID,
        title: 'Test Conversation',
        currentEpoch: 1,
        nextSequence: 1,
        conversationBudget: '100.00',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    users: [
      {
        id: TEST_USER_ID,
        balance: '10.00000000',
      },
    ],
  };

  const mockRedis = redisOverride ?? createMockRedis();

  // Mock dependencies middleware
  app.use('*', async (c, next) => {
    // Set env bindings for tests
    c.env = { NODE_ENV: 'test', AI_GATEWAY_API_KEY: 'test-key' } as AppEnv['Bindings'];
    c.set('user', mockUser);
    c.set('session', mockSession);
    c.set('aiClient', aiClientOverride ?? createMockAIClient());
    c.set(
      'db',
      createMockDb(dbOptions ?? defaultDbOptions) as unknown as AppEnv['Variables']['db']
    );
    c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
    await next();
  });

  app.route('/', chatRoute);
  return app;
}

function createUnauthenticatedTestApp() {
  const app = new Hono<AppEnv>();

  // Mock dependencies middleware without user
  app.use('*', async (c, next) => {
    // Set env bindings for tests
    c.env = { NODE_ENV: 'test', AI_GATEWAY_API_KEY: 'test-key' } as AppEnv['Bindings'];
    c.set('user', null);
    c.set('session', null);
    c.set('aiClient', createMockAIClient());
    c.set('db', createMockDb({}) as unknown as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', chatRoute);
  return app;
}

describe('chat routes', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    clearModelCache();
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));

    // Inject mockModels into the @ai-sdk/gateway mock (in gateway response shape)
    (globalThis as { __TEST_MOCK_MODELS__?: unknown[] }).__TEST_MOCK_MODELS__ = mockModels.map(
      (m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        modelType: 'language',
        pricing: { input: m.pricing.prompt, output: m.pricing.completion },
      })
    );

    // Default mock for any remaining fetch() calls (legacy paths)
    fetchMock.mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete (globalThis as { __TEST_MOCK_MODELS__?: unknown[] }).__TEST_MOCK_MODELS__;
  });

  describe('POST /stream', () => {
    it('returns 401 for unauthenticated requests', async () => {
      const app = createUnauthenticatedTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(401);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 400 when required body fields are missing', async () => {
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: ['openai/gpt-5'] }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when models is missing', async () => {
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('streams SSE response for valid request', async () => {
      vi.useRealTimers();
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(res.headers.get('cache-control')).toBe('no-cache');
    });

    it('returns start event with assistantMessageId', async () => {
      vi.useRealTimers();
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      const text = await res.text();
      expect(text).toContain('event: start');
      expect(text).toContain('"assistantMessageId"');
    });

    it('returns token events with content', async () => {
      vi.useRealTimers();
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      const text = await res.text();
      expect(text).toContain('event: token');
      expect(text).toContain('"content"');
    });

    it('returns done event with epoch metadata', async () => {
      vi.useRealTimers();
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      const text = await res.text();
      expect(text).toContain('event: done');
      expect(text).toContain('"userSequence"');
      expect(text).toContain('"aiSequence"');
      expect(text).toContain('"epochNumber"');
      expect(text).toContain('"cost"');
      expect(text).toContain('"userMessageId"');
      expect(text).toContain('"assistantMessageId"');
    });

    it('returns error event when stream fails', async () => {
      vi.useRealTimers();

      const app = new Hono<AppEnv>();
      const failingAi = createMockAIClient();
      failingAi.addFailingModel('openai/gpt-5');

      const mockDb = createMockDb({
        conversations: [
          {
            id: TEST_CONVERSATION_ID,
            userId: TEST_USER_ID,
            title: 'Test',
            currentEpoch: 1,
            nextSequence: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        users: [
          {
            id: TEST_USER_ID,
            balance: '10.00000000',
          },
        ],
      });

      app.use('*', async (c, next) => {
        c.env = { NODE_ENV: 'test', AI_GATEWAY_API_KEY: 'test-key' } as AppEnv['Bindings'];
        c.set('user', {
          id: TEST_USER_ID,
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          publicKey: new Uint8Array(32),
        });
        c.set('session', {
          sessionId: 'session-123',
          userId: TEST_USER_ID,
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          pending2FA: false,
          pending2FAExpiresAt: 0,
          createdAt: Date.now(),
        });
        c.set('aiClient', failingAi);
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
        await next();
      });
      app.route('/', chatRoute);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      const text = await res.text();
      expect(text).toContain('event: error');
      expect(text).toContain('unavailable');
    });

    it('returns 404 when conversation not found', async () => {
      const app = createTestApp({ conversations: [] });
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(404);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 404 when conversation belongs to another user', async () => {
      const app = createTestApp({
        conversations: [
          {
            id: TEST_CONVERSATION_ID,
            userId: 'other-user',
            title: 'Test',
            currentEpoch: 1,
            nextSequence: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        conversationMemberRows: [],
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(404);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 402 when user has zero balance', async () => {
      const app = createTestApp({
        conversations: [
          {
            id: TEST_CONVERSATION_ID,
            userId: TEST_USER_ID,
            title: 'Test',
            currentEpoch: 1,
            nextSequence: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        users: [
          {
            id: TEST_USER_ID,
            balance: '0.00000000',
          },
        ],
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(402);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('PREMIUM_REQUIRES_BALANCE');
      expect(body.details?.['currentBalance']).toBe('0.00');
    });

    it('returns 402 when user has negative balance', async () => {
      const app = createTestApp({
        conversations: [
          {
            id: TEST_CONVERSATION_ID,
            userId: TEST_USER_ID,
            title: 'Test',
            currentEpoch: 1,
            nextSequence: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        users: [
          {
            id: TEST_USER_ID,
            balance: '-5.00000000',
          },
        ],
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(402);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('PREMIUM_REQUIRES_BALANCE');
      expect(body.details?.['currentBalance']).toBe('-5.00');
    });

    it('returns 400 when last message is not from user', async () => {
      const app = createTestApp();

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({
          messagesForInference: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
          ],
        }),
      });

      expect(res.status).toBe(400);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('LAST_MESSAGE_NOT_USER');
    });

    it('returns 400 when messagesForInference is empty', async () => {
      const app = createTestApp();

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({ messagesForInference: [] }),
      });

      // Zod schema requires at least 1 message (.min(1))
      expect(res.status).toBe(400);
    });

    it('saves messages via saveChatTurn after stream completes', async () => {
      vi.useRealTimers();

      const insertedMessages: unknown[] = [];

      const app = createTestApp({
        conversations: [
          {
            id: TEST_CONVERSATION_ID,
            userId: TEST_USER_ID,
            title: 'Test',
            currentEpoch: 1,
            nextSequence: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        users: [
          {
            id: TEST_USER_ID,
            balance: '10.00000000',
          },
        ],
        onInsert: (table, values) => {
          if (table === messagesTable) {
            insertedMessages.push(values);
          }
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      // Consume the stream to trigger the insert
      await res.text();

      // saveChatTurn inserts user + assistant messages
      expect(insertedMessages.length).toBe(2);

      const userMsg = insertedMessages[0] as Record<string, unknown>;
      expect(userMsg).toMatchObject({
        conversationId: TEST_CONVERSATION_ID,
        senderType: 'user',
        epochNumber: 1,
      });

      const aiMsg = insertedMessages[1] as Record<string, unknown>;
      expect(aiMsg).toMatchObject({
        conversationId: TEST_CONVERSATION_ID,
        senderType: 'ai',
      });
    });

    it('includes userMessageId in start event', async () => {
      vi.useRealTimers();
      const knownId = '44444444-4444-4444-8444-444444444444';
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({
          userMessage: { id: knownId, content: 'Test message' },
        }),
      });

      const text = await res.text();
      expect(text).toContain('event: start');
      expect(text).toContain(`"userMessageId":"${knownId}"`);
    });

    describe('cost calculation routing', () => {
      it('uses inline cost from stream for billing', async () => {
        vi.useRealTimers();

        const app = new Hono<AppEnv>();

        const mockDb = createMockDb({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        });

        app.use('*', async (c, next) => {
          c.env = { NODE_ENV: 'test', AI_GATEWAY_API_KEY: 'test-key' } as AppEnv['Bindings'];
          c.set('user', {
            id: TEST_USER_ID,
            email: 'test@example.com',
            username: 'test_user',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: false,

            publicKey: new Uint8Array(32),
          });
          c.set('session', {
            sessionId: 'session-123',
            userId: TEST_USER_ID,
            email: 'test@example.com',
            username: 'test_user',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: false,
            pending2FA: false,
            pending2FAExpiresAt: 0,
            createdAt: Date.now(),
          });
          c.set('aiClient', createMockAIClient());
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
          await next();
        });
        app.route('/', chatRoute);

        // No NODE_ENV set (defaults to development/test behavior)
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        const body = await res.text();

        // Stream completes with inline cost — no separate API call needed
        expect(res.status).toBe(200);
        expect(body).toContain('event: done');
      });
    });

    describe('client disconnect handling', () => {
      it('saves complete message when SSE write fails mid-stream', async () => {
        vi.useRealTimers();

        const insertedMessages: unknown[] = [];

        const app = new Hono<AppEnv>();

        const mockDb = createMockDb({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
          onInsert: (table, values) => {
            if (table === messagesTable) {
              insertedMessages.push(values);
            }
          },
        });

        app.use('*', async (c, next) => {
          c.env = { NODE_ENV: 'test', AI_GATEWAY_API_KEY: 'test-key' } as AppEnv['Bindings'];
          c.set('user', {
            id: TEST_USER_ID,
            email: 'test@example.com',
            username: 'test_user',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: false,

            publicKey: new Uint8Array(32),
          });
          c.set('session', {
            sessionId: 'session-123',
            userId: TEST_USER_ID,
            email: 'test@example.com',
            username: 'test_user',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: false,
            pending2FA: false,
            pending2FAExpiresAt: 0,
            createdAt: Date.now(),
          });
          c.set('aiClient', createMockAIClient());
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
          await next();
        });
        app.route('/', chatRoute);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        await res.text().catch(() => {
          // Intentionally ignore - we only care about verifying the message was inserted
        });

        // saveChatTurn inserts both user and assistant messages
        expect(insertedMessages.length).toBe(2);

        const aiMsg = insertedMessages[1] as Record<string, unknown>;
        expect(aiMsg).toMatchObject({
          conversationId: TEST_CONVERSATION_ID,
          senderType: 'ai',
        });
      });

      it('triggers billing even when client disconnects', async () => {
        vi.useRealTimers();

        const insertedMessages: unknown[] = [];
        let usageRecordInserted = false;

        const app = new Hono<AppEnv>();

        const mockDb = createMockDb({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
          onInsert: (table, values) => {
            if (table === messagesTable) {
              insertedMessages.push(values);
            }
            if (table === usageRecordsTable) {
              usageRecordInserted = true;
            }
          },
        });

        app.use('*', async (c, next) => {
          c.env = { NODE_ENV: 'test', AI_GATEWAY_API_KEY: 'test-key' } as AppEnv['Bindings'];
          c.set('user', {
            id: TEST_USER_ID,
            email: 'test@example.com',
            username: 'test_user',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: false,

            publicKey: new Uint8Array(32),
          });
          c.set('session', {
            sessionId: 'session-123',
            userId: TEST_USER_ID,
            email: 'test@example.com',
            username: 'test_user',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: false,
            pending2FA: false,
            pending2FAExpiresAt: 0,
            createdAt: Date.now(),
          });
          c.set('aiClient', createMockAIClient());
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
          await next();
        });
        app.route('/', chatRoute);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        await res.text();

        // Give billing time to fire (it's async/fire-and-forget)
        await new Promise((resolve) => setTimeout(resolve, 50));

        // saveChatTurn inserts both messages
        expect(insertedMessages.length).toBe(2);
        // chargeForUsage inserts usage record inside the transaction
        expect(usageRecordInserted).toBe(true);
      });
    });

    describe('concurrent requests', () => {
      it('handles multiple simultaneous stream requests independently', async () => {
        vi.useRealTimers();

        const app = createTestApp();

        // Start two concurrent stream requests
        const [res1, res2] = await Promise.all([
          app.request(`/${TEST_CONVERSATION_ID}/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: streamBody(),
          }),
          app.request(`/${TEST_CONVERSATION_ID}/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: streamBody(),
          }),
        ]);

        // Both should succeed (200 status)
        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);

        // Both should return SSE content
        const [text1, text2] = await Promise.all([res1.text(), res2.text()]);

        expect(text1).toContain('event: start');
        expect(text1).toContain('event: done');
        expect(text2).toContain('event: start');
        expect(text2).toContain('event: done');
      });
    });

    describe('speculative balance reservation', () => {
      it('creates reservation via Redis eval on successful validation', async () => {
        vi.useRealTimers();

        const mockRedis = createMockRedis('5');
        const app = createTestApp(undefined, mockRedis);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        await res.text();

        expect(mockRedis.eval).toHaveBeenCalled();
      });

      it('returns 402 with balance reserved error when reservations exceed balance', async () => {
        const mockRedis = createMockRedis();
        mockRedis.get.mockResolvedValue(null);
        // First eval (reserve) returns a value > balance, triggering final check failure
        // Balance is $10 (1000 cents). We simulate reservation returning a huge total.
        mockRedis.eval.mockResolvedValueOnce('99999');

        const app = createTestApp(undefined, mockRedis);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(402);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe(ERROR_CODE_BALANCE_RESERVED);
      });

      it('allows request within 50-cent negative balance cushion', async () => {
        vi.useRealTimers();

        const mockRedis = createMockRedis();
        mockRedis.get.mockResolvedValue(null);
        // Balance is $10 (1000 cents). Reservation returns 1040 total.
        // finalEffective = 1000 - 1040 = -40 cents, which is > -50 cents cushion.
        mockRedis.eval.mockResolvedValueOnce('1040');

        const app = createTestApp(undefined, mockRedis);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: done');
      });

      it('allows free tier user with free_allowance funding through race guard', async () => {
        vi.useRealTimers();

        // Override fetchMock: two models so the cheap one falls below the 75th-percentile premium threshold
        const cheapModel = {
          id: 'openai/gpt-4o-mini',
          name: 'GPT-3.5 Turbo',
          description: 'Basic model',
          context_length: 16_000,
          pricing: { prompt: '0.0000005', completion: '0.0000015' },
          supported_parameters: ['temperature'],
          created: Math.floor(Date.now() / 1000) - 2 * 365 * 24 * 60 * 60,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        };
        const expensiveModel = {
          ...mockModels[0],
          created: Math.floor(Date.now() / 1000) - 2 * 365 * 24 * 60 * 60,
        };
        const allModels = [cheapModel, expensiveModel];
        fetchMock.mockImplementation((url: string) => {
          const zdrEndpoints = allModels.map((m) => ({
            model_id: m.id,
            model_name: m.name,
            provider_name: 'Provider',
            context_length: m.context_length,
            pricing: m.pricing,
          }));
          if (url.includes('/endpoints/zdr')) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ data: zdrEndpoints }),
            });
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: allModels }),
          });
        });

        const mockRedis = createMockRedis('5');
        // Free tier: balance $0, free_tier wallet with $0.05 allowance
        const app = createTestApp(
          {
            conversations: [
              {
                id: TEST_CONVERSATION_ID,
                userId: TEST_USER_ID,
                title: 'Test Conversation',
                currentEpoch: 1,
                nextSequence: 1,
                conversationBudget: '100.00',
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ],
            users: [{ id: TEST_USER_ID, balance: '0.00000000' }],
            wallets: [
              {
                id: 'wallet-free',
                userId: TEST_USER_ID,
                type: 'free_tier',
                balance: '0.05000000',
              },
            ],
          },
          mockRedis
        );

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ models: ['openai/gpt-4o-mini'], fundingSource: 'free_allowance' }),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: done');
      });

      it('releases reservation after successful stream', async () => {
        vi.useRealTimers();

        const mockRedis = createMockRedis('5');
        const app = createTestApp(undefined, mockRedis);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        await res.text();

        // eval called at least twice: once for reserve, once for release
        expect(mockRedis.eval.mock.calls.length).toBeGreaterThanOrEqual(2);
        // Last eval call should be release (negative increment)
        const lastCall = mockRedis.eval.mock.calls.at(-1) as [string, string[], string[]];
        const increment = Number(lastCall[2][0]);
        expect(increment).toBeLessThan(0);
      });

      it('releases reservation on stream error', async () => {
        vi.useRealTimers();

        const mockRedis = createMockRedis('5');

        const app = new Hono<AppEnv>();

        const mockDb = createMockDb({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        });

        app.use('*', async (c, next) => {
          c.env = { NODE_ENV: 'test', AI_GATEWAY_API_KEY: 'test-key' } as AppEnv['Bindings'];
          c.set('user', {
            id: TEST_USER_ID,
            email: 'test@example.com',
            username: 'test_user',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: false,

            publicKey: new Uint8Array(32),
          });
          c.set('session', {
            sessionId: 'session-123',
            userId: TEST_USER_ID,
            email: 'test@example.com',
            username: 'test_user',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: false,
            pending2FA: false,
            pending2FAExpiresAt: 0,
            createdAt: Date.now(),
          });
          c.set('aiClient', createMockAIClient());
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
          await next();
        });
        app.route('/', chatRoute);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        await res.text();

        // eval should be called for reserve + release
        expect(mockRedis.eval.mock.calls.length).toBeGreaterThanOrEqual(2);
        const lastCall = mockRedis.eval.mock.calls.at(-1) as [string, string[], string[]];
        const increment = Number(lastCall[2][0]);
        expect(increment).toBeLessThan(0);
      });

      it('releases reservation on empty content', async () => {
        vi.useRealTimers();

        const mockRedis = createMockRedis('5');

        const app = new Hono<AppEnv>();

        const mockDb = createMockDb({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        });

        app.use('*', async (c, next) => {
          c.env = { NODE_ENV: 'test', AI_GATEWAY_API_KEY: 'test-key' } as AppEnv['Bindings'];
          c.set('user', {
            id: TEST_USER_ID,
            email: 'test@example.com',
            username: 'test_user',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: false,

            publicKey: new Uint8Array(32),
          });
          c.set('session', {
            sessionId: 'session-123',
            userId: TEST_USER_ID,
            email: 'test@example.com',
            username: 'test_user',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: false,
            pending2FA: false,
            pending2FAExpiresAt: 0,
            createdAt: Date.now(),
          });
          c.set('aiClient', createMockAIClient());
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
          await next();
        });
        app.route('/', chatRoute);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        await res.text();

        // eval should be called for reserve + release
        expect(mockRedis.eval.mock.calls.length).toBeGreaterThanOrEqual(2);
        const lastCall = mockRedis.eval.mock.calls.at(-1) as [string, string[], string[]];
        const increment = Number(lastCall[2][0]);
        expect(increment).toBeLessThan(0);
      });

      it('proceeds normally when no existing reservations (Redis returns 0)', async () => {
        vi.useRealTimers();

        const mockRedis = createMockRedis('0.01');
        const app = createTestApp(undefined, mockRedis);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: done');
      });
    });

    describe('broadcast integration', () => {
      /** Create a Hono app with a mock CONVERSATION_ROOM DO namespace for broadcast testing. */
      function createBroadcastApp(options: {
        conversations: MockConversation[];
        users: MockUser[];
      }): {
        app: ReturnType<typeof createTestApp>;
        mockStub: { fetch: Mock };
        broadcastBodies: unknown[];
      } {
        const broadcastBodies: unknown[] = [];
        const doId = { toString: () => 'mock-do-id' };
        const mockStub = {
          fetch: vi.fn().mockImplementation(async (req: Request) => {
            const body: unknown = await req.json();
            broadcastBodies.push(body);
            return Response.json({ sent: 1 }, { headers: { 'Content-Type': 'application/json' } });
          }),
        };
        const mockNamespace = {
          idFromName: vi.fn().mockReturnValue(doId),
          get: vi.fn().mockReturnValue(mockStub),
        };

        const app = new Hono<AppEnv>();
        const mockDb = createMockDb({
          ...options,
        });

        app.use('*', async (c, next) => {
          c.env = {
            NODE_ENV: 'test',
            AI_GATEWAY_API_KEY: 'test-key',
            CONVERSATION_ROOM: mockNamespace,
          } as unknown as AppEnv['Bindings'];
          c.set('user', {
            id: TEST_USER_ID,
            email: 'test@example.com',
            username: 'test_user',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: false,
            publicKey: new Uint8Array(32),
          });
          c.set('session', {
            sessionId: 'session-123',
            userId: TEST_USER_ID,
            email: 'test@example.com',
            username: 'test_user',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: false,
            pending2FA: false,
            pending2FAExpiresAt: 0,
            createdAt: Date.now(),
          });
          c.set('aiClient', createMockAIClient());
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
          await next();
        });
        app.route('/', chatRoute);

        return { app, mockStub, broadcastBodies };
      }

      it('broadcasts message:new, message:stream, and message:complete events', async () => {
        vi.useRealTimers();
        const { app, mockStub, broadcastBodies } = createBroadcastApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        });
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });
        await res.text();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(mockStub.fetch).toHaveBeenCalledTimes(3);
        const eventTypes = broadcastBodies.map((b) => (b as Record<string, unknown>)['type']);
        expect(eventTypes).toContain('message:new');
        expect(eventTypes).toContain('message:stream');
        expect(eventTypes).toContain('message:complete');
      });

      it('sends early message:new broadcast with content', async () => {
        vi.useRealTimers();
        const { app, broadcastBodies } = createBroadcastApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        });
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });
        await res.text();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const messageNew = broadcastBodies.find(
          (b) => (b as Record<string, unknown>)['type'] === 'message:new'
        ) as Record<string, unknown>;
        expect(messageNew).toBeDefined();
        expect(messageNew['senderType']).toBe('user');
        expect(messageNew['senderId']).toBe(TEST_USER_ID);
        expect(messageNew['content']).toBe('Hello');
        expect(messageNew['conversationId']).toBe(TEST_CONVERSATION_ID);
      });

      it('broadcastAndFinish only sends message:complete (no duplicate message:new)', async () => {
        vi.useRealTimers();
        const { app, broadcastBodies } = createBroadcastApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        });
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });
        await res.text();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const messageNewEvents = broadcastBodies.filter(
          (b) => (b as Record<string, unknown>)['type'] === 'message:new'
        );
        expect(messageNewEvents).toHaveLength(1);
        const messageCompleteEvents = broadcastBodies.filter(
          (b) => (b as Record<string, unknown>)['type'] === 'message:complete'
        );
        expect(messageCompleteEvents).toHaveLength(1);
      });

      it('flushes remaining token buffer as message:stream after stream ends', async () => {
        vi.useRealTimers();
        const { app, broadcastBodies } = createBroadcastApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        });
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });
        await res.text();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const streamEvents = broadcastBodies.filter(
          (b) => (b as Record<string, unknown>)['type'] === 'message:stream'
        );
        expect(streamEvents.length).toBeGreaterThanOrEqual(1);
        const allTokens = streamEvents
          .map((e) => (e as Record<string, unknown>)['token'] as string)
          .join('');
        expect(allTokens).toBe('Echo: Hello');
      });

      it('does not broadcast message:stream when no DO binding is present', async () => {
        vi.useRealTimers();
        const app = createTestApp();
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });
        const text = await res.text();
        expect(text).toContain('event: done');
      });

      it('broadcasts token content during streaming via Durable Object', async () => {
        vi.useRealTimers();
        const broadcastBodies: unknown[] = [];
        const doId = { toString: () => 'mock-do-id' };
        const mockStub = {
          fetch: vi.fn().mockImplementation(async (req: Request) => {
            const body: unknown = await req.json();
            broadcastBodies.push(body);
            return Response.json({ sent: 1 }, { headers: { 'Content-Type': 'application/json' } });
          }),
        };
        const mockNamespace = {
          idFromName: vi.fn().mockReturnValue(doId),
          get: vi.fn().mockReturnValue(mockStub),
        };
        const app = new Hono<AppEnv>();
        const mockDb = createMockDb({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        });
        app.use('*', async (c, next) => {
          c.env = {
            NODE_ENV: 'test',
            AI_GATEWAY_API_KEY: 'test-key',
            CONVERSATION_ROOM: mockNamespace,
          } as unknown as AppEnv['Bindings'];
          c.set('user', {
            id: TEST_USER_ID,
            email: 'test@example.com',
            username: 'test_user',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: false,
            publicKey: new Uint8Array(32),
          });
          c.set('session', {
            sessionId: 'session-123',
            userId: TEST_USER_ID,
            email: 'test@example.com',
            username: 'test_user',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: false,
            pending2FA: false,
            pending2FAExpiresAt: 0,
            createdAt: Date.now(),
          });
          c.set('aiClient', createMockAIClient());
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
          await next();
        });
        app.route('/', chatRoute);
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });
        await res.text();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const streamEvents = broadcastBodies.filter(
          (b) => (b as Record<string, unknown>)['type'] === 'message:stream'
        );
        // Mock AIClient streams instantly → all tokens batched into one flush on completion
        expect(streamEvents.length).toBeGreaterThanOrEqual(1);
        const allTokens = streamEvents
          .map((e) => (e as Record<string, unknown>)['token'] as string)
          .join('');
        // Mock echoes "Echo: <last user content>" — last user message is "Hello"
        expect(allTokens).toContain('Echo');
      });
    });

    describe('group budget validation', () => {
      const TEST_OWNER_ID = 'owner-user-999';
      const TEST_MEMBER_CM_ID = 'cm-member-1';

      it('allows conversation member to send message using group budget', async () => {
        vi.useRealTimers();

        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_OWNER_ID, // Owner is different from auth user
              title: 'Group Chat',
              currentEpoch: 1,
              nextSequence: 0,
              conversationBudget: '100.00',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            // Member first (buildBillingInput queries member wallet first)
            { id: TEST_USER_ID, balance: '0.00000000' },
            // Owner second (group path queries owner wallet second)
            { id: TEST_OWNER_ID, balance: '10.00000000' },
          ],
          conversationMemberRows: [
            {
              id: TEST_MEMBER_CM_ID,
              userId: TEST_USER_ID,
              conversationId: TEST_CONVERSATION_ID,
              privilege: 'write',
              visibleFromEpoch: 1,
            },
          ],
          memberBudgetRows: [{ budget: '50.00', spent: '0.00000000' }],
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ fundingSource: 'owner_balance' }),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: done');
      });

      it('returns 404 when user is neither owner nor member', async () => {
        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_OWNER_ID,
              title: 'Group Chat',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_OWNER_ID, balance: '10.00000000' }],
          conversationMemberRows: [], // No member record for test user
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(404);
      });

      it('falls back to personal balance when group budget is exhausted', async () => {
        vi.useRealTimers();

        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_OWNER_ID,
              title: 'Group Chat',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            // Member first (buildBillingInput queries member wallet first)
            { id: TEST_USER_ID, balance: '10.00000000' },
            // Owner second — no balance (group budget exhausted)
            { id: TEST_OWNER_ID, balance: '0.00000000' },
          ],
          conversationMemberRows: [
            {
              id: TEST_MEMBER_CM_ID,
              userId: TEST_USER_ID,
              conversationId: TEST_CONVERSATION_ID,
              privilege: 'write',
              visibleFromEpoch: 1,
            },
          ],
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: done');
      });

      it('returns 402 when both group and personal budgets are insufficient', async () => {
        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_OWNER_ID,
              title: 'Group Chat',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            { id: TEST_OWNER_ID, balance: '0.00000000' },
            { id: TEST_USER_ID, balance: '0.00000000' },
          ],
          conversationMemberRows: [
            {
              id: TEST_MEMBER_CM_ID,
              userId: TEST_USER_ID,
              conversationId: TEST_CONVERSATION_ID,
              privilege: 'write',
              visibleFromEpoch: 1,
            },
          ],
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(402);
      });

      it('releases group budget reservation after successful stream', async () => {
        vi.useRealTimers();

        const mockRedis = createMockRedis('5');
        const app = createTestApp(
          {
            conversations: [
              {
                id: TEST_CONVERSATION_ID,
                userId: TEST_OWNER_ID,
                title: 'Group Chat',
                currentEpoch: 1,
                nextSequence: 0,
                conversationBudget: '100.00',
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ],
            users: [
              // Member first (buildBillingInput queries member wallet first)
              { id: TEST_USER_ID, balance: '0.00000000' },
              // Owner second (group path queries owner wallet second)
              { id: TEST_OWNER_ID, balance: '10.00000000' },
            ],
            conversationMemberRows: [
              {
                id: TEST_MEMBER_CM_ID,
                userId: TEST_USER_ID,
                conversationId: TEST_CONVERSATION_ID,
                privilege: 'write',
                visibleFromEpoch: 1,
              },
            ],
            memberBudgetRows: [{ budget: '50.00', spent: '0.00000000' }],
          },
          mockRedis
        );

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ fundingSource: 'owner_balance' }),
        });

        await res.text();

        // Redis eval should be called for reservation and release
        expect(mockRedis.eval.mock.calls.length).toBeGreaterThanOrEqual(2);
        // Last eval call should be release (negative increment)
        const lastCall = mockRedis.eval.mock.calls.at(-1) as [string, string[], string[]];
        const increment = Number(lastCall[2][0]);
        expect(increment).toBeLessThan(0);
      });
    });

    describe('group budget post-reservation race guard', () => {
      const TEST_OWNER_ID = 'owner-user-999';
      const TEST_MEMBER_CM_ID = 'cm-member-1';

      it('returns 402 and releases reservation when group budget exceeded after reservation', async () => {
        // Owner has $10 balance, conversation budget $100, member budget $50.
        // reserveGroupBudget uses redis.eval (redisIncrByFloat), while
        // getGroupReservedTotals/getReservedTotal use redis.get (redisGet).
        // Return huge totals from eval to simulate concurrent race condition.
        const mockRedis = createMockRedis();
        mockRedis.get.mockResolvedValue(null);
        // eval calls are ONLY from redisIncrByFloat (reserve + release):
        mockRedis.eval
          .mockResolvedValueOnce('50000') // reserveGroupBudget: member total (huge)
          .mockResolvedValueOnce('50000') // reserveGroupBudget: conversation total (huge)
          .mockResolvedValueOnce('50000') // reserveGroupBudget: payer total (exceeds $10 = 1000 cents)
          .mockResolvedValueOnce('0') // releaseGroupBudget: member release
          .mockResolvedValueOnce('0') // releaseGroupBudget: conversation release
          .mockResolvedValueOnce('0'); // releaseGroupBudget: payer release

        const app = createTestApp(
          {
            conversations: [
              {
                id: TEST_CONVERSATION_ID,
                userId: TEST_OWNER_ID,
                title: 'Group Chat',
                currentEpoch: 1,
                nextSequence: 0,
                conversationBudget: '100.00',
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ],
            users: [
              // Member first (buildBillingInput queries member wallet first)
              { id: TEST_USER_ID, balance: '0.00000000' },
              // Owner second (group path queries owner wallet second)
              { id: TEST_OWNER_ID, balance: '10.00000000' },
            ],
            conversationMemberRows: [
              {
                id: TEST_MEMBER_CM_ID,
                userId: TEST_USER_ID,
                conversationId: TEST_CONVERSATION_ID,
                privilege: 'write',
                visibleFromEpoch: 1,
              },
            ],
            memberBudgetRows: [{ budget: '50.00', spent: '0.00000000' }],
          },
          mockRedis
        );

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ fundingSource: 'owner_balance' }),
        });

        expect(res.status).toBe(402);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe(ERROR_CODE_BALANCE_RESERVED);
      });
    });

    describe('read-only member privilege check', () => {
      const TEST_OWNER_ID = 'owner-user-999';
      const TEST_MEMBER_CM_ID = 'cm-member-1';

      it('returns 403 when member has read-only privilege', async () => {
        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_OWNER_ID,
              title: 'Group Chat',
              currentEpoch: 1,
              nextSequence: 0,
              conversationBudget: '100.00',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            { id: TEST_OWNER_ID, balance: '10.00000000' },
            { id: TEST_USER_ID, balance: '5.00000000' },
          ],
          conversationMemberRows: [
            {
              id: TEST_MEMBER_CM_ID,
              userId: TEST_USER_ID,
              conversationId: TEST_CONVERSATION_ID,
              privilege: 'read',
              visibleFromEpoch: 1,
            },
          ],
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(403);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe(ERROR_CODE_PRIVILEGE_INSUFFICIENT);
      });

      it('allows member with admin privilege to send messages', async () => {
        vi.useRealTimers();

        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_OWNER_ID,
              title: 'Group Chat',
              currentEpoch: 1,
              nextSequence: 0,
              conversationBudget: '100.00',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            { id: TEST_OWNER_ID, balance: '10.00000000' },
            { id: TEST_USER_ID, balance: '5.00000000' },
          ],
          conversationMemberRows: [
            {
              id: TEST_MEMBER_CM_ID,
              userId: TEST_USER_ID,
              conversationId: TEST_CONVERSATION_ID,
              privilege: 'admin',
              visibleFromEpoch: 1,
            },
          ],
          memberBudgetRows: [{ budget: '50.00', spent: '0.00000000' }],
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ fundingSource: 'owner_balance' }),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: done');
      });
    });

    describe('billing mismatch detection', () => {
      it('returns 409 when client fundingSource disagrees with server decision', async () => {
        // Server will resolve personal_balance (paid user with balance)
        // Client claims free_allowance — mismatch!
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ fundingSource: 'free_allowance' }),
        });

        expect(res.status).toBe(409);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe(ERROR_CODE_BILLING_MISMATCH);
        expect(body.details?.['serverFundingSource']).toBe('personal_balance');
      });

      it('proceeds normally when client fundingSource matches server decision', async () => {
        vi.useRealTimers();
        // Server will resolve personal_balance (paid user with balance)
        // Client claims personal_balance — match!
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ fundingSource: 'personal_balance' }),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: done');
      });

      it('returns 402 denial even when client claims approved fundingSource', async () => {
        // Server denies (zero balance, premium model) — 402 not 409
        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            {
              id: TEST_USER_ID,
              balance: '0.00000000',
            },
          ],
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ fundingSource: 'personal_balance' }),
        });

        // Backend denial takes priority over mismatch — returns 402 not 409
        expect(res.status).toBe(402);
      });

      it('returns 409 when member claims personal_balance but server resolves owner_balance', async () => {
        const TEST_OWNER_ID = 'owner-user-999';
        const TEST_MEMBER_CM_ID = 'cm-member-1';

        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_OWNER_ID,
              title: 'Group Chat',
              currentEpoch: 1,
              nextSequence: 0,
              conversationBudget: '100.00',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            { id: TEST_OWNER_ID, balance: '10.00000000' },
            { id: TEST_USER_ID, balance: '5.00000000' },
          ],
          conversationMemberRows: [
            {
              id: TEST_MEMBER_CM_ID,
              userId: TEST_USER_ID,
              conversationId: TEST_CONVERSATION_ID,
              privilege: 'write',
              visibleFromEpoch: 1,
            },
          ],
          memberBudgetRows: [{ budget: '50.00', spent: '0.00000000' }],
        });

        // Server resolves owner_balance (group budget available)
        // Client claims personal_balance — mismatch!
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ fundingSource: 'personal_balance' }),
        });

        expect(res.status).toBe(409);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe(ERROR_CODE_BILLING_MISMATCH);
        expect(body.details?.['serverFundingSource']).toBe('owner_balance');
      });
    });

    describe('stream error codes', () => {
      it('sends STREAM_ERROR code when AIClient model fails', async () => {
        vi.useRealTimers();

        const failingAi = createMockAIClient();
        failingAi.addFailingModel('openai/gpt-5');
        const app = createTestApp(undefined, undefined, undefined, failingAi);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(200); // SSE streams always return 200
        const text = await res.text();
        expect(text).toContain('event: error');
        expect(text).toContain('"code":"STREAM_ERROR"');
      });
    });

    // Web search plugin tests removed — OpenRouter plugins replaced by AIClient
    // Web search in the new architecture is handled via gateway tools (Step 3)

    // Web search budget reservation tests removed — per-model web_search pricing
    // was OpenRouter-specific. AI Gateway bundles search cost into totalCost
    // post-hoc and uses MAX_SEARCH_TOOL_CALLS * SEARCH_COST_PER_CALL pre-flight
    // (covered by pricing.test.ts in shared).

    describe('auto-router', () => {
      const AUTO_ROUTER_ID = 'openrouter/auto';
      // Must be within 2-year age window (from real date ~2026-03) but older than
      // 1 year (to avoid premium-by-recency classification for all models).
      const RECENT_CREATED = Math.floor(new Date('2025-01-15T00:00:00Z').getTime() / 1000);

      const autoRouterModels = [
        {
          id: AUTO_ROUTER_ID,
          name: 'Auto Router',
          description: 'Automatically chooses the best model',
          context_length: 2_000_000,
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: ['temperature'],
          created: RECENT_CREATED,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'openai/gpt-5',
          name: 'OpenAI: GPT-4 Turbo',
          description: 'A capable model',
          context_length: 128_000,
          pricing: { prompt: '0.00001', completion: '0.00003' },
          supported_parameters: ['temperature'],
          created: RECENT_CREATED,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'openai/gpt-4o-mini',
          name: 'DeepSeek: DeepSeek R1',
          description: 'A cheap model',
          context_length: 164_000,
          pricing: { prompt: '0.000001', completion: '0.000003' },
          supported_parameters: ['temperature'],
          created: RECENT_CREATED,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
      ];

      function stubAutoRouterModels(fetchMockFunction: FetchMock): void {
        fetchMockFunction.mockImplementation((url: string) => {
          if (url.includes('/endpoints/zdr')) {
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  data: autoRouterModels.map((m) => ({
                    model_id: m.id,
                    model_name: m.name,
                    provider_name: 'Provider',
                    context_length: m.context_length,
                    pricing: m.pricing,
                  })),
                }),
            });
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: autoRouterModels }),
          });
        });
      }

      // auto-router plugin tests removed — OpenRouter plugins replaced by AIClient

      it('denies request when no models are affordable', async () => {
        stubAutoRouterModels(fetchMock);
        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            {
              id: TEST_USER_ID,
              // $0 balance → free tier, $0 free allowance → nothing affordable
              balance: '0.00000000',
            },
          ],
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ models: [AUTO_ROUTER_ID], fundingSource: 'free_allowance' }),
        });

        expect(res.status).toBe(402);
      });

      // auto-router + web search plugin merge test removed — OpenRouter plugins

      it('reserves budget based on worst-case allowed model pricing', async () => {
        vi.useRealTimers();
        stubAutoRouterModels(fetchMock);
        const mockRedis = createMockRedis();
        const app = createTestApp(undefined, mockRedis);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ models: [AUTO_ROUTER_ID] }),
        });

        expect(res.status).toBe(200);
        await res.text();

        // redis.eval is called with (script, [key], [incrementStr, ttlStr])
        const evalCalls = mockRedis.eval.mock.calls;
        expect(evalCalls.length).toBeGreaterThanOrEqual(1);
        const autoRouterReservation = Number(evalCalls[0]?.[2]?.[0]);

        // Compare: send same request with the cheapest model directly
        const mockRedis2 = createMockRedis();
        const app2 = createTestApp(undefined, mockRedis2);

        const res2 = await app2.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ models: ['openai/gpt-4o-mini'] }),
        });

        expect(res2.status).toBe(200);
        await res2.text();

        const evalCalls2 = mockRedis2.eval.mock.calls;
        expect(evalCalls2.length).toBeGreaterThanOrEqual(1);
        const cheapModelReservation = Number(evalCalls2[0]?.[2]?.[0]);

        // Auto-router reserves at worst-case (most expensive allowed model)
        // so the reservation should be higher than the cheapest model
        expect(autoRouterReservation).toBeGreaterThan(cheapModelReservation);
      });
    });

    describe('multi-model streaming', () => {
      const SECOND_MODEL_ID = 'openai/gpt-4o-mini';
      const multiModels = [
        ...mockModels,
        {
          id: SECOND_MODEL_ID,
          name: 'GPT-3.5 Turbo',
          description: 'Basic model',
          context_length: 16_000,
          pricing: { prompt: '0.0000005', completion: '0.0000015' },
          supported_parameters: ['temperature'],
          created: Math.floor(Date.now() / 1000),
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
      ];

      function stubMultiModels(fetchMockFunction: FetchMock): void {
        fetchMockFunction.mockImplementation((url: string) => {
          if (url.includes('/endpoints/zdr')) {
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  data: multiModels.map((m) => ({
                    model_id: m.id,
                    model_name: m.name,
                    provider_name: 'Provider',
                    context_length: m.context_length,
                    pricing: m.pricing,
                  })),
                }),
            });
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: multiModels }),
          });
        });
      }

      it('saves user + N assistant messages for multi-model request', async () => {
        vi.useRealTimers();
        stubMultiModels(fetchMock);

        const insertedMessages: unknown[] = [];
        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
          onInsert: (table, values) => {
            if (table === messagesTable) {
              insertedMessages.push(values);
            }
          },
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ models: ['openai/gpt-5', SECOND_MODEL_ID] }),
        });

        await res.text();

        // 1 user message + 2 assistant messages = 3 total
        expect(insertedMessages.length).toBe(3);

        const userMsg = insertedMessages[0] as Record<string, unknown>;
        expect(userMsg).toMatchObject({
          conversationId: TEST_CONVERSATION_ID,
          senderType: 'user',
        });

        const aiMsgs = insertedMessages.slice(1) as Record<string, unknown>[];
        for (const aiMsg of aiMsgs) {
          expect(aiMsg).toMatchObject({
            conversationId: TEST_CONVERSATION_ID,
            senderType: 'ai',
          });
        }
      });

      it('emits model:done event for each model', async () => {
        vi.useRealTimers();
        stubMultiModels(fetchMock);
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ models: ['openai/gpt-5', SECOND_MODEL_ID] }),
        });

        const text = await res.text();

        // Should have model:done events for each model
        const modelDoneMatches = text.match(/event: model:done/g);
        expect(modelDoneMatches).toHaveLength(2);
        expect(text).toContain('"modelId":"openai/gpt-5"');
        expect(text).toContain(`"modelId":"${SECOND_MODEL_ID}"`);
      });

      it('emits model-tagged token events', async () => {
        vi.useRealTimers();
        stubMultiModels(fetchMock);
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ models: ['openai/gpt-5', SECOND_MODEL_ID] }),
        });

        const text = await res.text();

        // Token events should include modelId
        expect(text).toContain('event: token');
        // Parse token events to verify they have modelId
        const tokenDataMatches = [...text.matchAll(/event: token\ndata: (.+)/g)];
        expect(tokenDataMatches.length).toBeGreaterThanOrEqual(2);
        for (const match of tokenDataMatches) {
          const data = JSON.parse(match[1]!) as Record<string, unknown>;
          expect(data).toHaveProperty('modelId');
        }
      });
    });
  });

  describe('POST /message', () => {
    const TEST_MESSAGE_ID = '33333333-3333-3333-8333-333333333333';

    function messageBody(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        messageId: TEST_MESSAGE_ID,
        content: 'Hello without AI',
        ...overrides,
      });
    }

    it('returns 401 for unauthenticated requests', async () => {
      const app = createUnauthenticatedTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: messageBody(),
      });

      expect(res.status).toBe(401);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 400 when content is missing', async () => {
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: TEST_MESSAGE_ID,
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 404 when conversation does not exist', async () => {
      const app = createTestApp({ conversations: [] });
      const res = await app.request(`/${TEST_CONVERSATION_ID}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: messageBody(),
      });

      expect(res.status).toBe(404);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 200 with sequenceNumber and epochNumber on success', async () => {
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: messageBody(),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<{
        messageId: string;
        sequenceNumber: number;
        epochNumber: number;
      }>(res);
      expect(body.messageId).toBe(TEST_MESSAGE_ID);
      expect(body.sequenceNumber).toBeDefined();
      expect(body.epochNumber).toBe(1);
    });

    it('returns JSON response (not SSE stream)', async () => {
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: messageBody(),
      });

      expect(res.status).toBe(200);
      // Verify it's a JSON response, not an SSE stream
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = await jsonBody<{ messageId: string }>(res);
      expect(body.messageId).toBe(TEST_MESSAGE_ID);
    });

    it('broadcasts message:new without content field in user-only route', async () => {
      vi.useRealTimers();
      const broadcastBodies: unknown[] = [];
      const doId = { toString: () => 'mock-do-id' };
      const mockStub = {
        fetch: vi.fn().mockImplementation(async (req: Request) => {
          const body: unknown = await req.json();
          broadcastBodies.push(body);
          return Response.json({ sent: 1 }, { headers: { 'Content-Type': 'application/json' } });
        }),
      };
      const mockNamespace = {
        idFromName: vi.fn().mockReturnValue(doId),
        get: vi.fn().mockReturnValue(mockStub),
      };
      const app = new Hono<AppEnv>();
      const mockDb = createMockDb({
        conversations: [
          {
            id: TEST_CONVERSATION_ID,
            userId: TEST_USER_ID,
            title: 'Test',
            currentEpoch: 1,
            nextSequence: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
      });
      app.use('*', async (c, next) => {
        c.env = {
          NODE_ENV: 'test',
          AI_GATEWAY_API_KEY: 'test-key',
          CONVERSATION_ROOM: mockNamespace,
        } as unknown as AppEnv['Bindings'];
        c.set('user', {
          id: TEST_USER_ID,
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          publicKey: new Uint8Array(32),
        });
        c.set('session', {
          sessionId: 'session-123',
          userId: TEST_USER_ID,
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          pending2FA: false,
          pending2FAExpiresAt: 0,
          createdAt: Date.now(),
        });
        c.set('aiClient', createMockAIClient());
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
        await next();
      });
      app.route('/', chatRoute);
      const res = await app.request(`/${TEST_CONVERSATION_ID}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: messageBody(),
      });
      expect(res.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const messageNew = broadcastBodies.find(
        (b) => (b as Record<string, unknown>)['type'] === 'message:new'
      ) as Record<string, unknown>;
      expect(messageNew).toBeDefined();
      expect(messageNew['senderType']).toBe('user');
      expect(messageNew['senderId']).toBe(TEST_USER_ID);
      // User-only route should NOT include content (message already in DB)
      expect(messageNew['content']).toBeUndefined();
    });

    it('returns 403 for members with insufficient privilege', async () => {
      const app = createTestApp({
        conversations: [
          {
            id: TEST_CONVERSATION_ID,
            userId: 'other-owner',
            title: 'Test',
            currentEpoch: 1,
            nextSequence: 1,
            conversationBudget: '100.00',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        conversationMemberRows: [
          {
            id: 'member-1',
            userId: TEST_USER_ID,
            conversationId: TEST_CONVERSATION_ID,
            privilege: 'read_only',
            visibleFromEpoch: 1,
          },
        ],
      });
      const res = await app.request(`/${TEST_CONVERSATION_ID}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: messageBody(),
      });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /regenerate', () => {
    const TEST_TARGET_MESSAGE_ID = '55555555-5555-5555-8555-555555555555';

    function regenerateBody(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        targetMessageId: TEST_TARGET_MESSAGE_ID,
        action: 'retry',
        model: 'openai/gpt-5',
        userMessage: {
          id: TEST_USER_MESSAGE_ID,
          content: 'Hello',
        },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        ...overrides,
      });
    }

    it('returns 401 for unauthenticated requests', async () => {
      const app = createUnauthenticatedTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody(),
      });

      expect(res.status).toBe(401);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 400 when required fields are missing', async () => {
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid action', async () => {
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody({ action: 'invalid' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 404 when conversation not found', async () => {
      const app = createTestApp({ conversations: [] });
      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody(),
      });

      expect(res.status).toBe(404);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 400 when messagesForInference ends with assistant role', async () => {
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody({
          messagesForInference: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
          ],
        }),
      });

      expect(res.status).toBe(400);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('LAST_MESSAGE_NOT_USER');
    });

    it('streams SSE response for valid regenerate request', async () => {
      vi.useRealTimers();
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody({
          action: 'regenerate',
          messagesForInference: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
    });

    it('streams SSE response for edit action', async () => {
      vi.useRealTimers();
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody({
          action: 'edit',
          messagesForInference: [{ role: 'user', content: 'Edited message' }],
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
    });

    it('writes SSE error event when persistence fails after successful stream', async () => {
      vi.useRealTimers();

      // DB insert throws during message persistence
      const app = createTestApp({
        conversations: [
          {
            id: TEST_CONVERSATION_ID,
            userId: TEST_USER_ID,
            title: 'Test Conversation',
            currentEpoch: 1,
            nextSequence: 1,
            conversationBudget: '100.00',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        onInsert: (table) => {
          if (table === messagesTable) {
            throw new Error('DB write failed');
          }
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody({
          action: 'retry',
          messagesForInference: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(res.status).toBe(200); // SSE streams always return 200
      const text = await res.text();
      expect(text).toContain('event: error');
      expect(text).toContain('"code":"STREAM_ERROR"');
    });

    it('returns SSE events with start, token, and done sequence', async () => {
      vi.useRealTimers();
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody({
          action: 'retry',
          messagesForInference: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: start');
      expect(text).toContain('event: token');
      expect(text).toContain('event: done');
    });
  });
});
