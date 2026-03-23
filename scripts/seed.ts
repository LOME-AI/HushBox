import { eq } from 'drizzle-orm';
import { config } from 'dotenv';
import path from 'node:path';

import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  conversations,
  messages,
  projects,
  payments,
  wallets,
  ledgerEntries,
  epochs,
  epochMembers,
  conversationMembers,
} from '@hushbox/db';
import {
  userFactory,
  conversationFactory,
  messageFactory,
  projectFactory,
  paymentFactory,
  walletFactory,
  ledgerEntryFactory,
  epochFactory,
  epochMemberFactory,
  conversationMemberFactory,
} from '@hushbox/db/factories';
import {
  DEV_EMAIL_DOMAIN,
  TEST_EMAIL_DOMAIN,
  FREE_ALLOWANCE_DOLLARS,
  DEV_PASSWORD,
  envConfig,
  resolveRaw,
  Mode,
  normalizeUsername,
} from '@hushbox/shared';
import {
  createOpaqueClient,
  startRegistration,
  finishRegistration,
  createAccount,
  createFirstEpoch,
  encryptMessageForStorage,
  OpaqueClientConfig,
  OpaqueRegistrationRequest,
  createOpaqueServer,
  OPAQUE_SERVER_IDENTIFIER,
  deriveTotpEncryptionKey,
  encryptTotpSecret,
} from '@hushbox/crypto';

async function createOpaqueUserCrypto(
  password: string,
  credentialIdentifier: string
): Promise<{
  opaqueRegistration: Uint8Array;
  publicKey: Uint8Array;
  passwordWrappedPrivateKey: Uint8Array;
  recoveryWrappedPrivateKey: Uint8Array;
}> {
  const masterSecret =
    process.env['OPAQUE_MASTER_SECRET'] ??
    (resolveRaw(envConfig.OPAQUE_MASTER_SECRET, Mode.Development) as string);

  // 1. OPAQUE registration (client <-> server protocol)
  const masterSecretBytes = new TextEncoder().encode(masterSecret);
  const opaqueServer = await createOpaqueServer(masterSecretBytes, OPAQUE_SERVER_IDENTIFIER);

  const client = createOpaqueClient();
  const { serialized } = await startRegistration(client, password);

  const request = OpaqueRegistrationRequest.deserialize(OpaqueClientConfig, serialized);
  const serverResult = await opaqueServer.registerInit(request, credentialIdentifier);
  if (serverResult instanceof Error) throw serverResult;

  const { record, exportKey } = await finishRegistration(
    client,
    serverResult.serialize(),
    OPAQUE_SERVER_IDENTIFIER
  );
  const opaqueRegistration = new Uint8Array(record);

  // 2. Create account keys from OPAQUE export key
  const account = await createAccount(new Uint8Array(exportKey));

  return {
    opaqueRegistration,
    publicKey: account.publicKey,
    passwordWrappedPrivateKey: account.passwordWrappedPrivateKey,
    recoveryWrappedPrivateKey: account.recoveryWrappedPrivateKey,
  };
}

export const DEV_PERSONAS = [
  {
    name: 'alice',
    displayName: 'Sarah Chen',
    emailVerified: true,
    hasSampleData: true,
    balance: '10000.00000000',
  },
  {
    name: 'bob',
    displayName: 'Marcus Johnson',
    emailVerified: true,
    hasSampleData: false,
    balance: '0.20000000',
  },
  {
    name: 'charlie',
    displayName: 'Priya Patel',
    emailVerified: true,
    hasSampleData: false,
    balance: '0.00000000',
  },
] as const;

export const TEST_2FA_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export const TEST_PERSONAS = [
  {
    name: 'test-alice',
    displayName: 'Test Alice',
    emailVerified: true,
    hasSampleData: true,
    totpSecret: null as string | null,
  },
  {
    name: 'test-bob',
    displayName: 'Test Bob',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null as string | null,
  },
  {
    name: 'test-charlie',
    displayName: 'Test Charlie',
    emailVerified: false,
    hasSampleData: false,
    totpSecret: null as string | null,
  },
  {
    name: 'test-dave',
    displayName: 'Test Dave',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null as string | null,
  },
  // Dedicated billing test users (isolated to avoid balance state bleeding between tests)
  {
    name: 'test-billing-success',
    displayName: 'Test Billing Success',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null as string | null,
  },
  {
    name: 'test-billing-failure',
    displayName: 'Test Billing Failure',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null as string | null,
  },
  {
    name: 'test-billing-validation',
    displayName: 'Test Bill Valid',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null as string | null,
  },
  {
    name: 'test-billing-success-2',
    displayName: 'Test Bill Success 2',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null as string | null,
  },
  {
    name: 'test-billing-devmode',
    displayName: 'Test Billing Dev',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null as string | null,
  },
  {
    name: 'test-2fa',
    displayName: 'Test 2FA User',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: TEST_2FA_TOTP_SECRET,
  },
] as const;

function devEmail(name: string): string {
  return `${name}@${DEV_EMAIL_DOMAIN}`;
}

function testEmail(name: string): string {
  return `${name}@${TEST_EMAIL_DOMAIN}`;
}

export const SEED_CONFIG = {
  USER_COUNT: 5,
  PROJECTS_PER_USER: 2,
  CONVERSATIONS_PER_USER: 2,
  MESSAGES_PER_CONVERSATION: 5,
} as const;

