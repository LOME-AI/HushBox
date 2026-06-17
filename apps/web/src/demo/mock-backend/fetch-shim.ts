/**
 * Installs a global `fetch` shim that answers the demo's API calls from the
 * in-memory {@link DemoBackendStore}, while passing `GET /api/models` through
 * to the real network so the model list stays current. Everything funnels
 * through `globalThis.fetch` (the typed Hono client's `customFetch`, the SSE
 * consumer, and auth flows all call it), so this single seam intercepts the
 * whole read + send path with the app left completely unmodified.
 *
 * The route resolver is split into small pure functions so it can be
 * unit-tested without patching globals.
 */
import { buildSseTurnFrames, createSseStream } from './sse-shim';
import type { DemoBackendStore } from './store';

export type DemoRouteResult =
  | { kind: 'json'; body: unknown; status?: number }
  | { kind: 'stream'; frames: string[]; delayMs: number; leadDelayMs: number }
  | { kind: 'passthrough' }
  | { kind: 'notFound' };

/** Inter-token delay for the streamed reply — paced so the reply visibly types out. */
const STREAM_FRAME_DELAY_MS = 80;
/** One-time pause after `start` for media turns, so image/video "generation" reads as real work. */
const MEDIA_GENERATION_DELAY_MS = 5000;

const CONVERSATION_RE = /^\/api\/conversations\/([^/]+)$/;
const KEYS_RE = /^\/api\/keys\/([^/]+)$/;
const MEMBERS_RE = /^\/api\/members\/([^/]+)$/;
const LINKS_RE = /^\/api\/links\/([^/]+)$/;
const MEDIA_DOWNLOAD_RE = /^\/api\/media\/([^/]+)\/download-url$/;
const CHAT_STREAM_RE = /^\/api\/chat\/([^/]+)\/stream$/;
const CHAT_REGEN_RE = /^\/api\/chat\/([^/]+)\/regenerate$/;

function parameter(re: RegExp, pathname: string): string | null {
  const match = re.exec(pathname);
  return match ? decodeURIComponent(match[1] ?? '') : null;
}

function jsonOr404(body: unknown): DemoRouteResult {
  return body === undefined ? { kind: 'notFound' } : { kind: 'json', body };
}

/** Unknown API routes are harmless to 404; non-API requests (assets, fonts) pass through. */
function fallthrough(pathname: string): DemoRouteResult {
  return pathname.startsWith('/api/') ? { kind: 'notFound' } : { kind: 'passthrough' };
}

function resolveGetExact(store: DemoBackendStore, pathname: string): DemoRouteResult | null {
  // Real, read-only call kept live so the model catalog stays current.
  if (pathname === '/api/models') return { kind: 'passthrough' };
  if (pathname === '/api/conversations') return { kind: 'json', body: store.listConversations() };
  if (pathname === '/api/billing/balance') return { kind: 'json', body: store.getBalance() };
  return null;
}

function resolveGetParameter(store: DemoBackendStore, pathname: string): DemoRouteResult | null {
  const conversationId = parameter(CONVERSATION_RE, pathname);
  if (conversationId !== null) return jsonOr404(store.getConversation(conversationId));
  const keysId = parameter(KEYS_RE, pathname);
  if (keysId !== null) return jsonOr404(store.getKeyChain(keysId));
  const membersId = parameter(MEMBERS_RE, pathname);
  if (membersId !== null) return { kind: 'json', body: store.getMembers(membersId) };
  const linksId = parameter(LINKS_RE, pathname);
  if (linksId !== null) return { kind: 'json', body: store.getLinks(linksId) };
  const mediaId = parameter(MEDIA_DOWNLOAD_RE, pathname);
  if (mediaId !== null) return jsonOr404(store.getMediaDownloadUrl(mediaId));
  return null;
}

function resolveGet(store: DemoBackendStore, pathname: string): DemoRouteResult {
  return (
    resolveGetExact(store, pathname) ??
    resolveGetParameter(store, pathname) ??
    fallthrough(pathname)
  );
}

function resolveCreateConversation(
  store: DemoBackendStore,
  readBody: () => unknown
): DemoRouteResult {
  const body = readBody() as { id?: string; title?: string; epochPublicKey?: string } | undefined;
  if (body?.id === undefined || body.epochPublicKey === undefined) return { kind: 'notFound' };
  return {
    kind: 'json',
    status: 201,
    body: store.createConversation({
      id: body.id,
      epochPublicKey: body.epochPublicKey,
      ...(body.title === undefined ? {} : { title: body.title }),
    }),
  };
}

