import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { z } from 'zod';
import { LINK_CREDENTIAL_HEADER } from '@hushbox/shared';
import { createApp } from '../app.js';
import { callerIpIdForAddress } from '../lib/redis/index.js';
import { CHAT_GUEST_SEND_IP_RATE_LIMIT, CHAT_STOP_IP_RATE_LIMIT } from '../slices/chat/index.js';
import { issueSession } from '../slices/identity/index.js';
import { guestConversationIpRateLimit } from '../slices/conversations/index.js';
import { mintLinkCredential } from '../test-support/link-credential.js';
import { rateLimitKey } from '../lib/rate-limit/index.js';
import type { RateLimitDefinition } from '../lib/rate-limit/index.js';
import type { Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`guest rate-limit tests: missing ${name}. Run via a package test script.`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');
const UPSTASH_REDIS_REST_URL = requiredEnv('UPSTASH_REDIS_REST_URL');
const UPSTASH_REDIS_REST_TOKEN = requiredEnv('UPSTASH_REDIS_REST_TOKEN');

const SECRET = 'secret-at-least-32-characters-long!!';

const devEnv: Bindings &
  TelemetryEnv & { FRONTEND_URL: string; MARKETING_URL: string; FRONTEND_PREVIEW_URL: string } = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
  // The composed pipeline runs CORS first; it fail-fasts on absent web origins.
  FRONTEND_URL: requiredEnv('FRONTEND_URL'),
  MARKETING_URL: requiredEnv('MARKETING_URL'),
  FRONTEND_PREVIEW_URL: requiredEnv('FRONTEND_PREVIEW_URL'),
};

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const refusalBodySchema = z.object({
  code: z.string(),
  details: z.object({ retryAfterSeconds: z.number() }),
});

const keysToClean: string[] = [];
afterAll(async () => {
  if (keysToClean.length > 0) await redis.del(...keysToClean);
});

/**
 * A well-formed credential that resolves to no live link: the token of a link
 * never seeded. Well-formed matters: a credential that fails base64 decoding or
 * the token length short-circuits to "no guest" without ever reaching
 * `shared_links`, so it could not tell a refused query apart from an unreached one.
 */
function unknownLinkCredential(): string {
  return mintLinkCredential().token;
}

/**
 * A per-case caller identity, hashed into the limiter key. It is not an IPv6
 * literal, so the identity hashes it verbatim rather than collapsing it to a
 * /64. One uuid per case is what keeps this suite's enumeration honest: every
 * case starts on its own empty window, so no case can be answered by a
 * neighbour's exhausted one.
 */
function caseIp(label: string): string {
  return `guest-ratelimit-${label}-${crypto.randomUUID()}`;
}

interface GuestRouteCase {
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly definition: RateLimitDefinition;
}

/**
 * The one proof each guest-reachable route owes: an UNAUTHORIZED credential is
 * answered 401 while the window is open — which only the `shared_links`
 * resolution can produce — and 429 once the window is at its cap, so the
 * refusal demonstrably precedes that query rather than following it.
 */
async function assertRefusedBeforeCredentialQuery(routeCase: GuestRouteCase): Promise<void> {
  const app = createApp();
  const ip = caseIp(routeCase.path.replaceAll(/\W/g, ''));
  const key = rateLimitKey(routeCase.definition, await callerIpIdForAddress(ip))._unsafeUnwrap();
  keysToClean.push(key);
  await redis.del(key);

  const request = {
    method: routeCase.method,
    headers: { ...routeCase.headers, 'cf-connecting-ip': ip },
    ...(routeCase.body === undefined ? {} : { body: routeCase.body }),
  };

  const resolved = await app.request(routeCase.path, request, devEnv);
  expect(resolved.status).toBe(401);

  const { maxAttempts, windowSeconds } = routeCase.definition;
  await redis.set(key, maxAttempts, { ex: windowSeconds });

  const refused = await app.request(routeCase.path, request, devEnv);
  expect(refused.status).toBe(429);
  const body = refusalBodySchema.parse(await refused.json());
  expect(body.code).toBe('RATE_LIMITED');
  expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
}

const jsonHeaders = (): Record<string, string> => ({
  'content-type': 'application/json',
  'idempotency-key': crypto.randomUUID(),
  [LINK_CREDENTIAL_HEADER]: unknownLinkCredential(),
});

/**
 * A cookie for a session the app will accept: the composed pipeline enforces
 * session liveness, so a sealed-but-never-issued cookie is refused and would
 * make a full principal unreachable here. The Redis liveness key is tracked for
 * cleanup rather than logged out, so the assertion never depends on a second
 * request succeeding.
 */