export function seedUUID(name: string): string {
  // Create a simple hash of the name and format as UUID
  let hash = 0;
  for (let index = 0; index < name.length; index++) {
    const char = name.codePointAt(index) ?? 0;
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  const hex = Math.abs(hash).toString(16).padStart(12, '0').slice(0, 12);
  return `00000000-0000-4000-8000-${hex}`;
}

type User = typeof users.$inferInsert;
type Conversation = typeof conversations.$inferInsert;
type Message = typeof messages.$inferInsert;
type Project = typeof projects.$inferInsert;
type Payment = typeof payments.$inferInsert;
type Wallet = typeof wallets.$inferInsert;
type LedgerEntry = typeof ledgerEntries.$inferInsert;
type Epoch = typeof epochs.$inferInsert;
type EpochMember = typeof epochMembers.$inferInsert;
type ConversationMember = typeof conversationMembers.$inferInsert;

type UserWithId = User & { id: string };
type ConversationWithId = Conversation & { id: string };
type MessageWithId = Message & { id: string };
type ProjectWithId = Project & { id: string };
type PaymentWithId = Payment & { id: string };
type WalletWithId = Wallet & { id: string };
type LedgerEntryWithId = LedgerEntry & { id: string };
type EpochWithId = Epoch & { id: string };
type EpochMemberWithId = EpochMember & { id: string };
type ConversationMemberWithId = ConversationMember & { id: string };

interface SeedData {
  users: UserWithId[];
  projects: ProjectWithId[];
  conversations: ConversationWithId[];
  messages: MessageWithId[];
  epochs: EpochWithId[];
  epochMembers: EpochMemberWithId[];
  conversationMembers: ConversationMemberWithId[];
}

interface PersonaData {
  users: UserWithId[];
  projects: ProjectWithId[];
  conversations: ConversationWithId[];
  messages: MessageWithId[];
  payments: PaymentWithId[];
  wallets: WalletWithId[];
  ledgerEntries: LedgerEntryWithId[];
  epochs: EpochWithId[];
  epochMembers: EpochMemberWithId[];
  conversationMembers: ConversationMemberWithId[];
}

interface UserEntities {
  user: UserWithId;
  projects: ProjectWithId[];
  conversations: ConversationWithId[];
  messages: MessageWithId[];
  epochs: EpochWithId[];
  epochMembers: EpochMemberWithId[];
  conversationMembers: ConversationMemberWithId[];
}

function createConversationEpochData(
  convId: string,
  userId: string,
  userPublicKey: Uint8Array
): {
  epoch: EpochWithId;
  epochMember: EpochMemberWithId;
  conversationMember: ConversationMemberWithId;
  epochPublicKey: Uint8Array;
} {
  const epochResult = createFirstEpoch([userPublicKey]);
  const epochId = seedUUID(`${convId}-epoch-1`);

  const epoch = epochFactory.build({
    id: epochId,
    conversationId: convId,
    epochNumber: 1,
    epochPublicKey: epochResult.epochPublicKey,
    confirmationHash: epochResult.confirmationHash,
    chainLink: null,
  });

  const epochMember = epochMemberFactory.build({
    id: seedUUID(`${convId}-epoch-member`),
    epochId,
    memberPublicKey: userPublicKey,
    wrap: epochResult.memberWraps[0]?.wrap ?? new Uint8Array(0),
    visibleFromEpoch: 1,
  });

  const conversationMember = conversationMemberFactory.build({
    id: seedUUID(`${convId}-member`),
    conversationId: convId,
    userId,
    privilege: 'owner',
    visibleFromEpoch: 1,
  });

  return { epoch, epochMember, conversationMember, epochPublicKey: epochResult.epochPublicKey };
}

function generateUserEntities(userIndex: number): UserEntities {
  const userId = seedUUID(`seed-user-${String(userIndex + 1)}`);
  const user = userFactory.build({ id: userId });
  const userPublicKey: Uint8Array = user.publicKey;
  const projects: ProjectWithId[] = [];
  const allConversations: ConversationWithId[] = [];
  const allMessages: MessageWithId[] = [];
  const allEpochs: EpochWithId[] = [];
  const allEpochMembers: EpochMemberWithId[] = [];
  const allConversationMembers: ConversationMemberWithId[] = [];

  for (let projectIndex = 0; projectIndex < SEED_CONFIG.PROJECTS_PER_USER; projectIndex++) {
    projects.push(
      projectFactory.build({
        id: seedUUID(`seed-project-${String(userIndex + 1)}-${String(projectIndex + 1)}`),
        userId,
        encryptedName: encryptMessageForStorage(
          userPublicKey,
          `Project ${String(projectIndex + 1)}`
        ),
        encryptedDescription: null,
      })
    );
  }

  for (let convIndex = 0; convIndex < SEED_CONFIG.CONVERSATIONS_PER_USER; convIndex++) {
    const convId = seedUUID(`seed-conv-${String(userIndex + 1)}-${String(convIndex + 1)}`);
    const { epoch, epochMember, conversationMember, epochPublicKey } = createConversationEpochData(
      convId,
      userId,
      userPublicKey
    );

    allConversations.push(
      conversationFactory.build({
        id: convId,
        userId,
        title: encryptMessageForStorage(
          epochPublicKey,
          `Seed Conversation ${String(convIndex + 1)}`
        ),
      })
    );
    allEpochs.push(epoch);
    allEpochMembers.push(epochMember);
    allConversationMembers.push(conversationMember);

    let previousMsgId: string | null = null;
    for (let msgIndex = 0; msgIndex < SEED_CONFIG.MESSAGES_PER_CONVERSATION; msgIndex++) {
      const senderType = msgIndex % 2 === 0 ? 'user' : 'ai';
      const msgId = seedUUID(
        `seed-msg-${String(userIndex + 1)}-${String(convIndex + 1)}-${String(msgIndex + 1)}`
      );
      allMessages.push(
        messageFactory.build({
          id: msgId,
          conversationId: convId,
          encryptedBlob: encryptMessageForStorage(
            epochPublicKey,
            `Sample message ${String(msgIndex + 1)}`
          ),
          senderType,
          senderId: senderType === 'user' ? userId : null,
          epochNumber: 1,
          sequenceNumber: msgIndex + 1,
          parentMessageId: previousMsgId,
        })
      );
      previousMsgId = msgId;
    }
  }

  return {
    user,
    projects,
    conversations: allConversations,
    messages: allMessages,
    epochs: allEpochs,
    epochMembers: allEpochMembers,
    conversationMembers: allConversationMembers,
  };
}

export function generateSeedData(): SeedData {
  const seedUsers: UserWithId[] = [];
  const seedProjects: ProjectWithId[] = [];
  const seedConversations: ConversationWithId[] = [];
  const seedMessages: MessageWithId[] = [];
  const seedEpochs: EpochWithId[] = [];
  const seedEpochMembers: EpochMemberWithId[] = [];
  const seedConversationMembers: ConversationMemberWithId[] = [];

  for (let index = 0; index < SEED_CONFIG.USER_COUNT; index++) {
    const entities = generateUserEntities(index);
    seedUsers.push(entities.user);
    seedProjects.push(...entities.projects);
    seedConversations.push(...entities.conversations);
    seedMessages.push(...entities.messages);
    seedEpochs.push(...entities.epochs);
    seedEpochMembers.push(...entities.epochMembers);
    seedConversationMembers.push(...entities.conversationMembers);
  }

  return {
    users: seedUsers,
    projects: seedProjects,
    conversations: seedConversations,
    messages: seedMessages,
    epochs: seedEpochs,
    epochMembers: seedEpochMembers,
    conversationMembers: seedConversationMembers,
  };
}

async function createPersonaUser(
  persona: (typeof DEV_PERSONAS)[number],
  now: Date
): Promise<{ user: UserWithId; publicKey: Uint8Array }> {
  const userId = seedUUID(`dev-user-${persona.name}`);
  const email = devEmail(persona.name);
  const crypto = await createOpaqueUserCrypto(DEV_PASSWORD, userId);

  const user: UserWithId = {
    id: userId,
    email,
    username: normalizeUsername(persona.displayName),
    emailVerified: persona.emailVerified,
    hasAcknowledgedPhrase: true,
    createdAt: now,
    updatedAt: now,
    opaqueRegistration: crypto.opaqueRegistration,
    publicKey: crypto.publicKey,
    passwordWrappedPrivateKey: crypto.passwordWrappedPrivateKey,
    recoveryWrappedPrivateKey: crypto.recoveryWrappedPrivateKey,
  };

  return { user, publicKey: crypto.publicKey };
}

const SEARCH_MESSAGES = [
  { role: 'user' as const, text: 'What are the latest developments in quantum computing?' },
  {
    role: 'ai' as const,
    text:
      'Based on recent web results, here are the latest developments in quantum computing:\n\n' +
      'According to [nature.com](https://nature.com/articles/quantum-2024), researchers have ' +
      'achieved a major breakthrough in error correction, demonstrating logical qubits with ' +
      'error rates below the threshold needed for practical computation.\n\n' +
      'A recent paper on [arxiv.org](https://arxiv.org/abs/2401.00001) describes a new ' +
      'approach to topological quantum computing that could make systems more stable at ' +
      'higher temperatures.',
  },
  {
    role: 'user' as const,
    text: 'How does this compare to classical computing for optimization problems?',
  },
  {
    role: 'ai' as const,
    text:
      'Quantum computing shows significant advantages for specific optimization problems:\n\n' +
      'According to [science.org](https://science.org/quantum-optimization), quantum annealers ' +
      'have demonstrated up to 100x speedups on certain combinatorial optimization tasks ' +
      'compared to classical solvers.\n\n' +
      'However, as noted by [ieee.org](https://spectrum.ieee.org/quantum-classical), for many ' +
      'real-world problems classical algorithms remain competitive, and the crossover point ' +
      'depends heavily on problem structure and size.',
  },
];

interface ConversationMessageContext {
  personaName: string;
  convIndex: number;
  convId: string;
  userId: string;
  epochPublicKey: Uint8Array;
  now: Date;
}

function createSearchConversationMessages(ctx: ConversationMessageContext): MessageWithId[] {
  const messages: MessageWithId[] = [];
  let previousMsgId: string | null = null;
  for (const [msgIndex, msg] of SEARCH_MESSAGES.entries()) {
    const msgTime = new Date(ctx.now.getTime() + ctx.convIndex * 10_000 + msgIndex * 1000);
    const msgId = seedUUID(
      `${ctx.personaName}-msg-${String(ctx.convIndex + 1)}-${String(msgIndex + 1)}`
    );
    messages.push(
      messageFactory.build({
        id: msgId,
        conversationId: ctx.convId,
        encryptedBlob: encryptMessageForStorage(ctx.epochPublicKey, msg.text),
        senderType: msg.role,
        senderId: msg.role === 'user' ? ctx.userId : null,
        epochNumber: 1,
        sequenceNumber: msgIndex + 1,
        parentMessageId: previousMsgId,
        createdAt: msgTime,
      })
    );
    previousMsgId = msgId;
  }
  return messages;
}

function createGenericConversationMessages(ctx: ConversationMessageContext): MessageWithId[] {
  const messages: MessageWithId[] = [];
  const messageCount = 3 + (ctx.convIndex % 3);
  let previousMsgId: string | null = null;
  for (let msgIndex = 0; msgIndex < messageCount; msgIndex++) {
    const senderType = msgIndex % 2 === 0 ? 'user' : 'ai';
    const msgTime = new Date(ctx.now.getTime() + ctx.convIndex * 10_000 + msgIndex * 1000);
    const msgId = seedUUID(
      `${ctx.personaName}-msg-${String(ctx.convIndex + 1)}-${String(msgIndex + 1)}`
    );
    messages.push(
      messageFactory.build({
        id: msgId,
        conversationId: ctx.convId,
        encryptedBlob: encryptMessageForStorage(
          ctx.epochPublicKey,
          `${ctx.personaName} message ${String(ctx.convIndex + 1)}-${String(msgIndex + 1)}`
        ),
        senderType,
        senderId: senderType === 'user' ? ctx.userId : null,
        epochNumber: 1,
        sequenceNumber: msgIndex + 1,
        parentMessageId: previousMsgId,
        createdAt: msgTime,
      })
    );
    previousMsgId = msgId;
  }
  return messages;
}

function createPersonaSampleData(
  personaName: string,
  userId: string,
  userPublicKey: Uint8Array,
  now: Date
): {
  projects: ProjectWithId[];
  conversations: ConversationWithId[];
  messages: MessageWithId[];
  epochs: EpochWithId[];
  epochMembers: EpochMemberWithId[];
  conversationMembers: ConversationMemberWithId[];
} {
  const sampleProjects: ProjectWithId[] = [];
  const sampleConversations: ConversationWithId[] = [];
  const sampleMessages: MessageWithId[] = [];
  const sampleEpochs: EpochWithId[] = [];
  const sampleEpochMembers: EpochMemberWithId[] = [];
  const sampleConversationMembers: ConversationMemberWithId[] = [];

  for (let projectIndex = 0; projectIndex < 2; projectIndex++) {
    sampleProjects.push(
      projectFactory.build({
        id: seedUUID(`${personaName}-project-${String(projectIndex + 1)}`),
        userId,
        encryptedName: encryptMessageForStorage(
          userPublicKey,
          `${personaName} Project ${String(projectIndex + 1)}`
        ),
        encryptedDescription: null,
      })
    );
  }

  for (let convIndex = 0; convIndex < 3; convIndex++) {
    const convId = seedUUID(`${personaName}-conv-${String(convIndex + 1)}`);
    const { epoch, epochMember, conversationMember, epochPublicKey } = createConversationEpochData(
      convId,
      userId,
      userPublicKey
    );

    const isSearchConversation = convIndex === 2;
    const convTitle = isSearchConversation
      ? 'Quantum Computing Research'
      : `${personaName} Conversation ${String(convIndex + 1)}`;

    sampleConversations.push(
      conversationFactory.build({
        id: convId,
        userId,
        title: encryptMessageForStorage(epochPublicKey, convTitle),
      })
    );
    sampleEpochs.push(epoch);
    sampleEpochMembers.push(epochMember);
    sampleConversationMembers.push(conversationMember);

    const msgCtx: ConversationMessageContext = {
      personaName,
      convIndex,
      convId,
      userId,
      epochPublicKey,
      now,
    };
    const convMessages = isSearchConversation
      ? createSearchConversationMessages(msgCtx)
      : createGenericConversationMessages(msgCtx);
    sampleMessages.push(...convMessages);
  }

  return {
    projects: sampleProjects,
    conversations: sampleConversations,
    messages: sampleMessages,
    epochs: sampleEpochs,
    epochMembers: sampleEpochMembers,
    conversationMembers: sampleConversationMembers,
  };
}

function createPersonaPayments(
  personaName: string,
  userId: string,
  purchasedWalletId: string,
  now: Date
): { payments: PaymentWithId[]; ledgerEntries: LedgerEntryWithId[] } {
  const personaPayments: PaymentWithId[] = [];
  const entries: LedgerEntryWithId[] = [];
  let runningBalance = 0;

  for (let index = 0; index < 14; index++) {
    const paymentId = seedUUID(`${personaName}-payment-${String(index + 1)}`);
    const baseAmount = 5 + (index % 5);
    const amount = index === 13 ? baseAmount + 4 : baseAmount;
    runningBalance += amount;

    const paymentDate = new Date(now);
    paymentDate.setDate(paymentDate.getDate() - (14 - index));

    personaPayments.push(
      paymentFactory.build({
        id: paymentId,
        userId,
        amount: amount.toFixed(8),
        status: 'completed',
        helcimTransactionId: `hlcm-${personaName}-${String(index + 1)}`,
        cardType: index % 2 === 0 ? 'Visa' : 'Mastercard',
        cardLastFour: String(4000 + index).slice(-4),
        createdAt: paymentDate,
        updatedAt: paymentDate,
        webhookReceivedAt: paymentDate,
      })
    );

    entries.push(
      ledgerEntryFactory.build({
        id: seedUUID(`${personaName}-tx-${String(index + 1)}`),
        walletId: purchasedWalletId,
        amount: amount.toFixed(8),
        balanceAfter: runningBalance.toFixed(8),
        entryType: 'deposit',
        paymentId,
        createdAt: paymentDate,
      })
    );
  }

  return { payments: personaPayments, ledgerEntries: entries };
}

function createCharlieConversation(
  userId: string,
  userPublicKey: Uint8Array,
  now: Date
): {
  conversation: ConversationWithId;
  messages: MessageWithId[];
  epoch: EpochWithId;
  epochMember: EpochMemberWithId;
  conversationMember: ConversationMemberWithId;
} {
  const convId = seedUUID('charlie-conv-1');
  const { epoch, epochMember, conversationMember, epochPublicKey } = createConversationEpochData(
    convId,
    userId,
    userPublicKey
  );

  const conversation = conversationFactory.build({
    id: convId,
    userId,
    title: encryptMessageForStorage(epochPublicKey, 'Charlie Conversation'),
  });
  const charlieMessages: MessageWithId[] = [];

  let charliePreviousMsgId: string | null = null;
  for (let index = 0; index < 4; index++) {
    const senderType = index % 2 === 0 ? 'user' : 'ai';
    const msgTime = new Date(now.getTime() + index * 1000);
    const msgId = seedUUID(`charlie-msg-1-${String(index + 1)}`);
    charlieMessages.push(
      messageFactory.build({
        id: msgId,
        conversationId: convId,
        encryptedBlob: encryptMessageForStorage(
          epochPublicKey,
          `Charlie message ${String(index + 1)}`
        ),
        senderType,
        senderId: senderType === 'user' ? userId : null,
        epochNumber: 1,
        sequenceNumber: index + 1,
        parentMessageId: charliePreviousMsgId,
        createdAt: msgTime,
      })
    );
    charliePreviousMsgId = msgId;
  }

  return { conversation, messages: charlieMessages, epoch, epochMember, conversationMember };
}

function createPersonaWallets(
  personaName: string,
  userId: string,
  balance: string
): {
  wallets: WalletWithId[];
  ledgerEntries: LedgerEntryWithId[];
} {
  const purchasedWalletId = seedUUID(`${personaName}-wallet-purchased`);
  const freeWalletId = seedUUID(`${personaName}-wallet-free`);

  const personaWallets: WalletWithId[] = [
    walletFactory.build({
      id: purchasedWalletId,
      userId,
      type: 'purchased',
      balance,
      priority: 0,
    }),
    walletFactory.build({
      id: freeWalletId,
      userId,
      type: 'free_tier',
      balance: FREE_ALLOWANCE_DOLLARS,
      priority: 1,
    }),
  ];

  const welcomeEntries: LedgerEntryWithId[] = [
    ledgerEntryFactory.build({
      id: seedUUID(`${personaName}-welcome-purchased`),
      walletId: purchasedWalletId,
      amount: balance,
      balanceAfter: balance,
      entryType: 'welcome_credit',
      sourceWalletId: purchasedWalletId,
    }),
    ledgerEntryFactory.build({
      id: seedUUID(`${personaName}-welcome-free`),
      walletId: freeWalletId,
      amount: FREE_ALLOWANCE_DOLLARS,
      balanceAfter: FREE_ALLOWANCE_DOLLARS,
      entryType: 'welcome_credit',
      sourceWalletId: freeWalletId,
    }),
  ];

  return { wallets: personaWallets, ledgerEntries: welcomeEntries };
}

interface ScreenshotConversationsParams {
  aliceUserId: string;
  alicePublicKey: Uint8Array;
  bobUserId: string;
  bobPublicKey: Uint8Array;
  charlieUserId: string;
  charliePublicKey: Uint8Array;
  now: Date;
}

interface ScreenshotConversationsResult {
  conversations: ConversationWithId[];
  messages: MessageWithId[];
  epochs: EpochWithId[];
  epochMembers: EpochMemberWithId[];
  conversationMembers: ConversationMemberWithId[];
}

export function createScreenshotConversations(
  params: ScreenshotConversationsParams
): ScreenshotConversationsResult {
  const allConversations: ConversationWithId[] = [];
  const allMessages: MessageWithId[] = [];
  const allEpochs: EpochWithId[] = [];
  const allEpochMembers: EpochMemberWithId[] = [];
  const allConversationMembers: ConversationMemberWithId[] = [];

  // --- Solo conversations (chat, code, mermaid, privacy) ---
  const soloConversations: { name: string; userMessage: string; aiMessage: string }[] = [
    {
      name: 'chat',
      userMessage:
        'Can you explain how async/await works in JavaScript and show me an example with error handling?',
      aiMessage:
        '## Async/Await in JavaScript\n\n`async/await` is syntactic sugar over Promises that makes asynchronous code look synchronous.\n\n### How It Works\n\n1. **`async`** keyword before a function makes it return a Promise\n2. **`await`** pauses execution until the Promise resolves\n\n### Example with Error Handling\n\n```javascript\nasync function fetchUserData(userId) {\n  try {\n    const response = await fetch(`/api/users/${userId}`);\n    if (!response.ok) {\n      throw new Error(`HTTP ${response.status}`);\n    }\n    const data = await response.json();\n    return data;\n  } catch (error) {\n    console.error("Failed to fetch user:", error.message);\n    throw error;\n  }\n}\n```\n\nThe `try/catch` block handles both network errors and HTTP error responses cleanly.',
    },
    {
      name: 'code',
      userMessage: 'Write a React hook that fetches data with loading and error states',
      aiMessage:
        'Here\'s a reusable data fetching hook:\n\n```typescript\nimport { useState, useEffect, useCallback } from "react";\n\ninterface UseFetchResult<T> {\n  data: T | null;\n  isLoading: boolean;\n  error: Error | null;\n  refetch: () => void;\n}\n\nexport function useFetch<T>(url: string): UseFetchResult<T> {\n  const [data, setData] = useState<T | null>(null);\n  const [isLoading, setIsLoading] = useState(true);\n  const [error, setError] = useState<Error | null>(null);\n\n  const fetchData = useCallback(async () => {\n    setIsLoading(true);\n    setError(null);\n    try {\n      const response = await fetch(url);\n      if (!response.ok) {\n        throw new Error(`HTTP error: ${response.status}`);\n      }\n      const result = await response.json();\n      setData(result as T);\n    } catch (err) {\n      setError(err instanceof Error ? err : new Error("Unknown error"));\n    } finally {\n      setIsLoading(false);\n    }\n  }, [url]);\n\n  useEffect(() => {\n    void fetchData();\n  }, [fetchData]);\n\n  return { data, isLoading, error, refetch: fetchData };\n}\n```\n\nUsage:\n```tsx\nconst { data, isLoading, error } = useFetch<User[]>("/api/users");\n```',
    },
    {
      name: 'mermaid',
      userMessage: 'Show me a simple flowchart for how a user signs up and verifies their email',
      aiMessage:
        "Here's the signup and email verification flow:\n\n```mermaid\nflowchart TD\n    A[User visits signup page] --> B[Fills in email & password]\n    B --> C[Clicks Sign Up]\n    C --> D[Server creates account]\n    D --> E[Verification email sent]\n    E --> F[User opens email]\n    F --> G[Clicks verification link]\n    G --> H{Token valid?}\n    H -->|Yes| I[Account verified]\n    H -->|No| J[Show error message]\n    I --> K[Redirect to dashboard]\n    J --> L[Resend verification]\n    L --> E\n```\n\nThe key steps are account creation, email delivery, and token validation. The flow handles the unhappy path where the token expires or is invalid by allowing the user to request a new verification email.",
    },
    {
      name: 'privacy',
      userMessage:
        'How does HushBox keep my conversations private? Can you or anyone else read my messages?',
      aiMessage:
        "## Encrypted at Rest, Private by Design\n\nHushBox protects your conversations with multiple layers of security.\n\n### Your Password Never Leaves Your Device\n- We use the **OPAQUE protocol** — your password is verified cryptographically without ever being transmitted to our servers\n- Not during login, not during registration, not ever\n\n### Encrypted Storage\n- Every conversation is encrypted before being stored using **XChaCha20-Poly1305**, a modern AEAD cipher\n- Encryption keys are derived from your account credentials using **Argon2id**, the gold standard for key derivation\n- Our database contains only encrypted blobs — **a database breach alone would not expose your conversations**\n\n### Pseudonymous AI Access\n- When your messages reach AI providers, they see **HushBox's credentials — not yours**\n- Providers cannot link your conversations to your identity\n- We request that providers do not store or train on your data\n\n### Your Recovery Phrase Is Your Safety Net\n- If you lose both your password and recovery phrase, your stored data is permanently inaccessible\n- We cannot recover it for you — by design, not by oversight",
    },
  ];

  for (const solo of soloConversations) {
    const convId = seedUUID(`screenshot-conv-${solo.name}`);
    const { epoch, epochMember, conversationMember, epochPublicKey } = createConversationEpochData(
      convId,
      params.aliceUserId,
      params.alicePublicKey
    );

    allConversations.push(
      conversationFactory.build({
        id: convId,
        userId: params.aliceUserId,
        title: encryptMessageForStorage(epochPublicKey, `Screenshot: ${solo.name}`),
      })
    );
    allEpochs.push(epoch);
    allEpochMembers.push(epochMember);
    allConversationMembers.push(conversationMember);

    const userMsgId = seedUUID(`screenshot-msg-${solo.name}-1`);
    const userMsgTime = new Date(params.now.getTime() + allMessages.length * 1000);
    allMessages.push(
      messageFactory.build({
        id: userMsgId,
        conversationId: convId,
        encryptedBlob: encryptMessageForStorage(epochPublicKey, solo.userMessage),
        senderType: 'user',
        senderId: params.aliceUserId,
        epochNumber: 1,
        sequenceNumber: 1,
        parentMessageId: null,
        createdAt: userMsgTime,
      })
    );

    const aiMsgTime = new Date(params.now.getTime() + allMessages.length * 1000);
    allMessages.push(
      messageFactory.build({
        id: seedUUID(`screenshot-msg-${solo.name}-2`),
        conversationId: convId,
        encryptedBlob: encryptMessageForStorage(epochPublicKey, solo.aiMessage),
        senderType: 'ai',
        senderId: null,
        epochNumber: 1,
        sequenceNumber: 2,
        parentMessageId: userMsgId,
        createdAt: aiMsgTime,
      })
    );
  }

  // --- Group chat conversation (alice, bob, charlie) ---
  const groupConvId = seedUUID('screenshot-conv-group-chat');
  const groupEpochResult = createFirstEpoch([
    params.alicePublicKey,
    params.bobPublicKey,
    params.charliePublicKey,
  ]);
  const groupEpochId = seedUUID(`${groupConvId}-epoch-1`);

  const groupEpoch = epochFactory.build({
    id: groupEpochId,
    conversationId: groupConvId,
    epochNumber: 1,
    epochPublicKey: groupEpochResult.epochPublicKey,
    confirmationHash: groupEpochResult.confirmationHash,
    chainLink: null,
  });
  allEpochs.push(groupEpoch);

  const groupMembers: { userId: string; publicKey: Uint8Array; privilege: string }[] = [
    { userId: params.aliceUserId, publicKey: params.alicePublicKey, privilege: 'owner' },
    { userId: params.bobUserId, publicKey: params.bobPublicKey, privilege: 'write' },
    { userId: params.charlieUserId, publicKey: params.charliePublicKey, privilege: 'write' },
  ];

  for (const [index, groupMember] of groupMembers.entries()) {
    const member = groupMember;
    allEpochMembers.push(
      epochMemberFactory.build({
        id: seedUUID(`${groupConvId}-epoch-member-${String(index)}`),
        epochId: groupEpochId,
        memberPublicKey: member.publicKey,
        wrap: groupEpochResult.memberWraps[index]?.wrap ?? new Uint8Array(0),
        visibleFromEpoch: 1,
      })
    );
    allConversationMembers.push(
      conversationMemberFactory.build({
        id: seedUUID(`${groupConvId}-member-${String(index)}`),
        conversationId: groupConvId,
        userId: member.userId,
        privilege: member.privilege,
        visibleFromEpoch: 1,
      })
    );
  }

  allConversations.push(
    conversationFactory.build({
      id: groupConvId,
      userId: params.aliceUserId,
      title: encryptMessageForStorage(groupEpochResult.epochPublicKey, 'Screenshot: group-chat'),
    })
  );

  const groupMessages: { senderId: string | null; senderType: string; content: string }[] = [
    {
      senderId: params.aliceUserId,
      senderType: 'user',
      content: 'Hey team, should we go with PostgreSQL or MongoDB for the new project?',
    },
    {
      senderId: params.bobUserId,
      senderType: 'user',
      content: 'PostgreSQL — we need relational integrity for the billing data',
    },
    {
      senderId: params.charlieUserId,
      senderType: 'user',
      content: 'Agreed. Plus Drizzle ORM support is excellent for Postgres',
    },
    {
      senderId: null,
      senderType: 'ai',
      content:
        "Great consensus! PostgreSQL is the right choice here. You get relational integrity for billing, excellent Drizzle ORM support, and JSONB columns for any semi-structured data you might need. It's the best of both worlds.",
    },
  ];

  let groupPreviousMsgId: string | null = null;
  for (const [index, groupMessage] of groupMessages.entries()) {
    const msg = groupMessage;
    const msgTime = new Date(params.now.getTime() + (allMessages.length + index) * 1000);
    const groupMsgId = seedUUID(`screenshot-msg-group-chat-${String(index + 1)}`);
    allMessages.push(
      messageFactory.build({
        id: groupMsgId,
        conversationId: groupConvId,
        encryptedBlob: encryptMessageForStorage(groupEpochResult.epochPublicKey, msg.content),
        senderType: msg.senderType,
        senderId: msg.senderId,
        epochNumber: 1,
        sequenceNumber: index + 1,
        parentMessageId: groupPreviousMsgId,
        createdAt: msgTime,
      })
    );
    groupPreviousMsgId = groupMsgId;
  }

  return {
    conversations: allConversations,
    messages: allMessages,
    epochs: allEpochs,
    epochMembers: allEpochMembers,
    conversationMembers: allConversationMembers,
  };
}

export async function generatePersonaData(): Promise<PersonaData> {
  const personaUsers: UserWithId[] = [];
  const personaProjects: ProjectWithId[] = [];
  const personaConversations: ConversationWithId[] = [];
  const personaMessages: MessageWithId[] = [];
  const personaPayments: PaymentWithId[] = [];
  const personaWallets: WalletWithId[] = [];
  const personaLedgerEntries: LedgerEntryWithId[] = [];
  const personaEpochs: EpochWithId[] = [];
  const personaEpochMembers: EpochMemberWithId[] = [];
  const personaConversationMembers: ConversationMemberWithId[] = [];

  const now = new Date();
  const publicKeys = new Map<string, Uint8Array>();

  for (const persona of DEV_PERSONAS) {
    const { user, publicKey } = await createPersonaUser(persona, now);
    personaUsers.push(user);
    publicKeys.set(persona.name, publicKey);

    const walletData = createPersonaWallets(persona.name, user.id, persona.balance);
    personaWallets.push(...walletData.wallets);
    personaLedgerEntries.push(...walletData.ledgerEntries);

    if (persona.hasSampleData) {
      const sampleData = createPersonaSampleData(persona.name, user.id, publicKey, now);
      personaProjects.push(...sampleData.projects);
      personaConversations.push(...sampleData.conversations);
      personaMessages.push(...sampleData.messages);
      personaEpochs.push(...sampleData.epochs);
      personaEpochMembers.push(...sampleData.epochMembers);
      personaConversationMembers.push(...sampleData.conversationMembers);

      const purchasedWalletId = seedUUID(`${persona.name}-wallet-purchased`);
      const paymentData = createPersonaPayments(persona.name, user.id, purchasedWalletId, now);
      personaPayments.push(...paymentData.payments);
      personaLedgerEntries.push(...paymentData.ledgerEntries);
    }

    if (persona.name === 'charlie') {
      const charlieData = createCharlieConversation(user.id, publicKey, now);
      personaConversations.push(charlieData.conversation);
      personaMessages.push(...charlieData.messages);
      personaEpochs.push(charlieData.epoch);
      personaEpochMembers.push(charlieData.epochMember);
      personaConversationMembers.push(charlieData.conversationMember);
    }
  }

  // Screenshot conversations for store screenshots (alice + group with bob, charlie)
  const aliceUser = personaUsers.find((u) => u.id === seedUUID('dev-user-alice'));
  const bobUser = personaUsers.find((u) => u.id === seedUUID('dev-user-bob'));
  const charlieUser = personaUsers.find((u) => u.id === seedUUID('dev-user-charlie'));

  if (aliceUser && bobUser && charlieUser) {
    const screenshotData = createScreenshotConversations({
      aliceUserId: aliceUser.id,
      alicePublicKey: publicKeys.get('alice') ?? aliceUser.publicKey,
      bobUserId: bobUser.id,
      bobPublicKey: publicKeys.get('bob') ?? bobUser.publicKey,
      charlieUserId: charlieUser.id,
      charliePublicKey: publicKeys.get('charlie') ?? charlieUser.publicKey,
      now,
    });
    personaConversations.push(...screenshotData.conversations);
    personaMessages.push(...screenshotData.messages);
    personaEpochs.push(...screenshotData.epochs);
    personaEpochMembers.push(...screenshotData.epochMembers);
    personaConversationMembers.push(...screenshotData.conversationMembers);
  }

  return {
    users: personaUsers,
    projects: personaProjects,
    conversations: personaConversations,
    messages: personaMessages,
    payments: personaPayments,
    wallets: personaWallets,
    ledgerEntries: personaLedgerEntries,
    epochs: personaEpochs,
    epochMembers: personaEpochMembers,
    conversationMembers: personaConversationMembers,
  };
}

async function createTestPersonaUser(
  persona: (typeof TEST_PERSONAS)[number],
  now: Date
): Promise<{ user: UserWithId; publicKey: Uint8Array }> {
  const userId = seedUUID(`test-user-${persona.name}`);
  const email = testEmail(persona.name);
  const crypto = await createOpaqueUserCrypto(DEV_PASSWORD, userId);

  let totpEnabled = false;
  let totpSecretEncrypted: Uint8Array | null = null;

  if (persona.totpSecret) {
    const masterSecret = resolveRaw(envConfig.OPAQUE_MASTER_SECRET, Mode.Development) as string;
    const masterSecretBytes = new TextEncoder().encode(masterSecret);
    const totpKey = deriveTotpEncryptionKey(masterSecretBytes);
    totpSecretEncrypted = encryptTotpSecret(persona.totpSecret, totpKey);
    totpEnabled = true;
  }

  const user: UserWithId = {
    id: userId,
    email,
    username: normalizeUsername(persona.displayName),
    emailVerified: persona.emailVerified,
    hasAcknowledgedPhrase: true,
    createdAt: now,
    updatedAt: now,
    opaqueRegistration: crypto.opaqueRegistration,
    publicKey: crypto.publicKey,
    passwordWrappedPrivateKey: crypto.passwordWrappedPrivateKey,
    recoveryWrappedPrivateKey: crypto.recoveryWrappedPrivateKey,
    totpEnabled,
    totpSecretEncrypted,
  };

  return { user, publicKey: crypto.publicKey };
}

function createTestSampleData(
  personaName: string,
  userId: string,
  userPublicKey: Uint8Array
): {
  projects: ProjectWithId[];
  conversations: ConversationWithId[];
  messages: MessageWithId[];
  epochs: EpochWithId[];
  epochMembers: EpochMemberWithId[];
  conversationMembers: ConversationMemberWithId[];
} {
  const testProjects: ProjectWithId[] = [];
  const testConversations: ConversationWithId[] = [];
  const testMessages: MessageWithId[] = [];
  const testEpochs: EpochWithId[] = [];
  const testEpochMembers: EpochMemberWithId[] = [];
  const testConversationMembers: ConversationMemberWithId[] = [];

  for (let index = 0; index < 2; index++) {
    testProjects.push(
      projectFactory.build({
        id: seedUUID(`${personaName}-project-${String(index + 1)}`),
        userId,
        encryptedName: encryptMessageForStorage(
          userPublicKey,
          `${personaName} Project ${String(index + 1)}`
        ),
        encryptedDescription: null,
      })
    );
  }

  for (let index = 0; index < 3; index++) {
    const convId = seedUUID(`${personaName}-conv-${String(index + 1)}`);
    const { epoch, epochMember, conversationMember, epochPublicKey } = createConversationEpochData(
      convId,
      userId,
      userPublicKey
    );

    testConversations.push(
      conversationFactory.build({
        id: convId,
        userId,
        title: encryptMessageForStorage(
          epochPublicKey,
          `${personaName} Conversation ${String(index + 1)}`
        ),
      })
    );
    testEpochs.push(epoch);
    testEpochMembers.push(epochMember);
    testConversationMembers.push(conversationMember);

    const messageCount = 3 + (index % 3);
    let testPreviousMsgId: string | null = null;
    for (let msgIndex = 0; msgIndex < messageCount; msgIndex++) {
      const senderType = msgIndex % 2 === 0 ? 'user' : 'ai';
      const msgId = seedUUID(`${personaName}-msg-${String(index + 1)}-${String(msgIndex + 1)}`);
      testMessages.push(
        messageFactory.build({
          id: msgId,
          conversationId: convId,
          encryptedBlob: encryptMessageForStorage(
            epochPublicKey,
            `${personaName} message ${String(index + 1)}-${String(msgIndex + 1)}`
          ),
          senderType,
          senderId: senderType === 'user' ? userId : null,
          epochNumber: 1,
          sequenceNumber: msgIndex + 1,
          parentMessageId: testPreviousMsgId,
        })
      );
      testPreviousMsgId = msgId;
    }
  }

  return {
    projects: testProjects,
    conversations: testConversations,
    messages: testMessages,
    epochs: testEpochs,
    epochMembers: testEpochMembers,
    conversationMembers: testConversationMembers,
  };
}

function createTestPaymentData(
  personaName: string,
  userId: string,
  purchasedWalletId: string,
  now: Date
): { payment: PaymentWithId; ledgerEntry: LedgerEntryWithId } {
  const paymentId = seedUUID(`${personaName}-payment-1`);
  const amount = 100;

  const payment = paymentFactory.build({
    id: paymentId,
    userId,
    amount: amount.toFixed(8),
    status: 'completed',
    helcimTransactionId: `hlcm-${personaName}-1`,
    cardType: 'Visa',
    cardLastFour: '4242',
    createdAt: now,
    updatedAt: now,
    webhookReceivedAt: now,
  });

  const ledgerEntry = ledgerEntryFactory.build({
    id: seedUUID(`${personaName}-tx-1`),
    walletId: purchasedWalletId,
    amount: amount.toFixed(8),
    balanceAfter: amount.toFixed(8),
    entryType: 'deposit',
    paymentId,
    createdAt: now,
  });

  return { payment, ledgerEntry };
}

export async function generateTestPersonaData(): Promise<PersonaData> {
  const testUsers: UserWithId[] = [];
  const testProjects: ProjectWithId[] = [];
  const testConversations: ConversationWithId[] = [];
  const testMessages: MessageWithId[] = [];
  const testPayments: PaymentWithId[] = [];
  const testWallets: WalletWithId[] = [];
  const testLedgerEntries: LedgerEntryWithId[] = [];
  const testEpochs: EpochWithId[] = [];
  const testEpochMembers: EpochMemberWithId[] = [];
  const testConversationMembers: ConversationMemberWithId[] = [];

  const now = new Date();

  for (const persona of TEST_PERSONAS) {
    const { user, publicKey } = await createTestPersonaUser(persona, now);
    testUsers.push(user);

    const balance = persona.hasSampleData ? '10000.00000000' : '0.00000000';
    const walletData = createPersonaWallets(persona.name, user.id, balance);
    testWallets.push(...walletData.wallets);
    testLedgerEntries.push(...walletData.ledgerEntries);

    if (persona.hasSampleData) {
      const sampleData = createTestSampleData(persona.name, user.id, publicKey);
      testProjects.push(...sampleData.projects);
      testConversations.push(...sampleData.conversations);
      testMessages.push(...sampleData.messages);
      testEpochs.push(...sampleData.epochs);
      testEpochMembers.push(...sampleData.epochMembers);
      testConversationMembers.push(...sampleData.conversationMembers);

      const purchasedWalletId = seedUUID(`${persona.name}-wallet-purchased`);
      const paymentData = createTestPaymentData(persona.name, user.id, purchasedWalletId, now);
      testPayments.push(paymentData.payment);
      testLedgerEntries.push(paymentData.ledgerEntry);
    }
  }

  return {
    users: testUsers,
    projects: testProjects,
    conversations: testConversations,
    messages: testMessages,
    payments: testPayments,
    wallets: testWallets,
    ledgerEntries: testLedgerEntries,
    epochs: testEpochs,
    epochMembers: testEpochMembers,
    conversationMembers: testConversationMembers,
  };
}

type DbClient = ReturnType<typeof createDb>;
type Table =
  | typeof users
  | typeof conversations
  | typeof messages
  | typeof projects
  | typeof payments
  | typeof wallets
  | typeof ledgerEntries
  | typeof epochs
  | typeof epochMembers
  | typeof conversationMembers;

export async function upsertEntity(
  db: DbClient,
  table: Table,
  data: { id: string }
): Promise<'created' | 'updated'> {
  const existing = await db.select().from(table).where(eq(table.id, data.id)).limit(1);

  if (existing.length === 0) {
    await db.insert(table).values(data);
    return 'created';
  }

  // eslint-disable-next-line sonarjs/no-unused-vars -- destructure to exclude id from update
  const { id: _id, ...rest } = data;
  await db.update(table).set(rest).where(eq(table.id, data.id));
  return 'updated';
}

interface UpsertResult {
  created: number;
  updated: number;
}

async function upsertEntities(
  db: DbClient,
  table: Table,
  entities: { id: string }[]
): Promise<UpsertResult> {
  let created = 0;
  let updated = 0;
  for (const entity of entities) {
    const result = await upsertEntity(db, table, entity);
    if (result === 'created') created++;
    else updated++;
  }
  return { created, updated };
}

function logUpsertResult(entityName: string, result: UpsertResult): void {
  console.log(
    `${entityName}: ${String(result.created)} created, ${String(result.updated)} updated`
  );
}

export async function seed(): Promise<void> {
  if (!process.env['DATABASE_URL']) {
    const envPath = path.resolve(process.cwd(), '.env.development');
    config({ path: envPath });
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const db = createDb({
    connectionString: databaseUrl,
    neonDev: LOCAL_NEON_DEV_CONFIG,
  });

  const data = generateSeedData();
  const personaData = await generatePersonaData();
  const testPersonaData = await generateTestPersonaData();

  console.log('Seeding database...');
  console.log('');
  console.log('Dev Personas:');
  console.log(`  Users: ${String(personaData.users.length)}`);
  console.log(`  Wallets: ${String(personaData.wallets.length)}`);
  console.log(`  Projects: ${String(personaData.projects.length)}`);
  console.log(`  Conversations: ${String(personaData.conversations.length)}`);
  console.log(`  ConversationMembers: ${String(personaData.conversationMembers.length)}`);
  console.log(`  Epochs: ${String(personaData.epochs.length)}`);
  console.log(`  EpochMembers: ${String(personaData.epochMembers.length)}`);
  console.log(`  Messages: ${String(personaData.messages.length)}`);
  console.log(`  Payments: ${String(personaData.payments.length)}`);
  console.log(`  Ledger Entries: ${String(personaData.ledgerEntries.length)}`);
  console.log('');
  console.log('Test Personas:');
  console.log(`  Users: ${String(testPersonaData.users.length)}`);
  console.log(`  Wallets: ${String(testPersonaData.wallets.length)}`);
  console.log(`  Projects: ${String(testPersonaData.projects.length)}`);
  console.log(`  Conversations: ${String(testPersonaData.conversations.length)}`);
  console.log(`  ConversationMembers: ${String(testPersonaData.conversationMembers.length)}`);
  console.log(`  Epochs: ${String(testPersonaData.epochs.length)}`);
  console.log(`  EpochMembers: ${String(testPersonaData.epochMembers.length)}`);
  console.log(`  Messages: ${String(testPersonaData.messages.length)}`);
  console.log(`  Payments: ${String(testPersonaData.payments.length)}`);
  console.log(`  Ledger Entries: ${String(testPersonaData.ledgerEntries.length)}`);
  console.log('');
  console.log('Random Seed Data:');
  console.log(`  Users: ${String(data.users.length)}`);
  console.log(`  Projects: ${String(data.projects.length)}`);
  console.log(`  Conversations: ${String(data.conversations.length)}`);
  console.log(`  Epochs: ${String(data.epochs.length)}`);
  console.log(`  Messages: ${String(data.messages.length)}`);
  console.log('');

  // 1. Users
  const personaUserResult = await upsertEntities(db, users, [
    ...personaData.users,
    ...testPersonaData.users,
  ]);
  logUpsertResult('Persona Users', personaUserResult);

  const randomUserResult = await upsertEntities(db, users, data.users);
  logUpsertResult('Random Users', randomUserResult);

  // 2. Wallets (depends on users)
  const walletResult = await upsertEntities(db, wallets, [
    ...personaData.wallets,
    ...testPersonaData.wallets,
  ]);
  logUpsertResult('Wallets', walletResult);

  // 3. Projects
  const projectResult = await upsertEntities(db, projects, [
    ...personaData.projects,
    ...testPersonaData.projects,
    ...data.projects,
  ]);
  logUpsertResult('Projects', projectResult);

  // 4. Conversations
  const conversationResult = await upsertEntities(db, conversations, [
    ...personaData.conversations,
    ...testPersonaData.conversations,
    ...data.conversations,
  ]);
  logUpsertResult('Conversations', conversationResult);

  // 5. ConversationMembers (depends on conversations + users)
  const conversationMemberResult = await upsertEntities(db, conversationMembers, [
    ...personaData.conversationMembers,
    ...testPersonaData.conversationMembers,
    ...data.conversationMembers,
  ]);
  logUpsertResult('ConversationMembers', conversationMemberResult);

  // 6. Epochs (depends on conversations)
  const epochResult = await upsertEntities(db, epochs, [
    ...personaData.epochs,
    ...testPersonaData.epochs,
    ...data.epochs,
  ]);
  logUpsertResult('Epochs', epochResult);

  // 7. EpochMembers (depends on epochs)
  const epochMemberResult = await upsertEntities(db, epochMembers, [
    ...personaData.epochMembers,
    ...testPersonaData.epochMembers,
    ...data.epochMembers,
  ]);
  logUpsertResult('EpochMembers', epochMemberResult);

  // 8. Messages (depends on conversations)
  const messageResult = await upsertEntities(db, messages, [
    ...personaData.messages,
    ...testPersonaData.messages,
    ...data.messages,
  ]);
  logUpsertResult('Messages', messageResult);

  // 9. Payments (depends on users)
  const paymentResult = await upsertEntities(db, payments, [
    ...personaData.payments,
    ...testPersonaData.payments,
  ]);
  logUpsertResult('Payments', paymentResult);

  // 10. LedgerEntries (depends on wallets + payments)
  const ledgerEntryResult = await upsertEntities(db, ledgerEntries, [
    ...personaData.ledgerEntries,
    ...testPersonaData.ledgerEntries,
  ]);
  logUpsertResult('Ledger Entries', ledgerEntryResult);

  console.log('\nSeed complete!');
}

const isMain = import.meta.url === `file://${String(process.argv[1])}`;
if (isMain) {
  void (async () => {
    try {
      await seed();
    } catch (error: unknown) {
      console.error('Seed failed:', error);
      process.exit(1);
    }
  })();
}
