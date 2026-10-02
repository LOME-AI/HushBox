import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { LINK_CREDENTIAL_HEADER } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { routeClass } from '../../middleware/pipeline-markers.js';
import {
  BILLING_PORTAL_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '../../middleware/pipeline-session.js';
import { BILLING_RATE_LIMITS } from './domain/rate-limit.js';
import { BILLING_ROUTE_POSTURES } from './index.js';
import { mintLinkCredential } from '../../test-support/link-credential.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for the billing posture integration test'
  );
}

const SECRET = 'secret-at-least-32-characters-long!!';
const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

const CHARGE_PATH = '/billing/payments';

const IP_CAP = BILLING_RATE_LIMITS.cardChargeIpRateLimit.maxAttempts;
const ACCOUNT_CAP = BILLING_RATE_LIMITS.cardChargeAccountRateLimit.maxAttempts;

/**
 * The charge route's own posture, mounted on a handler that does nothing: this
 * exercises what the declaration bounds, and a real charge would add processor
 * and database work the bound is indifferent to.
 */
function chargeApp(): Hono<AppEnv> {
  const app = applyPipeline(new Hono<AppEnv>(), {
    rateLimit: {
      postures: BILLING_ROUTE_POSTURES,
      linkCredentialHeader: LINK_CREDENTIAL_HEADER,
    },
  });
  app.post(CHARGE_PATH, routeClass('billing-token'), (c) => c.json({ admitted: true }));
  return app;
}

// The mobile → web billing-portal handoff presents its own path-scoped
// credential, never a login session; the card-charge route's account layer keys
// on the sealed credential's own userId.
async function billingPortalCookie(userId: string): Promise<string> {
  const sealed = await sealData(
    {
      credentialKind: 'billing-portal',
      userId,
      sessionId: 'credential-1',
      createdAt: Date.now() - 1000,
    },
    { password: SECRET }
  );
  return `${BILLING_PORTAL_COOKIE_NAME}=${sealed}`;
}