async function liveSessionCookie(): Promise<string> {
  const response = new Response();
  const issued = await issueSession({
    request: new Request('http://localhost/'),
    response,
    redis,
    secret: SECRET,
    isProduction: false,
    userId: crypto.randomUUID(),
    kind: 'full',
    now: Date.now(),
  });
  if (issued.isErr()) throw new Error('guest rate-limit tests: session issue failed');
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

/**
 * The live-session half of the `sessionless-ip` identity: with the IP window
 * already at its cap, a full principal is admitted past the route's IP layer
 * and leaves that counter exactly where it was.
 *
 * Pinned per route rather than argued once, because the identity's skip is
 * only safe where a full principal reaches no credential resolution — and what
 * a route does with a full principal is a fact about that route. Redeclaring
 * either route on the unconditional `ip` identity turns both assertions red,
 * which is the point: an IP cap that counted signed-in callers would throttle
 * every user behind one NAT.
 */
async function assertLiveSessionSkipsIpWindow(routeCase: GuestRouteCase): Promise<void> {
  const app = createApp();
  const ip = caseIp(`session-${routeCase.path.replaceAll(/\W/g, '')}`);
  const key = rateLimitKey(routeCase.definition, await callerIpIdForAddress(ip))._unsafeUnwrap();
  keysToClean.push(key);
  const { maxAttempts, windowSeconds } = routeCase.definition;
  await redis.set(key, maxAttempts, { ex: windowSeconds });

  const response = await app.request(
    routeCase.path,
    {
      method: routeCase.method,
      headers: { ...routeCase.headers, 'cf-connecting-ip': ip, cookie: await liveSessionCookie() },
      ...(routeCase.body === undefined ? {} : { body: routeCase.body }),
    },
    devEnv
  );

  expect(response.status).not.toBe(429);
  expect(await redis.get<number>(key)).toBe(maxAttempts);
}

describe('composed app: the sessionless IP layer skips a live session', () => {
  it('admits the guest send from a full principal past an exhausted IP window', async () => {
    await assertLiveSessionSkipsIpWindow({
      path: '/chat/guest',
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        conversationId: crypto.randomUUID(),
        turnSources: [{ kind: 'model', id: 'answer-model' }],
        userMessage: { content: 'hello' },
      }),
      definition: CHAT_GUEST_SEND_IP_RATE_LIMIT,
    });
  });

  it('admits the run stop from a full principal past an exhausted IP window', async () => {
    await assertLiveSessionSkipsIpWindow({
      path: '/chat/stop',
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ conversationId: crypto.randomUUID() }),
      definition: CHAT_STOP_IP_RATE_LIMIT,
    });
  });
});

describe('composed app: guest-reachable routes refuse before resolving the credential', () => {
  it('caps the guest send per IP ahead of its link lookup', async () => {
    await assertRefusedBeforeCredentialQuery({
      path: '/chat/guest',
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        conversationId: crypto.randomUUID(),
        turnSources: [{ kind: 'model', id: 'answer-model' }],
        userMessage: { content: 'hello' },
      }),
      definition: CHAT_GUEST_SEND_IP_RATE_LIMIT,
    });
  });

  it('caps the run stop per IP ahead of its link lookup', async () => {
    await assertRefusedBeforeCredentialQuery({
      path: '/chat/stop',
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ conversationId: crypto.randomUUID() }),
      definition: CHAT_STOP_IP_RATE_LIMIT,
    });
  });

  it('caps the guest funding read per IP ahead of its link lookup', async () => {
    await assertRefusedBeforeCredentialQuery({
      path: `/conversations/${crypto.randomUUID()}/funding`,
      method: 'GET',
      headers: { [LINK_CREDENTIAL_HEADER]: unknownLinkCredential() },
      definition: guestConversationIpRateLimit,
    });
  });

  it('caps the realtime upgrade per IP ahead of its link lookup', async () => {
    await assertRefusedBeforeCredentialQuery({
      path: `/conversations/${crypto.randomUUID()}/websocket`,
      method: 'GET',
      headers: { [LINK_CREDENTIAL_HEADER]: unknownLinkCredential() },
      definition: guestConversationIpRateLimit,
    });
  });

  it('caps the guest message read per IP ahead of its link lookup', async () => {
    await assertRefusedBeforeCredentialQuery({
      path: `/conversations/${crypto.randomUUID()}/messages`,
      method: 'GET',
      headers: { [LINK_CREDENTIAL_HEADER]: unknownLinkCredential() },
      definition: guestConversationIpRateLimit,
    });
  });

  // The remaining guest-reachable conversation reads, one case each: the cap is
  // declared per route key, so covering the set is the only thing that says the
  // set is covered.
  it.each([
    ['the conversation read', ''],
    ['the member list', '/members'],
    ['the keychain read', '/keychain'],
    ['the member-key read', '/member-keys'],
    ['the display-name read', '/my-name'],
    ['the link list', '/links'],
  ])('caps %s per IP ahead of its link lookup', async (_name, suffix) => {
    await assertRefusedBeforeCredentialQuery({
      path: `/conversations/${crypto.randomUUID()}${suffix}`,
      method: 'GET',
      headers: { [LINK_CREDENTIAL_HEADER]: unknownLinkCredential() },
      definition: guestConversationIpRateLimit,
    });
  });
});

describe('composed app: the guest cap leaves the public share read alone', () => {
  it('admits a share read from an IP whose guest window is at its cap', async () => {
    const app = createApp();
    const ip = caseIp('sharereadunaffected');
    const key = rateLimitKey(
      guestConversationIpRateLimit,
      await callerIpIdForAddress(ip)
    )._unsafeUnwrap();
    keysToClean.push(key);
    const { maxAttempts, windowSeconds } = guestConversationIpRateLimit;
    await redis.set(key, maxAttempts, { ex: windowSeconds });

    const res = await app.request(
      `/conversations/shared/message/${crypto.randomUUID()}`,
      { headers: { 'cf-connecting-ip': ip } },
      devEnv
    );
    expect(res.status).not.toBe(429);
  });
});
