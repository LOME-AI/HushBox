import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';
import type { MediaStorage } from '../services/storage/index.js';
import { mediaRoute } from './media.js';

const TEST_USER_ID = 'user-media-001';
const TEST_CONTENT_ITEM_ID = 'ci-media-001';
const TEST_CONVERSATION_ID = 'conv-media-001';
const TEST_STORAGE_KEY = 'media/conv-media-001/msg-media-001/ci-media-001.enc';

interface ErrorBody {
  code: string;
}

async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function createMockSession(): SessionData {
  return {
    sessionId: `session-${TEST_USER_ID}`,
    userId: TEST_USER_ID,
    email: 'media@example.com',
    username: 'media_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: true,
    pending2FA: false,
    pending2FAExpiresAt: 0,
    createdAt: Date.now(),
  };
}

function createMockUser(): AppEnv['Variables']['user'] {
  return {
    id: TEST_USER_ID,
    email: 'media@example.com',
    username: 'media_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: true,
    publicKey: new Uint8Array(32),
  };
}

interface MediaRowShape {
  id: string;
  contentType: 'text' | 'image' | 'audio' | 'video';
  storageKey: string | null;
  conversationId: string;
}

interface MediaMockDbConfig {
  row?: MediaRowShape | null;
}

/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
function createMediaMockDb(config: MediaMockDbConfig): unknown {
  const result = config.row ? [config.row] : [];

  const createQueryChain = (): Record<string, unknown> => ({
    from: () => createQueryChain(),
    innerJoin: () => createQueryChain(),
    leftJoin: () => createQueryChain(),
    where: () => createQueryChain(),
    limit: () => ({
      then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve(result)),
    }),
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve(result)),
  });

  return {
    select: () => createQueryChain(),
  };
}
/* eslint-enable unicorn/no-thenable */

interface FakeStorage extends Pick<MediaStorage, 'mintDownloadUrl'> {
  mintedFor: string[];
}

function createFakeStorage(options: { fail?: boolean } = {}): FakeStorage {
  const minted: string[] = [];
  return {
    mintedFor: minted,
    mintDownloadUrl: ({ key }) => {
      minted.push(key);
      if (options.fail) return Promise.reject(new Error('mint-fail'));
      return Promise.resolve({
        url: `https://presigned.example/${key}?sig=xyz`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    },
  };
}

interface TestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  dbConfig?: MediaMockDbConfig;
  storage?: FakeStorage;
}

function createMediaTestApp(options: TestAppOptions = {}): {
  app: Hono<AppEnv>;
  storage: FakeStorage;
} {
  const { user = createMockUser(), dbConfig = {}, storage = createFakeStorage() } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = { NODE_ENV: 'test' } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', createMediaMockDb(dbConfig) as AppEnv['Variables']['db']);
    c.set('mediaStorage', storage as unknown as MediaStorage);
    await next();
  });

  app.route('/', mediaRoute);
  return { app, storage };
}

describe('mediaRoute GET /:contentItemId/download-url', () => {
  it('returns 401 when not authenticated', async () => {
    const { app } = createMediaTestApp({ user: null });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(401);
  });

  it('returns 404 when the content item does not exist', async () => {
    const { app } = createMediaTestApp({ dbConfig: { row: null } });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(404);
    const body = await jsonBody<ErrorBody>(res);
    expect(body.code).toBe('CONTENT_ITEM_NOT_FOUND');
  });

  it('returns 404 when the caller is not a conversation member', async () => {
    // The db query joins conversation_members with userId = caller.id; if the
    // caller is not a member, the query returns zero rows — same as missing.
    const { app } = createMediaTestApp({ dbConfig: { row: null } });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(404);
    const body = await jsonBody<ErrorBody>(res);
    expect(body.code).toBe('CONTENT_ITEM_NOT_FOUND');
  });

  it('returns 400 when the content item is text (not downloadable)', async () => {
    const { app } = createMediaTestApp({
      dbConfig: {
        row: {
          id: TEST_CONTENT_ITEM_ID,
          contentType: 'text',
          storageKey: null,
          conversationId: TEST_CONVERSATION_ID,
        },
      },
    });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(400);
    const body = await jsonBody<ErrorBody>(res);
    expect(body.code).toBe('CONTENT_ITEM_NOT_MEDIA');
  });

  it('returns 200 with downloadUrl and expiresAt for an image content item', async () => {
    const { app, storage } = createMediaTestApp({
      dbConfig: {
        row: {
          id: TEST_CONTENT_ITEM_ID,
          contentType: 'image',
          storageKey: TEST_STORAGE_KEY,
          conversationId: TEST_CONVERSATION_ID,
        },
      },
    });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(200);
    const body = await jsonBody<{ downloadUrl: string; expiresAt: string }>(res);
    expect(body.downloadUrl).toContain(TEST_STORAGE_KEY);
    expect(new Date(body.expiresAt).toString()).not.toBe('Invalid Date');
    expect(storage.mintedFor).toEqual([TEST_STORAGE_KEY]);
  });

  it('returns 200 for video content items', async () => {
    const { app } = createMediaTestApp({
      dbConfig: {
        row: {
          id: TEST_CONTENT_ITEM_ID,
          contentType: 'video',
          storageKey: TEST_STORAGE_KEY,
          conversationId: TEST_CONVERSATION_ID,
        },
      },
    });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(200);
  });

  it('returns 200 for audio content items', async () => {
    const { app } = createMediaTestApp({
      dbConfig: {
        row: {
          id: TEST_CONTENT_ITEM_ID,
          contentType: 'audio',
          storageKey: TEST_STORAGE_KEY,
          conversationId: TEST_CONVERSATION_ID,
        },
      },
    });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(200);
  });

  it('returns 500 with STORAGE_READ_FAILED when minting fails', async () => {
    const storage = createFakeStorage({ fail: true });
    const { app } = createMediaTestApp({
      storage,
      dbConfig: {
        row: {
          id: TEST_CONTENT_ITEM_ID,
          contentType: 'image',
          storageKey: TEST_STORAGE_KEY,
          conversationId: TEST_CONVERSATION_ID,
        },
      },
    });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(500);
    const body = await jsonBody<ErrorBody>(res);
    expect(body.code).toBe('STORAGE_READ_FAILED');
  });
});
