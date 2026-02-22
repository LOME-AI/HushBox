import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEV_EMAIL_DOMAIN, TEST_EMAIL_DOMAIN } from '@hushbox/shared';

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

function mockCryptoBytes(length: number): Uint8Array {
  return new Uint8Array(length).fill(0xab);
}

vi.mock('@hushbox/crypto', () => ({
  createOpaqueClient: vi.fn(() => ({})),
  startRegistration: vi.fn(() => Promise.resolve({ serialized: [1, 2, 3] })),
  finishRegistration: vi.fn(() =>
    Promise.resolve({ record: [...mockCryptoBytes(192)], exportKey: [4, 5, 6] })
  ),
  createAccount: vi.fn(() =>
    Promise.resolve({
      publicKey: mockCryptoBytes(32),
      passwordWrappedPrivateKey: mockCryptoBytes(48),
      recoveryWrappedPrivateKey: mockCryptoBytes(48),
      recoveryPhrase: 'test mnemonic phrase words here for recovery seed backup now',
    })
  ),
  createFirstEpoch: vi.fn((keys: Uint8Array[]) => ({
    epochPublicKey: mockCryptoBytes(32),
    epochPrivateKey: mockCryptoBytes(32),
    confirmationHash: mockCryptoBytes(32),
    memberWraps: keys.map((k: Uint8Array) => ({
      memberPublicKey: k,
      wrap: mockCryptoBytes(48),
    })),
  })),
  encryptMessageForStorage: vi.fn(() => mockCryptoBytes(64)),
  generateKeyPair: vi.fn(() => ({
    publicKey: mockCryptoBytes(32),
    privateKey: mockCryptoBytes(32),
  })),
  OpaqueClientConfig: {},
  OpaqueRegistrationRequest: {
    deserialize: vi.fn(() => ({ serialize: vi.fn(() => [7, 8, 9]) })),
  },
  createOpaqueServer: vi.fn(() =>
    Promise.resolve({
      registerInit: vi.fn(() => Promise.resolve({ serialize: () => [10, 11, 12] })),
    })
  ),
  getServerIdentifier: vi.fn(() => 'localhost:5173'),
  deriveTotpEncryptionKey: vi.fn(() => mockCryptoBytes(32)),
  encryptTotpSecret: vi.fn(() => mockCryptoBytes(48)),
}));

function createMockSelectChain(result: unknown[] = []) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(result)),
      })),
    })),
  };
}

function createMockDb() {
  return {
    select: vi.fn(() => createMockSelectChain()),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve()),
    })),
  };
}

vi.mock('@hushbox/db', () => {
  return {
    createDb: vi.fn(() => createMockDb()),
    LOCAL_NEON_DEV_CONFIG: {},
    users: { id: 'id' },
    conversations: { id: 'id' },
    messages: { id: 'id' },
    projects: { id: 'id' },
    payments: { id: 'id' },
    wallets: { id: 'id' },
    ledgerEntries: { id: 'id' },
    epochs: { id: 'id' },
    epochMembers: { id: 'id' },
    conversationMembers: { id: 'id' },
  };
});

