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
  accounts,
  payments,
  balanceTransactions,
  hashPassword,
} from '@lome-chat/db';
import {
  userFactory,
  conversationFactory,
  messageFactory,
  projectFactory,
  paymentFactory,
  balanceTransactionFactory,
} from '@lome-chat/db/factories';
import { DEV_PASSWORD, DEV_EMAIL_DOMAIN, TEST_EMAIL_DOMAIN } from '@lome-chat/shared';

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

export const TEST_PERSONAS = [
  {
    name: 'test-alice',
    displayName: 'Test Alice',
    emailVerified: true,
    hasSampleData: true,
  },
  {
    name: 'test-bob',
    displayName: 'Test Bob',
    emailVerified: true,
    hasSampleData: false,
  },
  {
    name: 'test-charlie',
    displayName: 'Test Charlie',
    emailVerified: false,
    hasSampleData: false,
  },
  // Dedicated billing test users (isolated to avoid balance state bleeding between tests)
  {
    name: 'test-billing-success',
    displayName: 'Test Billing Success',
    emailVerified: true,
    hasSampleData: false,
  },
  {
    name: 'test-billing-failure',
    displayName: 'Test Billing Failure',
    emailVerified: true,
    hasSampleData: false,
  },
  {
    name: 'test-billing-validation',
    displayName: 'Test Billing Validation',
    emailVerified: true,
    hasSampleData: false,
  },
  {
    name: 'test-billing-success-2',
    displayName: 'Test Billing Success 2',
    emailVerified: true,
    hasSampleData: false,
  },
  {
    name: 'test-billing-devmode',
    displayName: 'Test Billing Dev Mode',
    emailVerified: true,
    hasSampleData: false,
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
type Account = typeof accounts.$inferInsert;
type Payment = typeof payments.$inferInsert;
type BalanceTransaction = typeof balanceTransactions.$inferInsert;

// Types with required id for seeding (factories always generate ids)
type UserWithId = User & { id: string };
type ConversationWithId = Conversation & { id: string };
type MessageWithId = Message & { id: string };
type ProjectWithId = Project & { id: string };
type AccountWithId = Account & { id: string };
type PaymentWithId = Payment & { id: string };
type BalanceTransactionWithId = BalanceTransaction & { id: string };

interface SeedData {
  users: UserWithId[];
  projects: ProjectWithId[];
  conversations: ConversationWithId[];
  messages: MessageWithId[];
}

interface PersonaData {
  users: UserWithId[];
  accounts: AccountWithId[];
  projects: ProjectWithId[];
  conversations: ConversationWithId[];
  messages: MessageWithId[];
  payments: PaymentWithId[];
  balanceTransactions: BalanceTransactionWithId[];
}

interface UserEntities {
  user: UserWithId;
  projects: ProjectWithId[];
  conversations: ConversationWithId[];
  messages: MessageWithId[];
}

function generateUserEntities(userIndex: number): UserEntities {
  const userId = seedUUID(`seed-user-${String(userIndex + 1)}`);
  const user = userFactory.build({ id: userId });
  const projects: ProjectWithId[] = [];
  const conversations: ConversationWithId[] = [];
  const messages: MessageWithId[] = [];

  for (let projectIndex = 0; projectIndex < SEED_CONFIG.PROJECTS_PER_USER; projectIndex++) {
    projects.push(
      projectFactory.build({
        id: seedUUID(`seed-project-${String(userIndex + 1)}-${String(projectIndex + 1)}`),
        userId,
      })
    );
  }

  for (let convIndex = 0; convIndex < SEED_CONFIG.CONVERSATIONS_PER_USER; convIndex++) {
    const convId = seedUUID(`seed-conv-${String(userIndex + 1)}-${String(convIndex + 1)}`);
    conversations.push(conversationFactory.build({ id: convId, userId }));

    for (let msgIndex = 0; msgIndex < SEED_CONFIG.MESSAGES_PER_CONVERSATION; msgIndex++) {
      const role = msgIndex % 2 === 0 ? 'user' : 'assistant';
      messages.push(
        messageFactory.build({
          id: seedUUID(
            `seed-msg-${String(userIndex + 1)}-${String(convIndex + 1)}-${String(msgIndex + 1)}`
          ),
          conversationId: convId,
          role,
          model: role === 'assistant' ? 'gpt-4' : null,
        })
      );
    }
  }

  return { user, projects, conversations, messages };
}

export function generateSeedData(): SeedData {
  const seedUsers: UserWithId[] = [];
  const seedProjects: ProjectWithId[] = [];
  const seedConversations: ConversationWithId[] = [];
  const seedMessages: MessageWithId[] = [];

  for (let index = 0; index < SEED_CONFIG.USER_COUNT; index++) {
    const entities = generateUserEntities(index);
    seedUsers.push(entities.user);
    seedProjects.push(...entities.projects);
    seedConversations.push(...entities.conversations);
    seedMessages.push(...entities.messages);
  }

  return {
    users: seedUsers,
    projects: seedProjects,
    conversations: seedConversations,
    messages: seedMessages,
  };
}

function createPersonaUser(
  persona: (typeof DEV_PERSONAS)[number],
  hashedPassword: string,
  now: Date
): { user: UserWithId; account: AccountWithId } {
  const userId = seedUUID(`dev-user-${persona.name}`);
  const email = devEmail(persona.name);

  const user: UserWithId = {
    id: userId,
    email,
    name: persona.displayName,
    emailVerified: persona.emailVerified,
    image: null,
    balance: persona.balance,
    createdAt: now,
    updatedAt: now,
  };

  const account: AccountWithId = {
    id: seedUUID(`account-${persona.name}`),
    userId,
    accountId: email,
    providerId: 'credential',
    password: hashedPassword,
    accessToken: null,
    refreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scope: null,
    idToken: null,
    createdAt: now,
    updatedAt: now,
  };

  return { user, account };
}

function createPersonaSampleData(
  personaName: string,
  userId: string,
  now: Date
): {
  projects: ProjectWithId[];
  conversations: ConversationWithId[];
  messages: MessageWithId[];
} {
  const projects: ProjectWithId[] = [];
  const conversations: ConversationWithId[] = [];
  const messages: MessageWithId[] = [];

  for (let projectIndex = 0; projectIndex < 2; projectIndex++) {
    projects.push(
      projectFactory.build({
        id: seedUUID(`${personaName}-project-${String(projectIndex + 1)}`),
        userId,
      })
    );
  }

  for (let convIndex = 0; convIndex < 3; convIndex++) {
    const convId = seedUUID(`${personaName}-conv-${String(convIndex + 1)}`);
    conversations.push(conversationFactory.build({ id: convId, userId }));

    const messageCount = 3 + (convIndex % 3);
    for (let msgIndex = 0; msgIndex < messageCount; msgIndex++) {
      const role = msgIndex % 2 === 0 ? 'user' : 'assistant';
      const msgTime = new Date(now.getTime() + convIndex * 10_000 + msgIndex * 1000);
      messages.push(
        messageFactory.build({
          id: seedUUID(`${personaName}-msg-${String(convIndex + 1)}-${String(msgIndex + 1)}`),
          conversationId: convId,
          role,
          model: role === 'assistant' ? 'gpt-4' : null,
          createdAt: msgTime,
        })
      );
    }
  }

  return { projects, conversations, messages };
}

function createPersonaPayments(
  personaName: string,
  userId: string,
  now: Date
): { payments: PaymentWithId[]; transactions: BalanceTransactionWithId[] } {
  const payments: PaymentWithId[] = [];
  const transactions: BalanceTransactionWithId[] = [];
  let runningBalance = 0;

  for (let index = 0; index < 14; index++) {
    const paymentId = seedUUID(`${personaName}-payment-${String(index + 1)}`);
    const baseAmount = 5 + (index % 5);
    const amount = index === 13 ? baseAmount + 4 : baseAmount;
    runningBalance += amount;

    const paymentDate = new Date(now);
    paymentDate.setDate(paymentDate.getDate() - (14 - index));

    payments.push(
      paymentFactory.build({
        id: paymentId,
        userId,
        amount: amount.toFixed(8),
        status: 'confirmed',
        helcimTransactionId: `hlcm-${personaName}-${String(index + 1)}`,
        cardType: index % 2 === 0 ? 'Visa' : 'Mastercard',
        cardLastFour: String(4000 + index).slice(-4),
        createdAt: paymentDate,
        updatedAt: paymentDate,
        webhookReceivedAt: paymentDate,
      })
    );

    transactions.push(
      balanceTransactionFactory.build({
        id: seedUUID(`${personaName}-tx-${String(index + 1)}`),
        userId,
        amount: amount.toFixed(8),
        balanceAfter: runningBalance.toFixed(8),
        type: 'deposit',
        paymentId,
        createdAt: paymentDate,
      })
    );
  }

  return { payments, transactions };
}

function createCharlieConversation(
  userId: string,
  now: Date
): { conversation: ConversationWithId; messages: MessageWithId[] } {
  const convId = seedUUID('charlie-conv-1');
  const conversation = conversationFactory.build({ id: convId, userId });
  const messages: MessageWithId[] = [];

  for (let index = 0; index < 4; index++) {
    const role = index % 2 === 0 ? 'user' : 'assistant';
    const msgTime = new Date(now.getTime() + index * 1000);
    messages.push(
      messageFactory.build({
        id: seedUUID(`charlie-msg-1-${String(index + 1)}`),
        conversationId: convId,
        role,
        model: role === 'assistant' ? 'gpt-4' : null,
        createdAt: msgTime,
      })
    );
  }

  return { conversation, messages };
}

export async function generatePersonaData(): Promise<PersonaData> {
  const personaUsers: UserWithId[] = [];
  const personaAccounts: AccountWithId[] = [];
  const personaProjects: ProjectWithId[] = [];
  const personaConversations: ConversationWithId[] = [];
  const personaMessages: MessageWithId[] = [];
  const personaPayments: PaymentWithId[] = [];
  const personaBalanceTransactions: BalanceTransactionWithId[] = [];

  const hashedPassword = await hashPassword(DEV_PASSWORD);
  const now = new Date();

  for (const persona of DEV_PERSONAS) {
    const { user, account } = createPersonaUser(persona, hashedPassword, now);
    personaUsers.push(user);
    personaAccounts.push(account);

    if (persona.hasSampleData) {
      const sampleData = createPersonaSampleData(persona.name, user.id, now);
      personaProjects.push(...sampleData.projects);
      personaConversations.push(...sampleData.conversations);
      personaMessages.push(...sampleData.messages);

      const paymentData = createPersonaPayments(persona.name, user.id, now);
      personaPayments.push(...paymentData.payments);
      personaBalanceTransactions.push(...paymentData.transactions);
    }

    if (persona.name === 'charlie') {
      const charlieData = createCharlieConversation(user.id, now);
      personaConversations.push(charlieData.conversation);
      personaMessages.push(...charlieData.messages);
    }
  }

  return {
    users: personaUsers,
    accounts: personaAccounts,
    projects: personaProjects,
    conversations: personaConversations,
    messages: personaMessages,
    payments: personaPayments,
    balanceTransactions: personaBalanceTransactions,
  };
}

function createTestPersonaUser(
  persona: (typeof TEST_PERSONAS)[number],
  hashedPassword: string,
  now: Date
): { user: UserWithId; account: AccountWithId } {
  const userId = seedUUID(`test-user-${persona.name}`);
  const email = testEmail(persona.name);
  const balance = persona.hasSampleData ? '100.00000000' : '0.00000000';

  const user: UserWithId = {
    id: userId,
    email,
    name: persona.displayName,
    emailVerified: persona.emailVerified,
    image: null,
    balance,
    createdAt: now,
    updatedAt: now,
  };

  const account: AccountWithId = {
    id: seedUUID(`test-account-${persona.name}`),
    userId,
    accountId: email,
    providerId: 'credential',
    password: hashedPassword,
    accessToken: null,
    refreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scope: null,
    idToken: null,
    createdAt: now,
    updatedAt: now,
  };

  return { user, account };
}

function createTestSampleData(
  personaName: string,
  userId: string
): {
  projects: ProjectWithId[];
  conversations: ConversationWithId[];
  messages: MessageWithId[];
} {
  const projects: ProjectWithId[] = [];
  const conversations: ConversationWithId[] = [];
  const messages: MessageWithId[] = [];

  for (let index = 0; index < 2; index++) {
    projects.push(
      projectFactory.build({
        id: seedUUID(`${personaName}-project-${String(index + 1)}`),
        userId,
      })
    );
  }

  for (let index = 0; index < 3; index++) {
    const convId = seedUUID(`${personaName}-conv-${String(index + 1)}`);
    conversations.push(conversationFactory.build({ id: convId, userId }));

    const messageCount = 3 + (index % 3);
    for (let msgIndex = 0; msgIndex < messageCount; msgIndex++) {
      const role = msgIndex % 2 === 0 ? 'user' : 'assistant';
      messages.push(
        messageFactory.build({
          id: seedUUID(`${personaName}-msg-${String(index + 1)}-${String(msgIndex + 1)}`),
          conversationId: convId,
          role,
          model: role === 'assistant' ? 'gpt-4' : null,
        })
      );
    }
  }

  return { projects, conversations, messages };
}

function createTestPaymentData(
  personaName: string,
  userId: string,
  now: Date
): { payment: PaymentWithId; transaction: BalanceTransactionWithId } {
  const paymentId = seedUUID(`${personaName}-payment-1`);
  const amount = 100;

  const payment = paymentFactory.build({
    id: paymentId,
    userId,
    amount: amount.toFixed(8),
    status: 'confirmed',
    helcimTransactionId: `hlcm-${personaName}-1`,
    cardType: 'Visa',
    cardLastFour: '4242',
    createdAt: now,
    updatedAt: now,
    webhookReceivedAt: now,
  });

  const transaction = balanceTransactionFactory.build({
    id: seedUUID(`${personaName}-tx-1`),
    userId,
    amount: amount.toFixed(8),
    balanceAfter: amount.toFixed(8),
    type: 'deposit',
    paymentId,
    createdAt: now,
  });

  return { payment, transaction };
}

export async function generateTestPersonaData(): Promise<PersonaData> {
  const testUsers: UserWithId[] = [];
  const testAccounts: AccountWithId[] = [];
  const testProjects: ProjectWithId[] = [];
  const testConversations: ConversationWithId[] = [];
  const testMessages: MessageWithId[] = [];
  const testPayments: PaymentWithId[] = [];
  const testBalanceTransactions: BalanceTransactionWithId[] = [];

  const hashedPassword = await hashPassword(DEV_PASSWORD);
  const now = new Date();

  for (const persona of TEST_PERSONAS) {
    const { user, account } = createTestPersonaUser(persona, hashedPassword, now);
    testUsers.push(user);
    testAccounts.push(account);

    if (persona.hasSampleData) {
      const sampleData = createTestSampleData(persona.name, user.id);
      testProjects.push(...sampleData.projects);
      testConversations.push(...sampleData.conversations);
      testMessages.push(...sampleData.messages);

      const paymentData = createTestPaymentData(persona.name, user.id, now);
      testPayments.push(paymentData.payment);
      testBalanceTransactions.push(paymentData.transaction);
    }
  }

  return {
    users: testUsers,
    accounts: testAccounts,
    projects: testProjects,
    conversations: testConversations,
    messages: testMessages,
    payments: testPayments,
    balanceTransactions: testBalanceTransactions,
  };
}

type DbClient = ReturnType<typeof createDb>;
type Table =
  | typeof users
  | typeof conversations
  | typeof messages
  | typeof projects
  | typeof accounts
  | typeof payments
  | typeof balanceTransactions;

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

/**
 * Update user balance (needed because upsertEntity doesn't update existing records)
 */
export async function updateUserBalance(
  db: DbClient,
  userId: string,
  balance: string
): Promise<void> {
  await db.update(users).set({ balance }).where(eq(users.id, userId));
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
  console.log(`  Accounts: ${String(personaData.accounts.length)}`);
  console.log(`  Projects: ${String(personaData.projects.length)}`);
  console.log(`  Conversations: ${String(personaData.conversations.length)}`);
  console.log(`  Messages: ${String(personaData.messages.length)}`);
  console.log(`  Payments: ${String(personaData.payments.length)}`);
  console.log(`  Balance Transactions: ${String(personaData.balanceTransactions.length)}`);
  console.log('');
  console.log('Test Personas:');
  console.log(`  Users: ${String(testPersonaData.users.length)}`);
  console.log(`  Accounts: ${String(testPersonaData.accounts.length)}`);
  console.log(`  Projects: ${String(testPersonaData.projects.length)}`);
  console.log(`  Conversations: ${String(testPersonaData.conversations.length)}`);
  console.log(`  Messages: ${String(testPersonaData.messages.length)}`);
  console.log(`  Payments: ${String(testPersonaData.payments.length)}`);
  console.log(`  Balance Transactions: ${String(testPersonaData.balanceTransactions.length)}`);
  console.log('');
  console.log('Random Seed Data:');
  console.log(`  Users: ${String(data.users.length)}`);
  console.log(`  Projects: ${String(data.projects.length)}`);
  console.log(`  Conversations: ${String(data.conversations.length)}`);
  console.log(`  Messages: ${String(data.messages.length)}`);
  console.log('');

  const personaUserResult = await upsertEntities(db, users, [
    ...personaData.users,
    ...testPersonaData.users,
  ]);
  logUpsertResult('Persona Users', personaUserResult);

  for (const user of personaData.users) {
    if ('balance' in user && user.balance) {
      await updateUserBalance(db, user.id, user.balance);
    }
  }
  console.log('Dev persona balances updated');

  for (const user of testPersonaData.users) {
    if ('balance' in user && user.balance && user.balance !== '0.00000000') {
      await updateUserBalance(db, user.id, user.balance);
    }
  }
  console.log('Test persona balances updated');

  const accountResult = await upsertEntities(db, accounts, [
    ...personaData.accounts,
    ...testPersonaData.accounts,
  ]);
  logUpsertResult('Persona Accounts', accountResult);

  const randomUserResult = await upsertEntities(db, users, data.users);
  logUpsertResult('Random Users', randomUserResult);

  const projectResult = await upsertEntities(db, projects, [
    ...personaData.projects,
    ...testPersonaData.projects,
    ...data.projects,
  ]);
  logUpsertResult('Projects', projectResult);

  const conversationResult = await upsertEntities(db, conversations, [
    ...personaData.conversations,
    ...testPersonaData.conversations,
    ...data.conversations,
  ]);
  logUpsertResult('Conversations', conversationResult);

  const messageResult = await upsertEntities(db, messages, [
    ...personaData.messages,
    ...testPersonaData.messages,
    ...data.messages,
  ]);
  logUpsertResult('Messages', messageResult);

  const paymentResult = await upsertEntities(db, payments, [
    ...personaData.payments,
    ...testPersonaData.payments,
  ]);
  logUpsertResult('Payments', paymentResult);

  const txResult = await upsertEntities(db, balanceTransactions, [
    ...personaData.balanceTransactions,
    ...testPersonaData.balanceTransactions,
  ]);
  logUpsertResult('Balance Transactions', txResult);

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
