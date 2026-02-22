import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { toBase64 } from '@hushbox/shared';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';
import { messageSharesRoute, publicSharesRoute } from './message-shares.js';

const TEST_USER_ID = 'user-share-001';
const TEST_MESSAGE_ID = 'msg-share-001';
const TEST_CONVERSATION_ID = 'conv-share-001';
const TEST_SHARE_ID = 'share-001';
const TEST_SHARE_BLOB = new Uint8Array([10, 20, 30, 40, 50]);
const TEST_SHARE_BLOB_BASE64 = toBase64(TEST_SHARE_BLOB);

interface ErrorBody {
  code: string;
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

// ── POST /share mock infrastructure ──

interface CreateShareMockDbConfig {
  message?: { id: string; conversationId: string } | null;
  membership?: { id: string } | null;
  insertedShare?: { id: string };
}

/**
 * Creates a mock Drizzle DB for the POST /share route.
 *
 * The route performs 2 sequential SELECT queries then 1 INSERT:
 * 1. message lookup (select with limit+then)
 * 2. membership lookup (select with limit+then)
 * 3. insert into sharedMessages (insert with returning)
 */
/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
function createShareMockDb(config: CreateShareMockDbConfig): unknown {
  let selectCallIndex = 0;
  const selectResults: unknown[][] = [
    // 1st select: message lookup
    config.message ? [config.message] : [],
    // 2nd select: membership lookup
    config.membership ? [config.membership] : [],
  ];

  const createQueryChain = (): Record<string, unknown> => ({
    from: () => createQueryChain(),
    where: () => createQueryChain(),
    innerJoin: () => createQueryChain(),
    leftJoin: () => createQueryChain(),
    limit: () => ({
      then: (resolve: (v: unknown[]) => unknown) => {
        const result = selectResults[selectCallIndex++] ?? [];
        return Promise.resolve(resolve(result));
      },
    }),
    then: (resolve: (v: unknown[]) => unknown) => {
      const result = selectResults[selectCallIndex++] ?? [];
      return Promise.resolve(resolve(result));
    },
  });

  return {
    select: () => createQueryChain(),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([{ id: config.insertedShare?.id ?? 'new-share-id' }]),
      }),
    }),
  };
}
/* eslint-enable unicorn/no-thenable */

interface CreateShareTestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  dbConfig?: CreateShareMockDbConfig;
}

function createShareTestApp(options: CreateShareTestAppOptions = {}): Hono<AppEnv> {
  const { user = createMockUser(), dbConfig = {} } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = { NODE_ENV: 'test' } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', createShareMockDb(dbConfig) as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', messageSharesRoute);
  return app;
}

function createShareBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    messageId: TEST_MESSAGE_ID,
    shareBlob: TEST_SHARE_BLOB_BASE64,
    ...overrides,
  };
}

// ── GET /share/:shareId mock infrastructure ──

interface GetShareMockDbConfig {
  share?: {
    id: string;
    messageId: string;
    shareBlob: Uint8Array;
    createdAt: Date;
  } | null;
}

/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
function createGetShareMockDb(config: GetShareMockDbConfig): unknown {
  const createQueryChain = (): Record<string, unknown> => ({
    from: () => createQueryChain(),
    where: () => createQueryChain(),
    limit: () => ({
      then: (resolve: (v: unknown[]) => unknown) => {
        const result = config.share ? [config.share] : [];
        return Promise.resolve(resolve(result));
      },
    }),
    then: (resolve: (v: unknown[]) => unknown) => {
      const result = config.share ? [config.share] : [];
      return Promise.resolve(resolve(result));
    },
  });

  return {
    select: () => createQueryChain(),
  };
}
/* eslint-enable unicorn/no-thenable */

interface GetShareTestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  dbConfig?: GetShareMockDbConfig;
}