vi.mock('@hushbox/db/factories', () => ({
  userFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-user-id',
      email: 'test@example.com',
      username: 'test_user',
      publicKey: mockCryptoBytes(32),
      passwordWrappedPrivateKey: mockCryptoBytes(48),
      recoveryWrappedPrivateKey: mockCryptoBytes(48),
      opaqueRegistration: mockCryptoBytes(64),
      emailVerified: false,
      totpEnabled: false,
      totpSecretEncrypted: null,
      hasAcknowledgedPhrase: false,
      ...overrides,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  },
  conversationFactory: {
    build: vi.fn((overrides?: { id?: string; userId?: string; title?: Uint8Array }) => ({
      id: overrides?.id ?? 'test-conv-id',
      userId: overrides?.userId ?? 'test-user-id',
      title: overrides?.title ?? mockCryptoBytes(64),
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 1,

      ...overrides,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  },
  messageFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-msg-id',
      conversationId: 'test-conv-id',
      encryptedBlob: mockCryptoBytes(64),
      senderType: 'user',
      senderId: 'test-user-id',
      senderDisplayName: null,
      payerId: null,
      epochNumber: 1,
      sequenceNumber: 1,
      ...overrides,
      createdAt: new Date(),
    })),
  },
  projectFactory: {
    build: vi.fn(
      (overrides?: {
        id?: string;
        userId?: string;
        encryptedName?: Uint8Array;
        encryptedDescription?: Uint8Array | null;
      }) => ({
        id: overrides?.id ?? 'test-project-id',
        userId: overrides?.userId ?? 'test-user-id',
        encryptedName: overrides?.encryptedName ?? mockCryptoBytes(64),
        encryptedDescription: overrides?.encryptedDescription ?? null,
        ...overrides,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    ),
  },
  paymentFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-payment-id',
      userId: 'test-user-id',
      amount: '50.00000000',
      status: 'completed',
      helcimTransactionId: 'txn-123',
      cardType: 'Visa',
      cardLastFour: '4242',
      errorMessage: null,
      ...overrides,
      createdAt: new Date(),
      updatedAt: new Date(),
      webhookReceivedAt: new Date(),
    })),
  },
  walletFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-wallet-id',
      userId: 'test-user-id',
      type: 'purchased',
      balance: '0.00000000',
      priority: 0,
      ...overrides,
      createdAt: new Date(),
    })),
  },
  ledgerEntryFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-ledger-id',
      walletId: 'test-wallet-id',
      amount: '0.00000000',
      balanceAfter: '0.00000000',
      entryType: 'welcome_credit',
      paymentId: null,
      usageRecordId: null,
      sourceWalletId: 'test-wallet-id',
      ...overrides,
      createdAt: new Date(),
    })),
  },
  epochFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-epoch-id',
      conversationId: 'test-conv-id',
      epochNumber: 1,
      epochPublicKey: mockCryptoBytes(32),
      confirmationHash: mockCryptoBytes(32),
      chainLink: null,
      ...overrides,
      createdAt: new Date(),
    })),
  },
  epochMemberFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-epoch-member-id',
      epochId: 'test-epoch-id',
      memberPublicKey: mockCryptoBytes(32),
      wrap: mockCryptoBytes(48),
      privilege: 'owner',
      visibleFromEpoch: 1,
      ...overrides,
      createdAt: new Date(),
    })),
  },
  conversationMemberFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-member-id',
      conversationId: 'test-conv-id',
      userId: 'test-user-id',
      linkId: null,
      privilege: 'owner',
      visibleFromEpoch: 1,
      ...overrides,
      joinedAt: new Date(),
      leftAt: null,
    })),
  },
}));

import {
  SEED_CONFIG,
  generateSeedData,
  generatePersonaData,
  generateTestPersonaData,
  upsertEntity,
  seed,
  seedUUID,
} from './seed';

