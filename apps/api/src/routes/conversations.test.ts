/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- json() returns any, assertions provide documentation */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  conversations,
  messages,
  users,
  epochs,
  epochMembers,
  conversationMembers,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import type {
  ListConversationsResponse,
  GetConversationResponse,
  CreateConversationResponse,
  UpdateConversationResponse,
  DeleteConversationResponse,
} from '@hushbox/shared';
import { toBase64 as bytesToBase64, fromBase64 as base64ToBytes } from '@hushbox/shared';
import { conversationsRoute } from './conversations.js';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';

interface ErrorResponse {
  code: string;
  details?: Record<string, unknown>;
}

// Type aliases for backward compatibility with existing test code
type ConversationsListResponse = ListConversationsResponse;
type ConversationDetailResponse = GetConversationResponse;

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

/** Encode a string to URL-safe base64 for API requests. */
function toBase64(string_: string): string {
  return bytesToBase64(new TextEncoder().encode(string_));
}

/** Decode a URL-safe base64 string to plaintext for assertions. */
function fromBase64(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
}

/** Encode a string to Uint8Array for direct DB inserts. */
function toBytes(string_: string): Uint8Array {
  return new TextEncoder().encode(string_);
}

/** Create placeholder bytes for epoch crypto fields. */
function placeholderBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = index % 256;
  }
  return bytes;
}

// Store for mocking user/session per request - keyed by user ID
const mockUserStore = new Map<string, { email: string; username: string; publicKey: Uint8Array }>();

function createTestAppWithAuth(db: ReturnType<typeof createDb>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);

    const testUserId = c.req.header('X-Test-User-Id');
    if (testUserId) {
      const userInfo = mockUserStore.get(testUserId);
      if (userInfo) {
        const sessionData: SessionData = {
          sessionId: `session-${testUserId}`,
          userId: testUserId,
          email: userInfo.email,
          username: userInfo.username,
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          pending2FA: false,
          pending2FAExpiresAt: 0,
          createdAt: Date.now(),
        };
        c.set('user', {
          id: testUserId,
          email: userInfo.email,
          username: userInfo.username,
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          publicKey: userInfo.publicKey,
        });
        c.set('session', sessionData);
        c.set('sessionData', sessionData);
      }
    } else {
      c.set('user', null);
      c.set('session', null);
      c.set('sessionData', null);
    }
    await next();
  });
  app.route('/conversations', conversationsRoute);

  return app;
}

interface CreateTestUserOptions {
  db: ReturnType<typeof createDb>;
  email: string;
  username: string;
}

async function createTestUser(options: CreateTestUserOptions): Promise<string> {
  const { db, email, username } = options;

  const userData = userFactory.build({
    email,
    username,
    emailVerified: true,
  });
  const [user] = await db.insert(users).values(userData).returning();
  if (!user) throw new Error('Failed to create test user');

  mockUserStore.set(user.id, { email, username, publicKey: user.publicKey });

  return user.id;
}

function getAuthHeaders(userId: string): Record<string, string> {
  return { 'X-Test-User-Id': userId };
}

