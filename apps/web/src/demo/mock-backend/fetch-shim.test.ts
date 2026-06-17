import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPair } from '@hushbox/crypto';
import { DemoBackendStore } from './store';
import { resolveDemoRoute, installFetchShim } from './fetch-shim';
import { DEMO_CONVERSATIONS } from './fixtures';

const KNOWN_ID = DEMO_CONVERSATIONS[0]!.id;
const API = 'http://localhost:8787';

function makeStore(): DemoBackendStore {
  return new DemoBackendStore(generateKeyPair().publicKey);
}

describe('resolveDemoRoute', () => {
  const store = makeStore();
  const noBody = (): unknown => undefined;

  it('passes GET /api/models through to the real network', () => {
    expect(resolveDemoRoute(store, 'GET', '/api/models', noBody)).toEqual({ kind: 'passthrough' });
  });

  it('serves the conversation list', () => {
    const route = resolveDemoRoute(store, 'GET', '/api/conversations', noBody);
    expect(route).toMatchObject({ kind: 'json' });
    if (route.kind !== 'json') throw new Error('expected json');
    expect(route.body).toEqual(store.listConversations());
  });

  it('serves a known conversation and 404s an unknown one', () => {
    const known = resolveDemoRoute(store, 'GET', `/api/conversations/${KNOWN_ID}`, noBody);
    expect(known).toMatchObject({ kind: 'json' });
    expect(resolveDemoRoute(store, 'GET', '/api/conversations/nope', noBody)).toEqual({
      kind: 'notFound',
    });
  });

  it('serves the key-chain batch from the parsed POST body', () => {
    const route = resolveDemoRoute(store, 'POST', '/api/keys/batch', () => ({
      conversationIds: [KNOWN_ID],
    }));
    if (route.kind !== 'json') throw new Error('expected json');
    expect(route.body).toEqual(store.getKeyChainBatch([KNOWN_ID]));
  });

  it('serves balance, members and links', () => {
    expect(resolveDemoRoute(store, 'GET', '/api/billing/balance', noBody)).toMatchObject({
      kind: 'json',
    });
    expect(resolveDemoRoute(store, 'GET', `/api/members/${KNOWN_ID}`, noBody)).toMatchObject({
      kind: 'json',
    });
    expect(resolveDemoRoute(store, 'GET', `/api/links/${KNOWN_ID}`, noBody)).toMatchObject({
      kind: 'json',
    });
  });

  it('serves a media download url for a known content item and 404s an unknown one', () => {
    store.recordSendTurn('demo-image', { id: 'u1', content: 'go' }, 'm');
    const conversation = store.getConversation('demo-image');
    if (conversation === undefined) throw new Error('no conversation');
    const aiMessage = conversation.messages.find((m) => m.senderType === 'ai');
    const mediaItem = aiMessage?.contentItems.find((item) => item.contentType === 'image');
    if (mediaItem === undefined) throw new Error('no media item');

    const route = resolveDemoRoute(store, 'GET', `/api/media/${mediaItem.id}/download-url`, noBody);
    if (route.kind !== 'json') throw new Error('expected json');
    expect(route.body).toEqual(store.getMediaDownloadUrl(mediaItem.id));

    expect(resolveDemoRoute(store, 'GET', '/api/media/nope/download-url', noBody)).toEqual({
      kind: 'notFound',
    });
  });

  it('streams a reply for POST /api/chat/:id/stream', () => {
    const route = resolveDemoRoute(store, 'POST', `/api/chat/${KNOWN_ID}/stream`, () => ({
      userMessage: { id: 'u1', content: 'hi' },
      models: ['m'],
    }));
    expect(route.kind).toBe('stream');
    if (route.kind !== 'stream') throw new Error('expected stream');
    expect(route.frames.some((f) => f.startsWith('event: start'))).toBe(true);
    expect(route.frames.some((f) => f.startsWith('event: done'))).toBe(true);
  });

  it('streams a media turn with a generation lead delay and text with none', () => {
    const fresh = makeStore();
    const text = resolveDemoRoute(fresh, 'POST', `/api/chat/${KNOWN_ID}/stream`, () => ({
      userMessage: { id: 'u1', content: 'hi' },
      models: ['m'],
    }));
    if (text.kind !== 'stream') throw new Error('expected stream');
    expect(text.leadDelayMs).toBe(0);

    const media = resolveDemoRoute(fresh, 'POST', '/api/chat/demo-image/stream', () => ({
      userMessage: { id: 'u2', content: 'go' },
      models: ['m'],
    }));
    if (media.kind !== 'stream') throw new Error('expected stream');
    expect(media.leadDelayMs).toBe(5000);
  });

  it('404s a stream POST without a userMessage', () => {
    expect(resolveDemoRoute(store, 'POST', `/api/chat/${KNOWN_ID}/stream`, () => ({}))).toEqual({
      kind: 'notFound',
    });
  });

  it('streams a regenerated reply for POST /api/chat/:id/regenerate', () => {
    const conversation = store.getConversation(KNOWN_ID);
    const userMessage = conversation?.messages.find((m) => m.senderType === 'user');
    if (userMessage === undefined) throw new Error('no user message');
    const route = resolveDemoRoute(store, 'POST', `/api/chat/${KNOWN_ID}/regenerate`, () => ({
      targetMessageId: userMessage.id,
      models: ['m'],
    }));
    expect(route.kind).toBe('stream');
    if (route.kind !== 'stream') throw new Error('expected stream');
    expect(route.frames.some((f) => f.startsWith('event: start'))).toBe(true);
  });

  it('404s a regenerate POST without a targetMessageId', () => {
    expect(resolveDemoRoute(store, 'POST', `/api/chat/${KNOWN_ID}/regenerate`, () => ({}))).toEqual(
      {
        kind: 'notFound',
      }
    );
  });

  it('404s unknown /api routes but passes non-api requests through', () => {
    expect(resolveDemoRoute(store, 'GET', '/api/user-preferences/accessibility', noBody)).toEqual({
      kind: 'notFound',
    });
    expect(resolveDemoRoute(store, 'GET', '/assets/logo.png', noBody)).toEqual({
      kind: 'passthrough',
    });
  });
});