describe('seed script', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('SEED_CONFIG', () => {
    it('defines moderate data amounts', () => {
      expect(SEED_CONFIG.USER_COUNT).toBe(5);
      expect(SEED_CONFIG.PROJECTS_PER_USER).toBe(2);
      expect(SEED_CONFIG.CONVERSATIONS_PER_USER).toBe(2);
      expect(SEED_CONFIG.MESSAGES_PER_CONVERSATION).toBe(5);
    });
  });

  describe('seedUUID', () => {
    it('generates valid UUID format', () => {
      const uuid = seedUUID('test');
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(uuid).toMatch(uuidRegex);
    });

    it('generates deterministic UUIDs', () => {
      const uuid1 = seedUUID('test');
      const uuid2 = seedUUID('test');
      expect(uuid1).toBe(uuid2);
    });

    it('generates different UUIDs for different inputs', () => {
      const uuid1 = seedUUID('test1');
      const uuid2 = seedUUID('test2');
      expect(uuid1).not.toBe(uuid2);
    });
  });

  describe('generateSeedData', () => {
    it('generates correct number of users', () => {
      const data = generateSeedData();
      expect(data.users).toHaveLength(SEED_CONFIG.USER_COUNT);
    });

    it('generates deterministic user IDs as valid UUIDs', () => {
      const data = generateSeedData();
      const firstUser = data.users[0];
      const fifthUser = data.users[4];
      expect(firstUser).toBeDefined();
      expect(fifthUser).toBeDefined();
      expect(firstUser?.id).toBe(seedUUID('seed-user-1'));
      expect(fifthUser?.id).toBe(seedUUID('seed-user-5'));
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(firstUser?.id).toMatch(uuidRegex);
    });

    it('generates correct number of projects (2 per user)', () => {
      const data = generateSeedData();
      const expectedProjects = SEED_CONFIG.USER_COUNT * SEED_CONFIG.PROJECTS_PER_USER;
      expect(data.projects).toHaveLength(expectedProjects);
    });

    it('generates correct number of conversations (2 per user)', () => {
      const data = generateSeedData();
      const expectedConversations = SEED_CONFIG.USER_COUNT * SEED_CONFIG.CONVERSATIONS_PER_USER;
      expect(data.conversations).toHaveLength(expectedConversations);
    });

    it('generates correct number of messages (5 per conversation)', () => {
      const data = generateSeedData();
      const expectedMessages =
        SEED_CONFIG.USER_COUNT *
        SEED_CONFIG.CONVERSATIONS_PER_USER *
        SEED_CONFIG.MESSAGES_PER_CONVERSATION;
      expect(data.messages).toHaveLength(expectedMessages);
    });

    it('links projects to correct users', () => {
      const data = generateSeedData();
      const user1Id = seedUUID('seed-user-1');
      const user1Projects = data.projects.filter((p) => p.userId === user1Id);
      expect(user1Projects).toHaveLength(SEED_CONFIG.PROJECTS_PER_USER);
    });

    it('links conversations to correct users', () => {
      const data = generateSeedData();
      const user1Id = seedUUID('seed-user-1');
      const user1Convs = data.conversations.filter((c) => c.userId === user1Id);
      expect(user1Convs).toHaveLength(SEED_CONFIG.CONVERSATIONS_PER_USER);
    });

    it('links messages to correct conversations', () => {
      const data = generateSeedData();
      const firstConv = data.conversations[0];
      expect(firstConv).toBeDefined();
      const conv1Messages = data.messages.filter((m) => m.conversationId === firstConv?.id);
      expect(conv1Messages).toHaveLength(SEED_CONFIG.MESSAGES_PER_CONVERSATION);
    });

    it('alternates message senderType between user and ai', () => {
      const data = generateSeedData();
      const firstConv = data.conversations[0];
      expect(firstConv).toBeDefined();
      const conv1Messages = data.messages.filter((m) => m.conversationId === firstConv?.id);

      expect(conv1Messages[0]?.senderType).toBe('user');
      expect(conv1Messages[1]?.senderType).toBe('ai');
      expect(conv1Messages[2]?.senderType).toBe('user');
    });

    it('generates epochs for each conversation', () => {
      const data = generateSeedData();
      const expectedEpochs = SEED_CONFIG.USER_COUNT * SEED_CONFIG.CONVERSATIONS_PER_USER;
      expect(data.epochs).toHaveLength(expectedEpochs);
    });

    it('generates epoch members for each conversation', () => {
      const data = generateSeedData();
      const expectedEpochMembers = SEED_CONFIG.USER_COUNT * SEED_CONFIG.CONVERSATIONS_PER_USER;
      expect(data.epochMembers).toHaveLength(expectedEpochMembers);
    });

    it('generates conversation members for each conversation', () => {
      const data = generateSeedData();
      const expectedConversationMembers =
        SEED_CONFIG.USER_COUNT * SEED_CONFIG.CONVERSATIONS_PER_USER;
      expect(data.conversationMembers).toHaveLength(expectedConversationMembers);
    });

    it('messages have encrypted blobs instead of plaintext content', () => {
      const data = generateSeedData();
      const firstMsg = data.messages[0];
      expect(firstMsg).toBeDefined();
      expect(firstMsg?.encryptedBlob).toBeInstanceOf(Uint8Array);
      expect('content' in (firstMsg ?? {})).toBe(false);
      expect('role' in (firstMsg ?? {})).toBe(false);
    });

    it('conversations have encrypted titles', () => {
      const data = generateSeedData();
      const firstConv = data.conversations[0];
      expect(firstConv).toBeDefined();
      expect(firstConv?.title).toBeInstanceOf(Uint8Array);
    });

    it('projects have encrypted names', () => {
      const data = generateSeedData();
      const firstProject = data.projects[0];
      expect(firstProject).toBeDefined();
      expect(firstProject?.encryptedName).toBeInstanceOf(Uint8Array);
    });
  });

  describe('upsertEntity', () => {
    function createTestMockDb(existingRecords: unknown[] = []) {
      return {
        select: vi.fn(() => createMockSelectChain(existingRecords)),
        insert: vi.fn(() => ({
          values: vi.fn(() => Promise.resolve()),
        })),
      };
    }

    it('returns "created" when entity does not exist', async () => {
      const mockDb = createTestMockDb([]);

      const result = await upsertEntity(
        mockDb as never,
        { id: 'id' } as never,
        { id: 'test-1' } as never
      );

      expect(result).toBe('created');
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('returns "exists" when entity already exists', async () => {
      const mockDb = createTestMockDb([{ id: 'test-1' }]);

      const result = await upsertEntity(
        mockDb as never,
        { id: 'id' } as never,
        { id: 'test-1' } as never
      );

      expect(result).toBe('exists');
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('seed', () => {
    it('throws if DATABASE_URL is not set', async () => {
      delete process.env['DATABASE_URL'];

      await expect(seed()).rejects.toThrow('DATABASE_URL is required');
    });

    it('seeds all entities without throwing', async () => {
      await expect(seed()).resolves.not.toThrow();
    });
  });

  describe('generatePersonaData', () => {
    it('generates all three personas', async () => {
      const data = await generatePersonaData();
      expect(data.users).toHaveLength(3);
    });

    it('includes alice, bob, and charlie users with dev domain', async () => {
      const data = await generatePersonaData();
      const emails = data.users.map((u) => u.email);
      expect(emails).toContain(`alice@${DEV_EMAIL_DOMAIN}`);
      expect(emails).toContain(`bob@${DEV_EMAIL_DOMAIN}`);
      expect(emails).toContain(`charlie@${DEV_EMAIL_DOMAIN}`);
    });

    it('uses deterministic UUIDs based on persona name', async () => {
      const data = await generatePersonaData();
      const alice = data.users.find((u) => u.email === `alice@${DEV_EMAIL_DOMAIN}`);
      expect(alice?.id).toBe(seedUUID('dev-user-alice'));
    });

    it('generates sample data only for alice (hasSampleData=true)', async () => {
      const data = await generatePersonaData();
      const aliceId = seedUUID('dev-user-alice');
      const bobId = seedUUID('dev-user-bob');
      const charlieId = seedUUID('dev-user-charlie');

      const aliceProjects = data.projects.filter((p) => p.userId === aliceId);
      expect(aliceProjects.length).toBeGreaterThan(0);

      const aliceConversations = data.conversations.filter((c) => c.userId === aliceId);
      expect(aliceConversations.length).toBeGreaterThan(0);

      const bobProjects = data.projects.filter((p) => p.userId === bobId);
      const bobConversations = data.conversations.filter((c) => c.userId === bobId);
      expect(bobProjects).toHaveLength(0);
      expect(bobConversations).toHaveLength(0);

      const charlieProjects = data.projects.filter((p) => p.userId === charlieId);
      expect(charlieProjects).toHaveLength(0);
      // Charlie has a conversation but no projects/payments
    });

    it('charlie has exactly 1 conversation with 4 messages', async () => {
      const data = await generatePersonaData();
      const charlieId = seedUUID('dev-user-charlie');

      const charlieConversations = data.conversations.filter((c) => c.userId === charlieId);
      expect(charlieConversations).toHaveLength(1);

      const charlieMessages = data.messages.filter((m) =>
        charlieConversations.some((c) => c.id === m.conversationId)
      );
      expect(charlieMessages).toHaveLength(4);

      // Verify alternating sender types
      expect(charlieMessages[0]?.senderType).toBe('user');
      expect(charlieMessages[1]?.senderType).toBe('ai');
      expect(charlieMessages[2]?.senderType).toBe('user');
      expect(charlieMessages[3]?.senderType).toBe('ai');
    });

    it('alice has exactly 2 projects', async () => {
      const data = await generatePersonaData();
      const aliceId = seedUUID('dev-user-alice');
      const aliceProjects = data.projects.filter((p) => p.userId === aliceId);
      expect(aliceProjects).toHaveLength(2);
    });

    it('alice has exactly 3 conversations', async () => {
      const data = await generatePersonaData();
      const aliceId = seedUUID('dev-user-alice');
      const aliceConversations = data.conversations.filter((c) => c.userId === aliceId);
      expect(aliceConversations).toHaveLength(3);
    });

    it('sets emailVerified correctly from persona definition', async () => {
      const data = await generatePersonaData();
      const alice = data.users.find((u) => u.email === `alice@${DEV_EMAIL_DOMAIN}`);
      const bob = data.users.find((u) => u.email === `bob@${DEV_EMAIL_DOMAIN}`);
      const charlie = data.users.find((u) => u.email === `charlie@${DEV_EMAIL_DOMAIN}`);

      expect(alice?.emailVerified).toBe(true);
      expect(bob?.emailVerified).toBe(true);
      expect(charlie?.emailVerified).toBe(true);
    });

    it('alice has exactly 14 payments', async () => {
      const data = await generatePersonaData();
      const aliceId = seedUUID('dev-user-alice');
      const alicePayments = data.payments.filter((p) => p.userId === aliceId);
      expect(alicePayments).toHaveLength(14);
    });

    it('alice has exactly 14 deposit ledger entries', async () => {
      const data = await generatePersonaData();
      const purchasedWalletId = seedUUID('alice-wallet-purchased');
      const aliceDepositEntries = data.ledgerEntries.filter(
        (e) => e.walletId === purchasedWalletId && e.entryType === 'deposit'
      );
      expect(aliceDepositEntries).toHaveLength(14);
    });

    it('all alice payments are confirmed status', async () => {
      const data = await generatePersonaData();
      const aliceId = seedUUID('dev-user-alice');
      const alicePayments = data.payments.filter((p) => p.userId === aliceId);
      for (const payment of alicePayments) {
        expect(payment.status).toBe('completed');
      }
    });

    it('deposit ledger entries are linked to payments', async () => {
      const data = await generatePersonaData();
      const purchasedWalletId = seedUUID('alice-wallet-purchased');
      const aliceDepositEntries = data.ledgerEntries.filter(
        (e) => e.walletId === purchasedWalletId && e.entryType === 'deposit'
      );
      const alicePaymentIds = new Set(
        data.payments.filter((p) => p.userId === seedUUID('dev-user-alice')).map((p) => p.id)
      );

      for (const entry of aliceDepositEntries) {
        expect(alicePaymentIds.has(entry.paymentId ?? '')).toBe(true);
      }
    });

    it('bob and charlie have no payments', async () => {
      const data = await generatePersonaData();
      const bobId = seedUUID('dev-user-bob');
      const charlieId = seedUUID('dev-user-charlie');

      const bobPayments = data.payments.filter((p) => p.userId === bobId);
      const charliePayments = data.payments.filter((p) => p.userId === charlieId);

      expect(bobPayments).toHaveLength(0);
      expect(charliePayments).toHaveLength(0);
    });

    it('persona users have valid crypto fields', async () => {
      const data = await generatePersonaData();
      for (const user of data.users) {
        expect(user.opaqueRegistration).toBeInstanceOf(Uint8Array);
        expect(user.opaqueRegistration.length).toBeGreaterThan(64);
        expect(user.publicKey).toBeInstanceOf(Uint8Array);
        expect(user.passwordWrappedPrivateKey).toBeInstanceOf(Uint8Array);
        expect(user.recoveryWrappedPrivateKey).toBeInstanceOf(Uint8Array);
      }
    });

    it('each persona has 2 wallets (purchased + free_tier)', async () => {
      const data = await generatePersonaData();
      // 3 personas * 2 wallets each = 6
      expect(data.wallets).toHaveLength(6);

      const aliceId = seedUUID('dev-user-alice');
      const aliceWallets = data.wallets.filter((w) => w.userId === aliceId);
      expect(aliceWallets).toHaveLength(2);

      const purchased = aliceWallets.find((w) => w.type === 'purchased');
      const freeTier = aliceWallets.find((w) => w.type === 'free_tier');
      expect(purchased).toBeDefined();
      expect(freeTier).toBeDefined();
      expect(purchased?.priority).toBe(0);
      expect(freeTier?.priority).toBe(1);
    });

    it('alice conversations have epochs', async () => {
      const data = await generatePersonaData();
      const aliceId = seedUUID('dev-user-alice');
      const aliceConversations = data.conversations.filter((c) => c.userId === aliceId);

      // Each conversation should have 1 epoch
      for (const conv of aliceConversations) {
        const convEpochs = data.epochs.filter((e) => e.conversationId === conv.id);
        expect(convEpochs).toHaveLength(1);
        expect(convEpochs[0]?.epochNumber).toBe(1);
      }
    });

    it('alice conversations have conversation members', async () => {
      const data = await generatePersonaData();
      const aliceId = seedUUID('dev-user-alice');
      const aliceConversations = data.conversations.filter((c) => c.userId === aliceId);

      for (const conv of aliceConversations) {
        const convMembers = data.conversationMembers.filter((m) => m.conversationId === conv.id);
        expect(convMembers).toHaveLength(1);
        expect(convMembers[0]?.userId).toBe(aliceId);
        expect(convMembers[0]?.privilege).toBe('owner');
      }
    });
  });

  describe('generateTestPersonaData', () => {
    it('generates all ten test personas', async () => {
      const data = await generateTestPersonaData();
      expect(data.users).toHaveLength(10);
    });

    it('includes test-alice, test-bob, and test-charlie users with test domain', async () => {
      const data = await generateTestPersonaData();
      const emails = data.users.map((u) => u.email);
      expect(emails).toContain(`test-alice@${TEST_EMAIL_DOMAIN}`);
      expect(emails).toContain(`test-bob@${TEST_EMAIL_DOMAIN}`);
      expect(emails).toContain(`test-charlie@${TEST_EMAIL_DOMAIN}`);
    });

    it('uses deterministic UUIDs based on test persona name', async () => {
      const data = await generateTestPersonaData();
      const testAlice = data.users.find((u) => u.email === `test-alice@${TEST_EMAIL_DOMAIN}`);
      expect(testAlice?.id).toBe(seedUUID('test-user-test-alice'));
    });

    it('generates sample data only for test-alice (hasSampleData=true)', async () => {
      const data = await generateTestPersonaData();
      const testAliceId = seedUUID('test-user-test-alice');
      const testBobId = seedUUID('test-user-test-bob');
      const testCharlieId = seedUUID('test-user-test-charlie');

      const testAliceProjects = data.projects.filter((p) => p.userId === testAliceId);
      expect(testAliceProjects.length).toBeGreaterThan(0);

      const testAliceConversations = data.conversations.filter((c) => c.userId === testAliceId);
      expect(testAliceConversations.length).toBeGreaterThan(0);

      const testBobProjects = data.projects.filter((p) => p.userId === testBobId);
      const testBobConversations = data.conversations.filter((c) => c.userId === testBobId);
      expect(testBobProjects).toHaveLength(0);
      expect(testBobConversations).toHaveLength(0);

      const testCharlieProjects = data.projects.filter((p) => p.userId === testCharlieId);
      const testCharlieConversations = data.conversations.filter((c) => c.userId === testCharlieId);
      expect(testCharlieProjects).toHaveLength(0);
      expect(testCharlieConversations).toHaveLength(0);
    });

    it('test-alice has exactly 2 projects', async () => {
      const data = await generateTestPersonaData();
      const testAliceId = seedUUID('test-user-test-alice');
      const testAliceProjects = data.projects.filter((p) => p.userId === testAliceId);
      expect(testAliceProjects).toHaveLength(2);
    });

    it('test-alice has exactly 3 conversations', async () => {
      const data = await generateTestPersonaData();
      const testAliceId = seedUUID('test-user-test-alice');
      const testAliceConversations = data.conversations.filter((c) => c.userId === testAliceId);
      expect(testAliceConversations).toHaveLength(3);
    });

    it('sets emailVerified correctly from test persona definition', async () => {
      const data = await generateTestPersonaData();
      const testAlice = data.users.find((u) => u.email === `test-alice@${TEST_EMAIL_DOMAIN}`);
      const testBob = data.users.find((u) => u.email === `test-bob@${TEST_EMAIL_DOMAIN}`);
      const testCharlie = data.users.find((u) => u.email === `test-charlie@${TEST_EMAIL_DOMAIN}`);

      expect(testAlice?.emailVerified).toBe(true);
      expect(testBob?.emailVerified).toBe(true);
      expect(testCharlie?.emailVerified).toBe(false);
    });

    it('uses different email domain than dev personas', async () => {
      const devData = await generatePersonaData();
      const testData = await generateTestPersonaData();

      const devEmails = devData.users.map((u) => u.email);
      const testEmails = testData.users.map((u) => u.email);

      // No overlap between dev and test emails
      for (const devEmail of devEmails) {
        expect(testEmails).not.toContain(devEmail);
      }
    });

    it('includes test-2fa persona with TOTP enabled', async () => {
      const data = await generateTestPersonaData();
      const test2fa = data.users.find((u) => u.email === `test-2fa@${TEST_EMAIL_DOMAIN}`);

      expect(test2fa).toBeDefined();
      expect(test2fa?.emailVerified).toBe(true);
      expect(test2fa?.totpEnabled).toBe(true);
      expect(test2fa?.totpSecretEncrypted).toBeInstanceOf(Uint8Array);
    });

    it('test persona users have valid crypto fields', async () => {
      const data = await generateTestPersonaData();
      for (const user of data.users) {
        expect(user.opaqueRegistration).toBeInstanceOf(Uint8Array);
        expect(user.opaqueRegistration.length).toBeGreaterThan(64);
        expect(user.publicKey).toBeInstanceOf(Uint8Array);
        expect(user.passwordWrappedPrivateKey).toBeInstanceOf(Uint8Array);
        expect(user.recoveryWrappedPrivateKey).toBeInstanceOf(Uint8Array);
      }
    });

    it('each test persona has 2 wallets (purchased + free_tier)', async () => {
      const data = await generateTestPersonaData();
      // 10 personas * 2 wallets each = 20
      expect(data.wallets).toHaveLength(20);
    });

    it('test-alice conversations have epochs and members', async () => {
      const data = await generateTestPersonaData();
      const testAliceId = seedUUID('test-user-test-alice');
      const testAliceConversations = data.conversations.filter((c) => c.userId === testAliceId);

      for (const conv of testAliceConversations) {
        const convEpochs = data.epochs.filter((e) => e.conversationId === conv.id);
        expect(convEpochs).toHaveLength(1);

        const convMembers = data.conversationMembers.filter((m) => m.conversationId === conv.id);
        expect(convMembers).toHaveLength(1);
        expect(convMembers[0]?.userId).toBe(testAliceId);
      }
    });
  });
});