describe('conversations routes', () => {
  const connectionString = DATABASE_URL;
  let db: ReturnType<typeof createDb>;
  let app: Hono<AppEnv>;
  let testUserId: string;

  const RUN_ID = String(Date.now());
  const TEST_EMAIL = `test-conv-${RUN_ID}@example.com`;
  const TEST_USERNAME = `tc_${RUN_ID}`;

  const createdConversationIds: string[] = [];

  beforeAll(async () => {
    db = createDb({ connectionString, neonDev: LOCAL_NEON_DEV_CONFIG });
    app = createTestAppWithAuth(db);

    testUserId = await createTestUser({ db, email: TEST_EMAIL, username: TEST_USERNAME });

    // Create test conversations with encrypted (bytea) title and epoch infrastructure
    const conv1Id = `test-conv-1-${String(Date.now())}`;
    const [conv1] = await db
      .insert(conversations)
      .values({
        id: conv1Id,
        userId: testUserId,
        title: toBytes('First conversation'),
        titleEpochNumber: 1,
        currentEpoch: 1,
        nextSequence: 3,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-02'),
      })
      .returning();
    if (conv1) {
      createdConversationIds.push(conv1.id);

      // Create epoch #1 for conv1
      const [epoch1] = await db
        .insert(epochs)
        .values({
          conversationId: conv1.id,
          epochNumber: 1,
          epochPublicKey: placeholderBytes(32),
          confirmationHash: placeholderBytes(32),
          chainLink: null,
        })
        .returning();

      if (epoch1) {
        // Create epoch member for the owner
        const userInfo = mockUserStore.get(testUserId);
        if (userInfo) {
          await db.insert(epochMembers).values({
            epochId: epoch1.id,
            memberPublicKey: userInfo.publicKey,
            wrap: placeholderBytes(48),
            visibleFromEpoch: 1,
          });
        }
      }

      // Create conversation member (owner = auto-accepted)
      await db.insert(conversationMembers).values({
        conversationId: conv1.id,
        userId: testUserId,
        privilege: 'owner',
        visibleFromEpoch: 1,
        acceptedAt: new Date(),
      });

      // Create test messages with new schema (encryptedBlob, senderType, epochNumber, sequenceNumber)
      await db.insert(messages).values({
        conversationId: conv1.id,
        encryptedBlob: toBytes('encrypted-hello'),
        senderType: 'user',
        senderId: testUserId,
        senderDisplayName: null,
        payerId: null,
        epochNumber: 1,
        sequenceNumber: 1,
      });

      await db.insert(messages).values({
        conversationId: conv1.id,
        encryptedBlob: toBytes('encrypted-hi-there'),
        senderType: 'ai',
        senderId: null,
        senderDisplayName: 'GPT-4',
        payerId: testUserId,
        epochNumber: 1,
        sequenceNumber: 2,
      });
    }

    const conv2Id = `test-conv-2-${String(Date.now())}`;
    const [conv2] = await db
      .insert(conversations)
      .values({
        id: conv2Id,
        userId: testUserId,
        title: toBytes('Second conversation'),
        titleEpochNumber: 1,
        currentEpoch: 1,
        nextSequence: 1,
        createdAt: new Date('2024-01-02'),
        updatedAt: new Date('2024-01-03'),
      })
      .returning();
    if (conv2) {
      createdConversationIds.push(conv2.id);

      // Create epoch #1 for conv2
      await db.insert(epochs).values({
        conversationId: conv2.id,
        epochNumber: 1,
        epochPublicKey: placeholderBytes(32),
        confirmationHash: placeholderBytes(32),
        chainLink: null,
      });

      // Create conversation member (owner = auto-accepted)
      await db.insert(conversationMembers).values({
        conversationId: conv2.id,
        userId: testUserId,
        privilege: 'owner',
        visibleFromEpoch: 1,
        acceptedAt: new Date(),
      });
    }
  });

  afterAll(async () => {
    // Messages, epochs, epoch_members, conversation_members cascade on conversation delete
    if (createdConversationIds.length > 0) {
      await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
    }
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId));
    }
  });

  describe('GET /conversations', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/conversations');

      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns list of conversations for authenticated user', async () => {
      const res = await app.request('/conversations', {
        headers: {
          ...getAuthHeaders(testUserId),
        },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as ConversationsListResponse;
      expect(json.conversations).toBeDefined();
      expect(Array.isArray(json.conversations)).toBe(true);
      expect(json.conversations.length).toBeGreaterThanOrEqual(2);

      // Titles are base64-encoded — decode and check
      const titles = json.conversations.map((c) => fromBase64(c.title));
      expect(titles).toContain('First conversation');
      expect(titles).toContain('Second conversation');

      // Verify conversations are ordered by updatedAt DESC
      const conv1Index = titles.indexOf('First conversation');
      const conv2Index = titles.indexOf('Second conversation');
      expect(conv2Index).toBeLessThan(conv1Index);

      // Verify epoch fields are present
      const firstConv = json.conversations.find(
        (c) => fromBase64(c.title) === 'First conversation'
      );
      expect(firstConv?.currentEpoch).toBe(1);
      expect(firstConv?.titleEpochNumber).toBe(1);
      expect(firstConv?.nextSequence).toBe(3);

      // Verify acceptance fields are present (owner = auto-accepted)
      expect(firstConv?.accepted).toBe(true);
      expect(firstConv?.invitedByUsername).toBeNull();

      // Verify privilege field is present (owner's own conversation)
      expect(firstConv?.privilege).toBe('owner');
    });
  });

  describe('GET /conversations/:id', () => {
    function verifyConversationFields(json: ConversationDetailResponse, convId: string): void {
      expect(json.conversation).toBeDefined();
      expect(json.conversation.id).toBe(convId);
      expect(fromBase64(json.conversation.title)).toBe('First conversation');
      expect(json.conversation.currentEpoch).toBe(1);
      expect(json.conversation.titleEpochNumber).toBe(1);
      expect(json.conversation.nextSequence).toBe(3);
    }

    function verifyMessageListBasics(messages: ConversationDetailResponse['messages']): {
      userMsg: ConversationDetailResponse['messages'][0];
      aiMsg: ConversationDetailResponse['messages'][0];
    } {
      expect(messages).toBeDefined();
      expect(Array.isArray(messages)).toBe(true);
      expect(messages.length).toBe(2);

      const userMsg = messages.find((m) => m.senderType === 'user');
      const aiMsg = messages.find((m) => m.senderType === 'ai');
      expect(userMsg).toBeDefined();
      expect(aiMsg).toBeDefined();

      if (!userMsg || !aiMsg) throw new Error('Expected both user and AI messages');
      return { userMsg, aiMsg };
    }

    function verifyMessageDetails(
      userMsg: ConversationDetailResponse['messages'][0],
      aiMsg: ConversationDetailResponse['messages'][0],
      userId: string,
      messages: ConversationDetailResponse['messages']
    ): void {
      expect(userMsg.encryptedBlob).toBeDefined();
      expect(fromBase64(userMsg.encryptedBlob)).toBe('encrypted-hello');
      expect(fromBase64(aiMsg.encryptedBlob)).toBe('encrypted-hi-there');

      expect(userMsg.epochNumber).toBe(1);
      expect(userMsg.sequenceNumber).toBe(1);
      expect(aiMsg.epochNumber).toBe(1);
      expect(aiMsg.sequenceNumber).toBe(2);

      expect(userMsg.senderId).toBe(userId);
      expect(aiMsg.senderDisplayName).toBe('GPT-4');

      const first = messages[0];
      const second = messages[1];
      if (!first || !second) throw new Error('Expected two messages');
      expect(first.sequenceNumber).toBeLessThan(second.sequenceNumber);
    }

    function verifyMessageStructure(json: ConversationDetailResponse, userId: string): void {
      const { userMsg, aiMsg } = verifyMessageListBasics(json.messages);
      verifyMessageDetails(userMsg, aiMsg, userId, json.messages);
    }

    it('returns 401 when not authenticated', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const res = await app.request(`/conversations/${convId}`);

      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await app.request('/conversations/non-existent-id', {
        headers: {
          ...getAuthHeaders(testUserId),
        },
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns conversation with messages for authenticated user', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const res = await app.request(`/conversations/${convId}`, {
        headers: {
          ...getAuthHeaders(testUserId),
        },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as ConversationDetailResponse;

      verifyConversationFields(json, convId);
      verifyMessageStructure(json, testUserId);

      // Verify acceptance fields (owner = auto-accepted)
      expect(json.accepted).toBe(true);
      expect(json.invitedByUsername).toBeNull();
    });
  });

  describe('POST /conversations', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('NOT_AUTHENTICATED');
    });

    it('creates conversation with epoch infrastructure', async () => {
      const conversationId = crypto.randomUUID();
      const epochPublicKey = bytesToBase64(placeholderBytes(32));
      const confirmationHash = bytesToBase64(placeholderBytes(32));
      const memberWrap = bytesToBase64(placeholderBytes(48));

      const res = await app.request('/conversations', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: conversationId,
          epochPublicKey,
          confirmationHash,
          memberWrap,
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as CreateConversationResponse;
      expect(json.conversation).toBeDefined();
      expect(json.conversation.id).toBe(conversationId);
      // No title provided → empty bytes → base64 of empty = ""
      expect(json.conversation.title).toBe('');
      expect(json.conversation.userId).toBe(testUserId);
      expect(json.isNew).toBe(true);

      // Verify epoch fields
      expect(json.conversation.currentEpoch).toBe(1);
      expect(json.conversation.titleEpochNumber).toBe(1);
      expect(json.conversation.nextSequence).toBe(1);

      // Creator is always auto-accepted
      expect(json.accepted).toBe(true);
      expect(json.invitedByUsername).toBeNull();

      createdConversationIds.push(json.conversation.id);
    });

    it('creates conversation with provided encrypted title', async () => {
      const conversationId = crypto.randomUUID();
      const encryptedTitle = toBase64('My Chat');
      const epochPublicKey = bytesToBase64(placeholderBytes(32));
      const confirmationHash = bytesToBase64(placeholderBytes(32));
      const memberWrap = bytesToBase64(placeholderBytes(48));

      const res = await app.request('/conversations', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: conversationId,
          title: encryptedTitle,
          epochPublicKey,
          confirmationHash,
          memberWrap,
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as CreateConversationResponse;
      expect(fromBase64(json.conversation.title)).toBe('My Chat');
      expect(json.isNew).toBe(true);

      createdConversationIds.push(json.conversation.id);
    });

    it('returns existing conversation idempotently', async () => {
      const conversationId = crypto.randomUUID();
      const encryptedTitle = toBase64('Idempotent Conv');
      const epochPublicKey = bytesToBase64(placeholderBytes(32));
      const confirmationHash = bytesToBase64(placeholderBytes(32));
      const memberWrap = bytesToBase64(placeholderBytes(48));

      // First call creates
      const res1 = await app.request('/conversations', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: conversationId,
          title: encryptedTitle,
          epochPublicKey,
          confirmationHash,
          memberWrap,
        }),
      });

      expect(res1.status).toBe(201);
      const json1 = (await res1.json()) as CreateConversationResponse;
      expect(json1.isNew).toBe(true);
      createdConversationIds.push(json1.conversation.id);

      // Second call returns existing
      const res2 = await app.request('/conversations', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: conversationId,
          title: toBase64('Different Title'),
          epochPublicKey,
          confirmationHash,
          memberWrap,
        }),
      });

      expect(res2.status).toBe(200);
      const json2 = (await res2.json()) as CreateConversationResponse;
      expect(json2.isNew).toBe(false);
      // Original title preserved
      expect(fromBase64(json2.conversation.title)).toBe('Idempotent Conv');
    });

    it('returns 400 when epoch fields are missing', async () => {
      const conversationId = crypto.randomUUID();

      const res = await app.request('/conversations', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: conversationId }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /conversations/:id', () => {
    it('returns 401 when not authenticated', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const res = await app.request(`/conversations/${convId}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await app.request('/conversations/non-existent-id', {
        method: 'DELETE',
        headers: { ...getAuthHeaders(testUserId) },
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('deletes conversation and returns success', async () => {
      const conversationId = crypto.randomUUID();
      const epochPublicKey = bytesToBase64(placeholderBytes(32));
      const confirmationHash = bytesToBase64(placeholderBytes(32));
      const memberWrap = bytesToBase64(placeholderBytes(48));

      const createRes = await app.request('/conversations', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: conversationId,
          title: toBase64('To be deleted'),
          epochPublicKey,
          confirmationHash,
          memberWrap,
        }),
      });
      const createJson = (await createRes.json()) as CreateConversationResponse;
      const convId = createJson.conversation.id;

      const res = await app.request(`/conversations/${convId}`, {
        method: 'DELETE',
        headers: { ...getAuthHeaders(testUserId) },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as DeleteConversationResponse;
      expect(json.deleted).toBe(true);

      // Verify it's gone
      const getRes = await app.request(`/conversations/${convId}`, {
        headers: { ...getAuthHeaders(testUserId) },
      });
      expect(getRes.status).toBe(404);
    });
  });

  describe('PATCH /conversations/:id', () => {
    it('returns 401 when not authenticated', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const res = await app.request(`/conversations/${convId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: toBase64('New title') }),
      });

      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await app.request('/conversations/non-existent-id', {
        method: 'PATCH',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: toBase64('New title'), titleEpochNumber: 1 }),
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 400 for empty title', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const res = await app.request(`/conversations/${convId}`, {
        method: 'PATCH',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: '', titleEpochNumber: 1 }),
      });

      expect(res.status).toBe(400);
    });

    it('updates conversation title', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const newTitle = toBase64('Updated title');
      const res = await app.request(`/conversations/${convId}`, {
        method: 'PATCH',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: newTitle, titleEpochNumber: 1 }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as UpdateConversationResponse;
      expect(fromBase64(json.conversation.title)).toBe('Updated title');
      expect(json.conversation.id).toBe(convId);

      // Verify epoch fields still present
      expect(json.conversation.currentEpoch).toBe(1);
      expect(json.conversation.titleEpochNumber).toBe(1);

      // Updater (owner) is always accepted
      expect(json.accepted).toBe(true);
      expect(json.invitedByUsername).toBeNull();
    });
  });

  describe('Cross-user authorization', () => {
    let otherUserId: string;
    const OTHER_EMAIL = `test-other-${RUN_ID}@example.com`;

    beforeAll(async () => {
      otherUserId = await createTestUser({
        db,
        email: OTHER_EMAIL,
        username: `ou_${RUN_ID}`,
      });
    });

    afterAll(async () => {
      if (otherUserId) {
        await db.delete(users).where(eq(users.id, otherUserId));
      }
    });

    it('returns 404 when user B tries to GET user A conversation', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');

      const res = await app.request(`/conversations/${convId}`, {
        headers: { ...getAuthHeaders(otherUserId) },
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 404 when user B tries to DELETE user A conversation', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');

      const res = await app.request(`/conversations/${convId}`, {
        method: 'DELETE',
        headers: { ...getAuthHeaders(otherUserId) },
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 404 when user B tries to PATCH user A conversation', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');

      const res = await app.request(`/conversations/${convId}`, {
        method: 'PATCH',
        headers: {
          ...getAuthHeaders(otherUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: toBase64('Hacked title'), titleEpochNumber: 1 }),
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 404 when user B tries to POST with user A conversation ID', async () => {
      // Create a conversation as user A via the API (valid UUID)
      const conversationId = crypto.randomUUID();
      const epochPublicKey = bytesToBase64(placeholderBytes(32));
      const confirmationHash = bytesToBase64(placeholderBytes(32));
      const memberWrap = bytesToBase64(placeholderBytes(48));

      const createRes = await app.request('/conversations', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: conversationId, epochPublicKey, confirmationHash, memberWrap }),
      });
      expect(createRes.status).toBe(201);
      createdConversationIds.push(conversationId);

      // User B tries to create/get with the same ID
      const res = await app.request('/conversations', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(otherUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: conversationId, epochPublicKey, confirmationHash, memberWrap }),
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('user B only sees their own conversations in list', async () => {
      const res = await app.request('/conversations', {
        headers: { ...getAuthHeaders(otherUserId) },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as ConversationsListResponse;

      const userAConvIds = createdConversationIds;
      const hasUserAConversations = json.conversations.some((c) => userAConvIds.includes(c.id));
      expect(hasUserAConversations).toBe(false);
    });
  });

  describe('Member visibility', () => {
    let memberUserId: string;
    let memberConvId: string;
    const MEMBER_EMAIL = `test-member-${RUN_ID}@example.com`;

    beforeAll(async () => {
      memberUserId = await createTestUser({
        db,
        email: MEMBER_EMAIL,
        username: `mbr_${RUN_ID}`,
      });

      // Use the first test conversation (owned by testUserId) and add memberUser as a member
      memberConvId = createdConversationIds[0]!;
      await db.insert(conversationMembers).values({
        conversationId: memberConvId,
        userId: memberUserId,
        privilege: 'write',
        visibleFromEpoch: 1,
      });
    });

    afterAll(async () => {
      // Remove member row before deleting user (avoids CHECK constraint violation)
      if (memberUserId) {
        await db.delete(conversationMembers).where(eq(conversationMembers.userId, memberUserId));
        await db.delete(users).where(eq(users.id, memberUserId));
      }
    });

    it('GET /conversations returns shared conversations for member', async () => {
      const res = await app.request('/conversations', {
        headers: { ...getAuthHeaders(memberUserId) },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as ConversationsListResponse;
      const conv = json.conversations.find((c) => c.id === memberConvId);
      expect(conv).toBeDefined();

      // Member was added without acceptedAt → not yet accepted
      expect(conv?.accepted).toBe(false);
      expect(conv?.invitedByUsername).toBeNull();

      // Verify privilege field reflects member's privilege
      expect(conv?.privilege).toBe('write');
    });

    it('GET /conversations/:id returns conversation for member', async () => {
      const res = await app.request(`/conversations/${memberConvId}`, {
        headers: { ...getAuthHeaders(memberUserId) },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as ConversationDetailResponse;
      expect(json.conversation.id).toBe(memberConvId);
      expect(json.messages).toBeDefined();
    });

    it('GET /conversations/:id filters messages by member visibleFromEpoch', async () => {
      // Create a new conversation with messages in multiple epochs
      const epochConvId = `test-epoch-filter-${String(Date.now())}`;
      const [epochConv] = await db
        .insert(conversations)
        .values({
          id: epochConvId,
          userId: testUserId,
          title: toBytes('Epoch filter test'),
          titleEpochNumber: 1,
          currentEpoch: 2,
          nextSequence: 4,
        })
        .returning();
      if (!epochConv) throw new Error('Failed to create epoch filter conversation');
      createdConversationIds.push(epochConv.id);

      await db.insert(epochs).values({
        conversationId: epochConv.id,
        epochNumber: 1,
        epochPublicKey: placeholderBytes(32),
        confirmationHash: placeholderBytes(32),
      });

      // Owner member row
      await db.insert(conversationMembers).values({
        conversationId: epochConv.id,
        userId: testUserId,
        privilege: 'owner',
        visibleFromEpoch: 1,
      });

      // Member with visibleFromEpoch=2 (can't see epoch 1 messages)
      await db.insert(conversationMembers).values({
        conversationId: epochConv.id,
        userId: memberUserId,
        privilege: 'write',
        visibleFromEpoch: 2,
      });

      // Messages in epoch 1 and epoch 2
      await db.insert(messages).values({
        conversationId: epochConv.id,
        encryptedBlob: toBytes('epoch-1-msg'),
        senderType: 'user',
        epochNumber: 1,
        sequenceNumber: 1,
      });
      await db.insert(messages).values({
        conversationId: epochConv.id,
        encryptedBlob: toBytes('epoch-2-msg'),
        senderType: 'ai',
        epochNumber: 2,
        sequenceNumber: 2,
      });

      // Member should only see epoch 2 messages
      const res = await app.request(`/conversations/${epochConv.id}`, {
        headers: { ...getAuthHeaders(memberUserId) },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as ConversationDetailResponse;
      expect(json.messages).toHaveLength(1);
      expect(json.messages[0]!.epochNumber).toBe(2);
    });

    it('GET /conversations/:id returns 404 for ex-member', async () => {
      // Create a conversation and add member, then set leftAt
      const exConvId = `test-ex-member-${String(Date.now())}`;
      const [exConv] = await db
        .insert(conversations)
        .values({
          id: exConvId,
          userId: testUserId,
          title: toBytes('Ex-member test'),
          titleEpochNumber: 1,
          currentEpoch: 1,
          nextSequence: 1,
        })
        .returning();
      if (!exConv) throw new Error('Failed to create ex-member conversation');
      createdConversationIds.push(exConv.id);

      await db.insert(epochs).values({
        conversationId: exConv.id,
        epochNumber: 1,
        epochPublicKey: placeholderBytes(32),
        confirmationHash: placeholderBytes(32),
      });

      // Owner member row
      await db.insert(conversationMembers).values({
        conversationId: exConv.id,
        userId: testUserId,
        privilege: 'owner',
        visibleFromEpoch: 1,
      });

      // Ex-member (has leftAt set)
      await db.insert(conversationMembers).values({
        conversationId: exConv.id,
        userId: memberUserId,
        privilege: 'write',
        visibleFromEpoch: 1,
        leftAt: new Date(),
      });

      const res = await app.request(`/conversations/${exConv.id}`, {
        headers: { ...getAuthHeaders(memberUserId) },
      });

      expect(res.status).toBe(404);
    });
  });
});