async function fullSessionCookie(userId: string): Promise<string> {
  const sealed = await sealData(
    {
      userId,
      sessionId: 'session-1',
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

/**
 * A /64 no other test in this file or run shares, so each case starts on an
 * empty IP window without clearing anything a sibling is counting on.
 */
function freshNetwork(): string {
  const hextet = (): string =>
    crypto.getRandomValues(new Uint16Array(1))[0]!.toString(16).padStart(4, '0');
  return `2001:db8:${hextet()}:${hextet()}::1`;
}

/**
 * A fresh well-formed link auth token: the header a `caller`-keyed layer folds
 * into its identifier, and the one component of such a key a caller chooses. A
 * window keyed on the session claim ignores it, which is what presenting a new
 * one per request is here to show.
 */
function freshLinkCredential(): string {
  return mintLinkCredential().token;
}

interface ChargeRequest {
  readonly cookie: string;
  readonly network: string;
  readonly linkCredential?: string | undefined;
  readonly path?: string | undefined;
}

async function charge(app: Hono<AppEnv>, request: ChargeRequest): Promise<number> {
  const { cookie, network, linkCredential, path } = request;
  const res = await app.request(
    path ?? CHARGE_PATH,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        cookie,
        'x-forwarded-for': network,
        ...(linkCredential === undefined ? {} : { [LINK_CREDENTIAL_HEADER]: linkCredential }),
      },
      body: JSON.stringify({ amountNanoUsd: '5000000000', cardToken: 'tok', customerCode: 'c' }),
    },
    testEnv
  );
  return res.status;
}

/** Every status of `attempts` charges from one caller on one network, in order. */
async function chargeRepeatedly(
  app: Hono<AppEnv>,
  request: ChargeRequest & { readonly attempts: number; readonly rotateCredential: boolean }
): Promise<number[]> {
  const statuses: number[] = [];
  for (let attempt = 0; attempt < request.attempts; attempt += 1) {
    statuses.push(
      await charge(app, {
        ...request,
        ...(request.rotateCredential ? { linkCredential: freshLinkCredential() } : {}),
      })
    );
  }
  return statuses;
}

describe('what bounds the card-charge route', () => {
  it('refuses an undeclared route, so an admission here is one the map granted', async () => {
    // The positive control for every admission below: a stage that never ran
    // would admit these exactly as it admits a declared route, and the two
    // would read identically.
    const app = chargeApp();
    app.post('/billing/undeclared', routeClass('billing-token'), (c) => c.json({ admitted: true }));
    const status = await charge(app, {
      cookie: await billingPortalCookie(crypto.randomUUID()),
      network: freshNetwork(),
      path: '/billing/undeclared',
    });
    expect(status).toBe(429);
  });

  it('refuses a caller that rotates its link credential on every attempt', async () => {
    // The link-credential header enters neither of this route's layers: the
    // address layer never reads it, and the account layer keys on the session
    // claim. Were it read, a fresh header per request would open a fresh
    // counter per request and none of these would be refused; the caller meets
    // its account cap on schedule instead.
    const statuses = await chargeRepeatedly(chargeApp(), {
      cookie: await billingPortalCookie(crypto.randomUUID()),
      network: freshNetwork(),
      attempts: ACCOUNT_CAP + 1,
      rotateCredential: true,
    });
    expect(statuses.filter((status) => status === 429)).toStrictEqual([429]);
    expect(statuses.at(-1)).toBe(429);
  }, 60_000);

  it('refuses a payer at their own account cap while that address still admits another', async () => {
    // What the account cap buys and what it costs, on one caller: a payer
    // alone on an address meets their own window rather than the address
    // window. The last charge is the discriminator — a second account on that
    // same address is admitted, so the address window still had room when the
    // first payer was refused, and the layer that refused was the account one.
    const app = chargeApp();
    const network = freshNetwork();
    const statuses = await chargeRepeatedly(app, {
      cookie: await fullSessionCookie(crypto.randomUUID()),
      network,
      attempts: ACCOUNT_CAP + 1,
      rotateCredential: false,
    });
    expect(statuses.filter((status) => status === 429)).toStrictEqual([429]);
    expect(statuses.at(-1)).toBe(429);

    expect(
      await charge(app, { cookie: await fullSessionCookie(crypto.randomUUID()), network })
    ).toBe(200);
  }, 120_000);

  it('gives the co-located payers sharing one address the whole address window between them', async () => {
    // The population the `billing-token` class serves, and what keeps the
    // address window operative when no single account can exhaust it: it
    // takes several accounts to fill, none of them is refused while it has
    // room, and the newcomer that meets it has an untouched account window —
    // which the fresh address in the last charge is what proves. Every request
    // here carries a link credential of its own, so filling the window is also
    // what shows the address layer never reads that header.
    const app = chargeApp();
    const network = freshNetwork();
    for (let spent = 0; spent < IP_CAP; ) {
      const attempts = Math.min(ACCOUNT_CAP, IP_CAP - spent);
      const statuses = await chargeRepeatedly(app, {
        cookie: await billingPortalCookie(crypto.randomUUID()),
        network,
        attempts,
        rotateCredential: true,
      });
      expect(statuses.filter((status) => status === 429)).toStrictEqual([]);
      spent += attempts;
    }

    const newcomer = await billingPortalCookie(crypto.randomUUID());
    expect(await charge(app, { cookie: newcomer, network })).toBe(429);
    expect(await charge(app, { cookie: newcomer, network: freshNetwork() })).toBe(200);
  }, 120_000);

  it('carries a billing-portal principal’s window with the account across addresses', async () => {
    // The half of the class whose caller is the billing-portal credential, and the case that
    // needs the session claim to be bounded at all: keyed on that claim, the
    // window follows the payer across every address and credential presented
    // rather than starting fresh on each.
    const app = chargeApp();
    const cookie = await billingPortalCookie(crypto.randomUUID());
    const perAddress = Math.ceil(ACCOUNT_CAP / 2);
    for (const network of [freshNetwork(), freshNetwork()]) {
      const statuses = await chargeRepeatedly(app, {
        cookie,
        network,
        attempts: perAddress,
        rotateCredential: true,
      });
      expect(statuses.filter((status) => status === 429)).toStrictEqual([]);
    }
    expect(
      await charge(app, {
        cookie,
        network: freshNetwork(),
        linkCredential: freshLinkCredential(),
      })
    ).toBe(429);
  }, 120_000);

  it('carries a full principal’s window with the account across addresses', async () => {
    // The other half of the class, on a full session: the window follows that
    // principal across addresses, and the refusal lands on a third address
    // that has spent nothing of its own window, so the layer that refused is
    // the account one.
    const app = chargeApp();
    const cookie = await fullSessionCookie(crypto.randomUUID());
    const perAddress = Math.ceil(ACCOUNT_CAP / 2);
    for (const network of [freshNetwork(), freshNetwork()]) {
      const statuses = await chargeRepeatedly(app, {
        cookie,
        network,
        attempts: perAddress,
        rotateCredential: false,
      });
      expect(statuses.filter((status) => status === 429)).toStrictEqual([]);
    }
    expect(await charge(app, { cookie, network: freshNetwork() })).toBe(429);
  }, 120_000);
});
