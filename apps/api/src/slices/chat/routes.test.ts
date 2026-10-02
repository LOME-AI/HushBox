import { describe, expect, expectTypeOf, it } from 'vitest';
import { Hono } from 'hono';
import { hc } from 'hono/client';
import { applyPipeline } from '../../middleware/pipeline.js';
import { createChatManifest } from './routes.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { ChatRouteDeps } from './domain/index.js';
import type { ErrorResponse } from '@hushbox/shared';
import type { InferResponseType } from 'hono/client';
import type { JSONParsed } from 'hono/utils/types';

describe('GET /chat/mock/release-stream (dev-only held-stream release)', () => {
  const SECRET = 'secret-at-least-32-characters-long!!';
  const devEnvBase = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
    UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
    UPSTASH_REDIS_REST_TOKEN: 'token',
    IRON_SESSION_SECRET: SECRET,
    TELEMETRY_SINKS: 'console',
  };

  /** A fake ConversationRoom namespace recording the forwarded release fetch. */
  function fakeNamespace(response: Response): {
    readonly namespace: unknown;
    readonly calls: { name: string; path: string; search: string; method: string }[];
  } {
    const calls: { name: string; path: string; search: string; method: string }[] = [];
    const namespace = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => ({
        fetch: (input: string, init?: RequestInit) => {
          const url = new URL(input);
          calls.push({
            name: id.toString(),
            path: url.pathname,
            search: url.search,
            method: init?.method ?? 'GET',
          });
          return Promise.resolve(response);
        },
      }),
    };
    return { namespace, calls };
  }

  function mountedApp(): Hono<AppEnv> {
    // The manifest closures capture deps but this route touches only `c.env`,
    // so an empty deps stub is never dereferenced.
    const manifest = createChatManifest({} as unknown as ChatRouteDeps);
    const app = applyPipeline(new Hono<AppEnv>(), { cache: { policies: {} } });
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  it('forwards to the conversation room DO release route in dev/E2E', async () => {
    const { namespace, calls } = fakeNamespace(Response.json({ released: true }));
    const res = await mountedApp().request(
      '/chat/mock/release-stream?conversationId=conv-42',
      {},
      { ...devEnvBase, CONVERSATION_ROOM: namespace }
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ released: true });
    expect(calls).toEqual([
      { name: 'conv-42', path: '/mock/release-stream', search: '', method: 'POST' },
    ]);
  });

  it('forwards the run key a release names, so it can land before that run starts', async () => {
    const { namespace, calls } = fakeNamespace(Response.json({ released: false }));
    const res = await mountedApp().request(
      '/chat/mock/release-stream?conversationId=conv-42&runKey=turn-7',
      {},
      { ...devEnvBase, CONVERSATION_ROOM: namespace }
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ released: false });
    expect(calls).toEqual([
      {
        name: 'conv-42',
        path: '/mock/release-stream',
        search: '?runKey=turn-7',
        method: 'POST',
      },
    ]);
  });

  it('fails closed with 404 in production (dev-only route class)', async () => {
    const { namespace, calls } = fakeNamespace(Response.json({ released: true }));
    const res = await mountedApp().request(
      '/chat/mock/release-stream?conversationId=conv-42',
      {},
      { ...devEnvBase, NODE_ENV: 'production', CONVERSATION_ROOM: namespace }
    );
    expect(res.status).toBe(404);
    // The handler never ran — no DO fetch was forwarded.
    expect(calls).toEqual([]);
  });

  it('answers 503 when the conversation room binding is absent', async () => {
    const res = await mountedApp().request(
      '/chat/mock/release-stream?conversationId=conv-42',
      {},
      { ...devEnvBase }
    );
    expect(res.status).toBe(503);
  });

  it('answers 503 when the conversation room DO fetch is not ok', async () => {
    const { namespace } = fakeNamespace(new Response(null, { status: 500 }));
    const res = await mountedApp().request(
      '/chat/mock/release-stream?conversationId=conv-42',
      {},
      { ...devEnvBase, CONVERSATION_ROOM: namespace }
    );
    expect(res.status).toBe(503);
  });

  it('answers 503 when the conversation room DO returns a malformed body', async () => {
    const { namespace } = fakeNamespace(Response.json({ unexpected: 'shape' }));
    const res = await mountedApp().request(
      '/chat/mock/release-stream?conversationId=conv-42',
      {},
      { ...devEnvBase, CONVERSATION_ROOM: namespace }
    );
    expect(res.status).toBe(503);
  });
});

/**
 * The chat slice's typed-client contract. These pins fail (as a typecheck error,
 * which is where a type contract can fail) the moment a refusal path reverts to a
 * bare `Response`.
 *
 * The client is constructed purely as a `typeof` anchor for `InferResponseType`;
 * no request is made, so the base URL is never dereferenced.
 */
const _typeClient = hc<ReturnType<typeof createChatManifest>['routes']>('http://demo.invalid');

describe('chat route response types', () => {
  it('infers the trial-remaining 200 body', () => {
    expectTypeOf<InferResponseType<typeof _typeClient.trial.remaining.$get, 200>>().toEqualTypeOf<{
      remaining: number;
    }>();
  });

  it('infers the trial-remaining rate-limit refusal body', () => {
    expectTypeOf<InferResponseType<typeof _typeClient.trial.remaining.$get, 429>>().toEqualTypeOf<
      JSONParsed<ErrorResponse>
    >();
  });

  it('infers the stop 200 body', () => {
    expectTypeOf<InferResponseType<typeof _typeClient.stop.$post, 200>>().toEqualTypeOf<{
      stopped: boolean;
    }>();
  });

  it('infers the runless-send 200 body', () => {
    expectTypeOf<
      InferResponseType<(typeof _typeClient)[':conversationId']['message']['$post'], 200>
    >().toEqualTypeOf<{ messageId: string; sequenceNumber: number; epochNumber: number }>();
  });

  it('infers the paid send fresh-run 201 body carrying the minted message ids', () => {
    expectTypeOf<InferResponseType<typeof _typeClient.index.$post, 201>>().toEqualTypeOf<{
      runId: string;
      deadlineAt: number;
      userMessageId: string;
      assistantMessageIds: string[];
    }>();
  });

  // The trial 201 is a strict superset of the paid one. A shared responder that
  // answers both from one return union lets TypeScript's subtype reduction keep
  // only `{ runId, deadlineAt }`, silently erasing `trialSessionId` from
  // `AppType` while the runtime body still carries it — so only a type-level pin
  // catches the regression.
  it('infers the trial fresh-run 201 body carrying the minted session id', () => {
    expectTypeOf<InferResponseType<typeof _typeClient.trial.$post, 201>>().toEqualTypeOf<{
      runId: string;
      deadlineAt: number;
      trialSessionId: string;
    }>();
  });
});