describe('installFetchShim', () => {
  let originalFetch: typeof globalThis.fetch;
  let passthrough: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    passthrough = vi.fn(() => Promise.resolve(new Response('real', { status: 200 })));
    globalThis.fetch = passthrough as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('serves demo endpoints from the store without hitting the network', async () => {
    const store = makeStore();
    const uninstall = installFetchShim(store);

    const res = await fetch(`${API}/api/conversations`);
    expect(await res.json()).toEqual(store.listConversations());
    expect(passthrough).not.toHaveBeenCalled();

    uninstall();
  });

  it('passes /api/models through to the real fetch', async () => {
    const store = makeStore();
    const uninstall = installFetchShim(store);

    await fetch(`${API}/api/models`);
    expect(passthrough).toHaveBeenCalledTimes(1);

    uninstall();
    expect(globalThis.fetch).toBe(passthrough);
  });

  it('reads the JSON body of a POST to resolve the route', async () => {
    const store = makeStore();
    const uninstall = installFetchShim(store);

    const res = await fetch(`${API}/api/keys/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationIds: [KNOWN_ID] }),
    });
    expect(await res.json()).toEqual(store.getKeyChainBatch([KNOWN_ID]));

    uninstall();
  });

  it('serves a text/event-stream response for a chat send', async () => {
    const store = makeStore();
    const uninstall = installFetchShim(store);

    const res = await fetch(`${API}/api/chat/${KNOWN_ID}/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessage: { id: 'u1', content: 'hi' }, models: ['m'] }),
    });
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.body).not.toBeNull();

    uninstall();
  });
});