function resolveChatStream(
  store: DemoBackendStore,
  conversationId: string,
  readBody: () => unknown
): DemoRouteResult {
  const body = readBody() as
    | { userMessage?: { id: string; content: string }; models?: string[] }
    | undefined;
  if (body?.userMessage === undefined) return { kind: 'notFound' };
  const turn = store.recordSendTurn(
    conversationId,
    body.userMessage,
    body.models?.[0] ?? 'demo-model'
  );
  return turn === undefined
    ? { kind: 'notFound' }
    : {
        kind: 'stream',
        frames: buildSseTurnFrames(turn),
        delayMs: STREAM_FRAME_DELAY_MS,
        leadDelayMs: turn.isMedia ? MEDIA_GENERATION_DELAY_MS : 0,
      };
}

function resolveRegenerate(
  store: DemoBackendStore,
  conversationId: string,
  readBody: () => unknown
): DemoRouteResult {
  const body = readBody() as
    | { targetMessageId?: string; replaceAssistantId?: string; models?: string[] }
    | undefined;
  if (body?.targetMessageId === undefined) return { kind: 'notFound' };
  const turn = store.recordRegenerateTurn({
    conversationId,
    targetMessageId: body.targetMessageId,
    ...(body.replaceAssistantId === undefined
      ? {}
      : { replaceAssistantId: body.replaceAssistantId }),
    ...(body.models === undefined ? {} : { models: body.models }),
  });
  return turn === undefined
    ? { kind: 'notFound' }
    : {
        kind: 'stream',
        frames: buildSseTurnFrames(turn),
        delayMs: STREAM_FRAME_DELAY_MS,
        leadDelayMs: turn.isMedia ? MEDIA_GENERATION_DELAY_MS : 0,
      };
}

function resolvePost(
  store: DemoBackendStore,
  pathname: string,
  readBody: () => unknown
): DemoRouteResult {
  if (pathname === '/api/keys/batch') {
    const parsed = readBody() as { conversationIds?: string[] } | undefined;
    return { kind: 'json', body: store.getKeyChainBatch(parsed?.conversationIds ?? []) };
  }
  if (pathname === '/api/conversations') return resolveCreateConversation(store, readBody);
  const streamId = parameter(CHAT_STREAM_RE, pathname);
  if (streamId !== null) return resolveChatStream(store, streamId, readBody);
  const regenId = parameter(CHAT_REGEN_RE, pathname);
  if (regenId !== null) return resolveRegenerate(store, regenId, readBody);
  return fallthrough(pathname);
}

/** Map a request to a demo response. `readBody` lazily parses the POST JSON body. */
export function resolveDemoRoute(
  store: DemoBackendStore,
  method: string,
  pathname: string,
  readBody: () => unknown
): DemoRouteResult {
  const m = method.toUpperCase();
  if (m === 'GET') return resolveGet(store, pathname);
  if (m === 'POST') return resolvePost(store, pathname, readBody);
  return fallthrough(pathname);
}

interface DescribedRequest {
  pathname: string;
  method: string;
  readBody: () => unknown;
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input;
}

function describeRequest(input: RequestInfo | URL, init?: RequestInit): DescribedRequest {
  const url = new URL(requestUrl(input), globalThis.location.href);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const bodySource = init?.body;
  const readBody = (): unknown => {
    if (typeof bodySource !== 'string') return undefined;
    try {
      return JSON.parse(bodySource);
    } catch {
      return undefined;
    }
  };
  return { pathname: url.pathname, method, readBody };
}

/** Patch `globalThis.fetch`. Returns an uninstaller that restores the original. */
export function installFetchShim(store: DemoBackendStore): () => void {
  // Capture the exact reference (not a bound copy) so uninstall fully restores
  // it; `fetch` is safe to invoke unbound.
  const original = globalThis.fetch;

  const shim: typeof globalThis.fetch = async (input, init) => {
    const { pathname, method, readBody } = describeRequest(input, init);
    const route = resolveDemoRoute(store, method, pathname, readBody);
    switch (route.kind) {
      case 'passthrough': {
        return original(input, init);
      }
      case 'notFound': {
        return new Response(null, { status: 404 });
      }
      case 'json': {
        return Response.json(route.body, { status: route.status ?? 200 });
      }
      case 'stream': {
        return new Response(createSseStream(route.frames, route.delayMs, route.leadDelayMs), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
    }
  };

  globalThis.fetch = shim;
  return () => {
    globalThis.fetch = original;
  };
}