function createGetShareTestApp(options: GetShareTestAppOptions = {}): Hono<AppEnv> {
  const { user = null, dbConfig = {} } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = { NODE_ENV: 'test' } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', null);
    c.set('db', createGetShareMockDb(dbConfig) as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', publicSharesRoute);
  return app;
}

describe('message-shares routes', () => {
  describe('POST /share (messageSharesRoute)', () => {
    it('returns 401 when not authenticated', async () => {
      const app = createShareTestApp({ user: null });

      const res = await app.request('/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createShareBody()),
      });

      expect(res.status).toBe(401);
      const body = await res.json<ErrorBody>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 when message not found', async () => {
      const app = createShareTestApp({
        dbConfig: {
          message: null,
        },
      });

      const res = await app.request('/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createShareBody()),
      });

      expect(res.status).toBe(404);
      const body = await res.json<ErrorBody>();
      expect(body.code).toBe('MESSAGE_NOT_FOUND');
    });

    it('returns 403 when user is not a member of the conversation', async () => {
      const app = createShareTestApp({
        dbConfig: {
          message: { id: TEST_MESSAGE_ID, conversationId: TEST_CONVERSATION_ID },
          membership: null,
        },
      });

      const res = await app.request('/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createShareBody()),
      });

      expect(res.status).toBe(403);
      const body = await res.json<ErrorBody>();
      expect(body.code).toBe('FORBIDDEN');
    });

    it('creates share and returns 201 with shareId', async () => {
      const app = createShareTestApp({
        dbConfig: {
          message: { id: TEST_MESSAGE_ID, conversationId: TEST_CONVERSATION_ID },
          membership: { id: 'cm-001' },
          insertedShare: { id: TEST_SHARE_ID },
        },
      });

      const res = await app.request('/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createShareBody()),
      });

      expect(res.status).toBe(201);
      const body = await res.json<{ shareId: string }>();
      expect(body.shareId).toBe(TEST_SHARE_ID);
    });

    it('decodes shareBlob from base64 before storing', async () => {
      let capturedValues: unknown = null;

      // Custom mock that captures insert values
      /* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
      const mockDb = {
        select: (() => {
          let callIndex = 0;
          const results: unknown[][] = [
            [{ id: TEST_MESSAGE_ID, conversationId: TEST_CONVERSATION_ID }],
            [{ id: 'cm-001' }],
          ];
          const chain = (): Record<string, unknown> => ({
            from: () => chain(),
            where: () => chain(),
            limit: () => ({
              then: (resolve: (v: unknown[]) => unknown) => {
                const result = results[callIndex++] ?? [];
                return Promise.resolve(resolve(result));
              },
            }),
          });
          return () => chain();
        })(),
        insert: () => ({
          values: (vals: unknown) => {
            capturedValues = vals;
            return {
              returning: () => Promise.resolve([{ id: 'captured-share-id' }]),
            };
          },
        }),
      };
      /* eslint-enable unicorn/no-thenable */

      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.env = { NODE_ENV: 'test' } as unknown as AppEnv['Bindings'];
        c.set('user', createMockUser());
        c.set('session', createMockSession());
        c.set('sessionData', createMockSession());
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        await next();
      });
      app.route('/', messageSharesRoute);

      await app.request('/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createShareBody()),
      });

      expect(capturedValues).toBeDefined();
      const values = capturedValues as { messageId: string; shareBlob: Uint8Array };
      expect(values.messageId).toBe(TEST_MESSAGE_ID);
      // shareBlob should be a Uint8Array, not a base64 string
      expect(values.shareBlob).toBeInstanceOf(Uint8Array);
      expect(values.shareBlob).toEqual(TEST_SHARE_BLOB);
    });
  });

  describe('GET /:shareId (publicSharesRoute)', () => {
    it('returns 404 when share not found', async () => {
      const app = createGetShareTestApp({
        dbConfig: {
          share: null,
        },
      });

      const res = await app.request(`/${TEST_SHARE_ID}`);

      expect(res.status).toBe(404);
      const body = await res.json<ErrorBody>();
      expect(body.code).toBe('SHARE_NOT_FOUND');
    });

    it('returns share data with base64-encoded shareBlob', async () => {
      const createdAt = new Date('2025-07-01T12:00:00.000Z');
      const app = createGetShareTestApp({
        dbConfig: {
          share: {
            id: TEST_SHARE_ID,
            messageId: TEST_MESSAGE_ID,
            shareBlob: TEST_SHARE_BLOB,
            createdAt,
          },
        },
      });

      const res = await app.request(`/${TEST_SHARE_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        shareId: string;
        messageId: string;
        shareBlob: string;
        createdAt: string;
      }>();
      expect(body.shareId).toBe(TEST_SHARE_ID);
      expect(body.messageId).toBe(TEST_MESSAGE_ID);
      expect(body.shareBlob).toBe(TEST_SHARE_BLOB_BASE64);
      expect(body.createdAt).toBe('2025-07-01T12:00:00.000Z');
    });

    it('does not require authentication', async () => {
      const createdAt = new Date('2025-07-01T12:00:00.000Z');
      const app = createGetShareTestApp({
        user: null,
        dbConfig: {
          share: {
            id: TEST_SHARE_ID,
            messageId: TEST_MESSAGE_ID,
            shareBlob: TEST_SHARE_BLOB,
            createdAt,
          },
        },
      });

      const res = await app.request(`/${TEST_SHARE_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{ shareId: string }>();
      expect(body.shareId).toBe(TEST_SHARE_ID);
    });
  });
});
