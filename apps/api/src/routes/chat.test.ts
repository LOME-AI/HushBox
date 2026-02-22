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
import { chatRoute } from './chat.js';
import type { AppEnv } from '../types.js';
import type { OpenRouterClient } from '../services/openrouter/types.js';
import { createFastMockOpenRouterClient } from '../test-helpers/index.js';
import {
  ERROR_CODE_BALANCE_RESERVED,
  ERROR_CODE_BILLING_MISMATCH,
  ERROR_CODE_PRIVILEGE_INSUFFICIENT,
} from '@hushbox/shared';
import { ContextCapacityError } from '../services/openrouter/openrouter.js';
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
    conversationId: TEST_CONVERSATION_ID,
    model: 'openai/gpt-4-turbo',
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
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
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
  const conversationMemberRows = options.conversationMemberRows ?? [];
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
      orderBy: () => Promise.resolve(value),
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
  openrouterOverride?: AppEnv['Variables']['openrouter']
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
    c.env = { NODE_ENV: 'test' } as AppEnv['Bindings'];
    c.set('user', mockUser);
    c.set('session', mockSession);
    c.set('openrouter', openrouterOverride ?? createFastMockOpenRouterClient());
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
    c.env = { NODE_ENV: 'test' } as AppEnv['Bindings'];
    c.set('user', null);
    c.set('session', null);
    c.set('openrouter', createFastMockOpenRouterClient());
    c.set('db', createMockDb({}) as unknown as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', chatRoute);
  return app;
}

