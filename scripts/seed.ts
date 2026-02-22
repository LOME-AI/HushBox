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
  getServerIdentifier,
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
  const masterSecret = resolveRaw(envConfig.OPAQUE_MASTER_SECRET, Mode.Development) as string;
  const frontendUrl = resolveRaw(envConfig.FRONTEND_URL, Mode.Development) as string;

  // 1. OPAQUE registration (client <-> server protocol)
  const masterSecretBytes = new TextEncoder().encode(masterSecret);
  const serverIdentifier = getServerIdentifier(frontendUrl);
  const opaqueServer = await createOpaqueServer(masterSecretBytes, serverIdentifier);

  const client = createOpaqueClient();
  const { serialized } = await startRegistration(client, password);

  const request = OpaqueRegistrationRequest.deserialize(OpaqueClientConfig, serialized);
  const serverResult = await opaqueServer.registerInit(request, credentialIdentifier);
  if (serverResult instanceof Error) throw serverResult;

  const { record, exportKey } = await finishRegistration(
    client,
    serverResult.serialize(),
    serverIdentifier
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
    displayName: 'Alice Developer',
    emailVerified: true,
    hasSampleData: true,
    balance: '100.00000000',
  },
  {
    name: 'bob',
    displayName: 'Bob Tester',
    emailVerified: true,
    hasSampleData: false,
    balance: '0.20000000',
  },
  {
    name: 'charlie',
    displayName: 'Charlie Verified',
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
  const userPublicKey = user.publicKey;
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

    for (let msgIndex = 0; msgIndex < SEED_CONFIG.MESSAGES_PER_CONVERSATION; msgIndex++) {
      const senderType = msgIndex % 2 === 0 ? 'user' : 'ai';
      allMessages.push(
        messageFactory.build({
          id: seedUUID(
            `seed-msg-${String(userIndex + 1)}-${String(convIndex + 1)}-${String(msgIndex + 1)}`
          ),
          conversationId: convId,
          encryptedBlob: encryptMessageForStorage(
            epochPublicKey,
            `Sample message ${String(msgIndex + 1)}`
          ),
          senderType,
          senderId: senderType === 'user' ? userId : null,
          epochNumber: 1,
          sequenceNumber: msgIndex + 1,
        })
      );
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

    sampleConversations.push(
      conversationFactory.build({
        id: convId,
        userId,
        title: encryptMessageForStorage(
          epochPublicKey,
          `${personaName} Conversation ${String(convIndex + 1)}`
        ),
      })
    );
    sampleEpochs.push(epoch);
    sampleEpochMembers.push(epochMember);
    sampleConversationMembers.push(conversationMember);

    const messageCount = 3 + (convIndex % 3);
    for (let msgIndex = 0; msgIndex < messageCount; msgIndex++) {
      const senderType = msgIndex % 2 === 0 ? 'user' : 'ai';
      const msgTime = new Date(now.getTime() + convIndex * 10_000 + msgIndex * 1000);
      sampleMessages.push(
        messageFactory.build({
          id: seedUUID(`${personaName}-msg-${String(convIndex + 1)}-${String(msgIndex + 1)}`),
          conversationId: convId,
          encryptedBlob: encryptMessageForStorage(
            epochPublicKey,
            `${personaName} message ${String(convIndex + 1)}-${String(msgIndex + 1)}`
          ),
          senderType,
          senderId: senderType === 'user' ? userId : null,
          epochNumber: 1,
          sequenceNumber: msgIndex + 1,
          createdAt: msgTime,
        })
      );
    }
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

  for (let index = 0; index < 4; index++) {
    const senderType = index % 2 === 0 ? 'user' : 'ai';
    const msgTime = new Date(now.getTime() + index * 1000);
    charlieMessages.push(
      messageFactory.build({
        id: seedUUID(`charlie-msg-1-${String(index + 1)}`),
        conversationId: convId,
        encryptedBlob: encryptMessageForStorage(
          epochPublicKey,
          `Charlie message ${String(index + 1)}`
        ),
        senderType,
        senderId: senderType === 'user' ? userId : null,
        epochNumber: 1,
        sequenceNumber: index + 1,
        createdAt: msgTime,
      })
    );
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

  for (const persona of DEV_PERSONAS) {
    const { user, publicKey } = await createPersonaUser(persona, now);
    personaUsers.push(user);

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
    for (let msgIndex = 0; msgIndex < messageCount; msgIndex++) {
      const senderType = msgIndex % 2 === 0 ? 'user' : 'ai';
      testMessages.push(
        messageFactory.build({
          id: seedUUID(`${personaName}-msg-${String(index + 1)}-${String(msgIndex + 1)}`),
          conversationId: convId,
          encryptedBlob: encryptMessageForStorage(
            epochPublicKey,
            `${personaName} message ${String(index + 1)}-${String(msgIndex + 1)}`
          ),
          senderType,
          senderId: senderType === 'user' ? userId : null,
          epochNumber: 1,
          sequenceNumber: msgIndex + 1,
        })
      );
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

    const balance = persona.hasSampleData ? '100.00000000' : '0.00000000';
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
): Promise<'created' | 'exists'> {
  const existing = await db.select().from(table).where(eq(table.id, data.id)).limit(1);

  if (existing.length === 0) {
    await db.insert(table).values(data);
    return 'created';
  }
  return 'exists';
}

interface UpsertResult {
  created: number;
  exists: number;
}

async function upsertEntities(
  db: DbClient,
  table: Table,
  entities: { id: string }[]
): Promise<UpsertResult> {
  let created = 0;
  let exists = 0;
  for (const entity of entities) {
    const result = await upsertEntity(db, table, entity);
    if (result === 'created') created++;
    else exists++;
  }
  return { created, exists };
}

function logUpsertResult(entityName: string, result: UpsertResult): void {
  console.log(
    `${entityName}: ${String(result.created)} created, ${String(result.exists)} already existed`
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