describe('chat routes', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));

    // Default mock for fetchModels + fetchZdrModelIds
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/endpoints/zdr')) {
        const zdrEndpoints = mockModels.map((m) => ({
          model_id: m.id,
          model_name: m.name,
          provider_name: 'Provider',
          context_length: m.context_length,
          pricing: m.pricing,
        }));
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: zdrEndpoints }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: mockModels }),
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('POST /stream', () => {
    it('returns 401 for unauthenticated requests', async () => {
      const app = createUnauthenticatedTestApp();
      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(401);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 400 when conversationId is missing', async () => {
      const app = createTestApp();
      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai/gpt-4-turbo' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when model is missing', async () => {
      const app = createTestApp();
      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: TEST_CONVERSATION_ID }),
      });

      expect(res.status).toBe(400);
    });

    it('streams SSE response for valid request', async () => {
      vi.useRealTimers();
      const app = createTestApp();
      const res = await app.request('/stream', {
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
      const res = await app.request('/stream', {
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
      const res = await app.request('/stream', {
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
      const res = await app.request('/stream', {
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
      const failingClient: OpenRouterClient = {
        isMock: true,
        chatCompletion() {
          return Promise.reject(new Error('API Error'));
        },
        // eslint-disable-next-line @typescript-eslint/require-await, require-yield, sonarjs/generator-without-yield -- intentionally throws for error test
        async *chatCompletionStream() {
          throw new Error('Stream failed');
        },
        // eslint-disable-next-line @typescript-eslint/require-await, require-yield, sonarjs/generator-without-yield -- intentionally throws for error test
        async *chatCompletionStreamWithMetadata() {
          throw new Error('Stream failed');
        },
        listModels() {
          return Promise.resolve([]);
        },
        getModel() {
          return Promise.reject(new Error('Model not found'));
        },
        getGenerationStats() {
          return Promise.reject(new Error('Not implemented in mock'));
        },
      };

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
        c.set('openrouter', failingClient);
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
        await next();
      });
      app.route('/', chatRoute);

      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      const text = await res.text();
      expect(text).toContain('event: error');
      expect(text).toContain('Stream failed');
    });

    it('returns 404 when conversation not found', async () => {
      const app = createTestApp({ conversations: [] });
      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({ conversationId: '33333333-3333-3333-8333-333333333333' }),
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
      });

      const res = await app.request('/stream', {
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

      const res = await app.request('/stream', {
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

      const res = await app.request('/stream', {
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

      const res = await app.request('/stream', {
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

      const res = await app.request('/stream', {
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

      const res = await app.request('/stream', {
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
      const res = await app.request('/stream', {
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
      it('uses estimated cost in development/test mode (does NOT call getGenerationStats)', async () => {
        vi.useRealTimers();

        let getGenerationStatsCalled = false;

        const app = new Hono<AppEnv>();

        const openrouter: OpenRouterClient = {
          isMock: true, // Mock client should NOT call getGenerationStats
          chatCompletion() {
            return Promise.resolve({
              id: 'mock-123',
              model: 'openai/gpt-4-turbo',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            });
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStreamWithMetadata() {
            yield { content: 'Hello', generationId: 'mock-gen-123' };
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStream() {
            yield 'Hello';
          },
          listModels() {
            return Promise.resolve([]);
          },
          getModel() {
            return Promise.reject(new Error('Model not found'));
          },
          getGenerationStats(generationId: string) {
            getGenerationStatsCalled = true;
            return Promise.resolve({
              id: generationId,
              native_tokens_prompt: 100,
              native_tokens_completion: 50,
              total_cost: 0.001,
            });
          },
        };

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
          c.set('openrouter', openrouter);
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
          await next();
        });
        app.route('/', chatRoute);

        // No NODE_ENV set (defaults to development/test behavior)
        const res = await app.request('/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        await res.text();

        // In development/test mode, getGenerationStats should NOT be called
        expect(getGenerationStatsCalled).toBe(false);
      });

      it('calls getGenerationStats in production mode', async () => {
        vi.useRealTimers();

        let getGenerationStatsCalled = false;

        const app = new Hono<AppEnv>();

        const openrouter: OpenRouterClient = {
          isMock: false, // Real client SHOULD call getGenerationStats
          chatCompletion() {
            return Promise.resolve({
              id: 'mock-123',
              model: 'openai/gpt-4-turbo',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            });
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStreamWithMetadata() {
            yield { content: 'Hello', generationId: 'mock-gen-123' };
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStream() {
            yield 'Hello';
          },
          listModels() {
            return Promise.resolve([]);
          },
          getModel() {
            return Promise.reject(new Error('Model not found'));
          },
          getGenerationStats(generationId: string) {
            getGenerationStatsCalled = true;
            return Promise.resolve({
              id: generationId,
              native_tokens_prompt: 100,
              native_tokens_completion: 50,
              total_cost: 0.001,
            });
          },
        };

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
          c.set('openrouter', openrouter);
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
          await next();
        });
        app.route('/', chatRoute);

        // Pass NODE_ENV: 'production' to simulate production mode
        const res = await app.request(
          '/stream',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: streamBody(),
          },
          { NODE_ENV: 'production' } as AppEnv['Bindings']
        );

        await res.text();

        // In production mode, getGenerationStats SHOULD be called
        expect(getGenerationStatsCalled).toBe(true);
      });
    });

    describe('client disconnect handling', () => {
      it('saves complete message when SSE write fails mid-stream', async () => {
        vi.useRealTimers();

        const insertedMessages: unknown[] = [];

        const app = new Hono<AppEnv>();

        const openrouter: OpenRouterClient = {
          isMock: true,
          chatCompletion() {
            return Promise.resolve({
              id: 'mock-123',
              model: 'openai/gpt-4-turbo',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Hello' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            });
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStreamWithMetadata() {
            yield { content: 'Hello', generationId: 'mock-gen-123' };
            yield { content: ' ' };
            yield { content: 'World' };
            yield { content: '!' };
            yield { content: ' How' };
            yield { content: ' are' };
            yield { content: ' you' };
            yield { content: '?' };
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStream() {
            yield 'Hello World!';
          },
          listModels() {
            return Promise.resolve([]);
          },
          getModel() {
            return Promise.reject(new Error('Model not found'));
          },
          getGenerationStats(generationId: string) {
            return Promise.resolve({
              id: generationId,
              native_tokens_prompt: 100,
              native_tokens_completion: 50,
              total_cost: 0.001,
            });
          },
        };

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
          c.env = { NODE_ENV: 'test' } as AppEnv['Bindings'];
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
          c.set('openrouter', openrouter);
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
          await next();
        });
        app.route('/', chatRoute);

        const res = await app.request('/stream', {
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

        const openrouter: OpenRouterClient = {
          isMock: true,
          chatCompletion() {
            return Promise.resolve({
              id: 'mock-123',
              model: 'openai/gpt-4-turbo',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            });
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStreamWithMetadata() {
            yield { content: 'Hello', generationId: 'mock-gen-123' };
            yield { content: ' World' };
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStream() {
            yield 'Hello World';
          },
          listModels() {
            return Promise.resolve([]);
          },
          getModel() {
            return Promise.reject(new Error('Model not found'));
          },
          getGenerationStats(generationId: string) {
            return Promise.resolve({
              id: generationId,
              native_tokens_prompt: 100,
              native_tokens_completion: 50,
              total_cost: 0.001,
            });
          },
        };

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
          c.env = { NODE_ENV: 'test' } as AppEnv['Bindings'];
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
          c.set('openrouter', openrouter);
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
          await next();
        });
        app.route('/', chatRoute);

        const res = await app.request('/stream', {
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
          app.request('/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: streamBody(),
          }),
          app.request('/stream', {
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

        const res = await app.request('/stream', {
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

        const res = await app.request('/stream', {
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

        const res = await app.request('/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: done');
      });

      it('releases reservation after successful stream', async () => {
        vi.useRealTimers();

        const mockRedis = createMockRedis('5');
        const app = createTestApp(undefined, mockRedis);

        const res = await app.request('/stream', {
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
        const failingClient: OpenRouterClient = {
          isMock: true,
          chatCompletion: () => Promise.reject(new Error('fail')),
          // eslint-disable-next-line @typescript-eslint/require-await, require-yield, sonarjs/generator-without-yield -- intentionally throws for error test
          async *chatCompletionStream() {
            throw new Error('Stream failed');
          },
          // eslint-disable-next-line @typescript-eslint/require-await, require-yield, sonarjs/generator-without-yield -- intentionally throws for error test
          async *chatCompletionStreamWithMetadata() {
            throw new Error('Stream failed');
          },
          listModels: () => Promise.resolve([]),
          getModel: () => Promise.reject(new Error('not found')),
          getGenerationStats: () => Promise.reject(new Error('not implemented')),
        };

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
          c.env = { NODE_ENV: 'test' } as AppEnv['Bindings'];
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
          c.set('openrouter', failingClient);
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
          await next();
        });
        app.route('/', chatRoute);

        const res = await app.request('/stream', {
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
        const emptyClient: OpenRouterClient = {
          isMock: true,
          chatCompletion: () => Promise.reject(new Error('not used')),

          async *chatCompletionStream() {
            // yields nothing
          },

          async *chatCompletionStreamWithMetadata() {
            // yields nothing
          },
          listModels: () => Promise.resolve([]),
          getModel: () => Promise.reject(new Error('not found')),
          getGenerationStats: () => Promise.reject(new Error('not implemented')),
        };

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
          c.env = { NODE_ENV: 'test' } as AppEnv['Bindings'];
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
          c.set('openrouter', emptyClient);
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
          await next();
        });
        app.route('/', chatRoute);

        const res = await app.request('/stream', {
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

        const res = await app.request('/stream', {
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
          c.set('openrouter', createFastMockOpenRouterClient());
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
        const res = await app.request('/stream', {
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
        const res = await app.request('/stream', {
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
        const res = await app.request('/stream', {
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
        const res = await app.request('/stream', {
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
        const res = await app.request('/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });
        const text = await res.text();
        expect(text).toContain('event: done');
      });

      it('batches tokens at 100ms intervals during streaming', async () => {
        vi.useRealTimers();
        const slowClient: OpenRouterClient = {
          isMock: true,
          chatCompletion() {
            return Promise.resolve({
              id: 'mock-123',
              model: 'openai/gpt-4-turbo',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Hi' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            });
          },
          async *chatCompletionStreamWithMetadata() {
            yield { content: 'A', generationId: 'mock-gen-123' };
            await new Promise((resolve) => setTimeout(resolve, 250));
            yield { content: 'B' };
            await new Promise((resolve) => setTimeout(resolve, 250));
            yield { content: 'C' };
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStream() {
            yield 'ABC';
          },
          listModels() {
            return Promise.resolve([]);
          },
          getModel() {
            return Promise.reject(new Error('Model not found'));
          },
          getGenerationStats(generationId: string) {
            return Promise.resolve({
              id: generationId,
              native_tokens_prompt: 100,
              native_tokens_completion: 50,
              total_cost: 0.001,
            });
          },
        };
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
          c.set('openrouter', slowClient);
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
          await next();
        });
        app.route('/', chatRoute);
        const res = await app.request('/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });
        await res.text();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const streamEvents = broadcastBodies.filter(
          (b) => (b as Record<string, unknown>)['type'] === 'message:stream'
        );
        // With 250ms delays and 100ms batch interval, expect >= 2 stream events
        expect(streamEvents.length).toBeGreaterThanOrEqual(2);
        const allTokens = streamEvents
          .map((e) => (e as Record<string, unknown>)['token'] as string)
          .join('');
        expect(allTokens).toBe('ABC');
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
              privilege: 'write',
              visibleFromEpoch: 1,
            },
          ],
          memberBudgetRows: [{ budget: '50.00', spent: '0.00000000' }],
        });

        const res = await app.request('/stream', {
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

        const res = await app.request('/stream', {
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
              privilege: 'write',
              visibleFromEpoch: 1,
            },
          ],
        });

        const res = await app.request('/stream', {
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
              privilege: 'write',
              visibleFromEpoch: 1,
            },
          ],
        });

        const res = await app.request('/stream', {
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
                privilege: 'write',
                visibleFromEpoch: 1,
              },
            ],
            memberBudgetRows: [{ budget: '50.00', spent: '0.00000000' }],
          },
          mockRedis
        );

        const res = await app.request('/stream', {
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
                privilege: 'write',
                visibleFromEpoch: 1,
              },
            ],
            memberBudgetRows: [{ budget: '50.00', spent: '0.00000000' }],
          },
          mockRedis
        );

        const res = await app.request('/stream', {
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
              privilege: 'read',
              visibleFromEpoch: 1,
            },
          ],
        });

        const res = await app.request('/stream', {
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
              privilege: 'admin',
              visibleFromEpoch: 1,
            },
          ],
          memberBudgetRows: [{ budget: '50.00', spent: '0.00000000' }],
        });

        const res = await app.request('/stream', {
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

        const res = await app.request('/stream', {
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

        const res = await app.request('/stream', {
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

        const res = await app.request('/stream', {
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
              privilege: 'write',
              visibleFromEpoch: 1,
            },
          ],
          memberBudgetRows: [{ budget: '50.00', spent: '0.00000000' }],
        });

        // Server resolves owner_balance (group budget available)
        // Client claims personal_balance — mismatch!
        const res = await app.request('/stream', {
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
      it('sends context_length_exceeded code for ContextCapacityError', async () => {
        vi.useRealTimers();

        // Create a mock OpenRouter that throws ContextCapacityError during streaming
        const errorClient = createFastMockOpenRouterClient();
        const throwingClient: AppEnv['Variables']['openrouter'] = {
          ...errorClient,
          // eslint-disable-next-line @typescript-eslint/require-await, require-yield, sonarjs/generator-without-yield -- test mock generator that throws immediately
          async *chatCompletionStreamWithMetadata() {
            throw new ContextCapacityError();
          },
        };

        const app = createTestApp(undefined, undefined, throwingClient);

        const res = await app.request('/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(200); // SSE streams always return 200
        const text = await res.text();
        expect(text).toContain('event: error');
        expect(text).toContain('"code":"context_length_exceeded"');
      });

      it('sends STREAM_ERROR code for generic stream errors', async () => {
        vi.useRealTimers();

        // Create a mock OpenRouter that throws a generic error during streaming
        const errorClient = createFastMockOpenRouterClient();
        const throwingClient: AppEnv['Variables']['openrouter'] = {
          ...errorClient,
          // eslint-disable-next-line @typescript-eslint/require-await, require-yield, sonarjs/generator-without-yield -- test mock generator that throws immediately
          async *chatCompletionStreamWithMetadata() {
            throw new Error('Connection failed');
          },
        };

        const app = createTestApp(undefined, undefined, throwingClient);

        const res = await app.request('/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: error');
        expect(text).toContain('"code":"STREAM_ERROR"');
      });
    });
  });

  describe('POST /message', () => {
    const TEST_MESSAGE_ID = '33333333-3333-3333-8333-333333333333';

    function messageBody(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        conversationId: TEST_CONVERSATION_ID,
        messageId: TEST_MESSAGE_ID,
        content: 'Hello without AI',
        ...overrides,
      });
    }

    it('returns 401 for unauthenticated requests', async () => {
      const app = createUnauthenticatedTestApp();
      const res = await app.request('/message', {
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
      const res = await app.request('/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: TEST_CONVERSATION_ID,
          messageId: TEST_MESSAGE_ID,
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 404 when conversation does not exist', async () => {
      const app = createTestApp({ conversations: [] });
      const res = await app.request('/message', {
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
      const res = await app.request('/message', {
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
      const res = await app.request('/message', {
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
        c.set('openrouter', createFastMockOpenRouterClient());
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
        await next();
      });
      app.route('/', chatRoute);
      const res = await app.request('/message', {
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
            privilege: 'read_only',
            visibleFromEpoch: 1,
          },
        ],
      });
      const res = await app.request('/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: messageBody(),
      });

      expect(res.status).toBe(403);
    });
  });
});
