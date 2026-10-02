// Run-start outcomes to HTTP status: the route mapping each refusal the conversation
// room can answer, and the taxonomy pins that keep the table exhaustive.
import { beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN_ERROR_CODE_TO_WIRE_CODE, ERROR_CODES } from '@hushbox/shared';
import { errAsync } from '../../lib/result/index.js';
import { DOMAIN_ERROR_CODES, unavailableError } from '../../lib/errors/index.js';
import { RUN_REFUSAL_STATUS } from './routes/refusals.js';
import {
  MODEL,
  STARTED,
  cookie,
  fakeRealtime,
  post,
  seedConversation,
  seedModel,
  seedPurchasedWallet,
  seedUser,
} from '../../test-support/chat-routes.integration.setup.js';
import type { RealtimeBroadcast } from '../conversations/index.js';
import type { DomainError } from '../../lib/errors/index.js';
import type { ErrorCode } from '@hushbox/shared';
import type { AdmissionRefusalReason } from '../billing/index.js';

describe('chat route: POST /chat', () => {
  it('maps a concurrent-run rejection to 409', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime({ started: false, code: 'CONCURRENT_RUN' }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'CONCURRENT_RUN' });
  });

  it('maps an admission refusal to a synchronous 402 (never only a WS event)', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime({ started: false, code: 'INSUFFICIENT_ADMISSION' }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: 'INSUFFICIENT_ADMISSION' });
  });

  it('maps an admission-unavailable refusal to a synchronous 503', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime({ started: false, code: 'ADMISSION_UNAVAILABLE' }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'ADMISSION_UNAVAILABLE' });
  });

  it('maps a trial-capacity refusal to a synchronous 429', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime({ started: false, code: 'TRIAL_CAPACITY_REACHED' }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ code: 'TRIAL_CAPACITY_REACHED' });
  });

  it('maps a realtime transport failure to 503', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const errorRealtime: RealtimeBroadcast = {
      ...fakeRealtime(STARTED),
      startRun: () => errAsync(unavailableError('conversation room unreachable')),
    };
    const res = await post(
      errorRealtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        turnSources: [{ kind: 'model', id: MODEL }],
        userMessage: { content: 'hello' },
      }
    );
    expect(res.status).toBe(503);
  });
});

/**
 * Every wire code the run-start refusal lookup can see, traced to its producer
 * rather than copied off the table it guards. The conversation room answers
 * `{ ok: false, code }` from exactly three places — the in-memory
 * concurrent-run block, the run referee's conflict arm, and the run handle's
 * `admitted` promise — and the adapter's 409 body schema gates only registry
 * membership, so whatever those three carry arrives here intact. A code with no
 * row falls through to 409, which is how a payable refusal has silently become
 * a conflict more than once.
 */
describe('chat route: every run-start refusal answers a decided status', () => {
  beforeAll(seedModel);

  /**
   * A sender of its own per case. The per-user send limiter admits 30 a minute,
   * and one shared sender across an enumeration this size trips it — every
   * assertion below would then compare one 429 against another and hold
   * whatever the table said.
   */
  async function ownSender(): Promise<(realtime: RealtimeBroadcast) => Promise<Response>> {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const sessionCookie = await cookie(userId);
    return (realtime) =>
      post(
        realtime,
        { cookie: sessionCookie, 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          turnSources: [{ kind: 'model', id: MODEL }],
          userMessage: { content: 'hello' },
        }
      );
  }

  /**
   * The codes each producer carries as a literal, with the status the route owes
   * them.
   */
  const LITERAL_REFUSALS: readonly (readonly [ErrorCode, number])[] = [
    // The DO's synchronous one-run block.
    [ERROR_CODES.CONCURRENT_RUN, 409],
    // The referee's conflict arm — both idempotency wire codes.
    [ERROR_CODES.IDEMPOTENCY_BODY_MISMATCH, 409],
    [ERROR_CODES.REQUEST_IN_PROGRESS, 409],
    // The paid admission hook's refusals, one per condition.
    [ERROR_CODES.INSUFFICIENT_ADMISSION, 402],
    [ERROR_CODES.RUN_CAPACITY_REACHED, 402],
    [ERROR_CODES.DAILY_ALLOWANCE_EXHAUSTED, 402],
    [ERROR_CODES.GROUP_ALLOCATION_EXHAUSTED, 402],
    // Redis-down, fail-closed, from either admission hook.
    [ERROR_CODES.ADMISSION_UNAVAILABLE, 503],
    // The trial hook's quota refusal.
    [ERROR_CODES.TRIAL_CAPACITY_REACHED, 429],
    // The engine's post-`done` backstop, when a defect escapes before the
    // admission decision and settles `admitted` on the way out.
    [ERROR_CODES.INTERNAL, 500],
  ];

  /**
   * Two facts, stated separately because this object only carries the first.
   *
   * It breaks the build when a refusal reason is ADDED:
   * `Record<AdmissionRefusalReason, ErrorCode>` stops compiling, and filling in
   * the new member forces its wire code into the row-presence check below.
   *
   * It cannot detect a CHANGED mapping. This restates the reason-to-code mapping
   * that `admissionRefusalCode` owns (module-private in `chat/domain/runtime.ts`,
   * so unreachable from a test), and nothing compares the two: give an existing
   * reason a different wire code there and every case here stays green while the
   * route answers that code through the `?? 409` fallthrough. Closing that needs
   * the real function iterated over the reason union, not a wider assertion here.
   */
  const ADMISSION_REFUSAL_REASONS: Readonly<Record<AdmissionRefusalReason, ErrorCode>> = {
    'insufficient-balance': ERROR_CODES.INSUFFICIENT_ADMISSION,
    'run-cap': ERROR_CODES.RUN_CAPACITY_REACHED,
    'allowance-exceeded': ERROR_CODES.DAILY_ALLOWANCE_EXHAUSTED,
    'member-budget-exceeded': ERROR_CODES.GROUP_ALLOCATION_EXHAUSTED,
    'conversation-budget-exceeded': ERROR_CODES.GROUP_ALLOCATION_EXHAUSTED,
  };

  it.each(LITERAL_REFUSALS)('answers a %s refusal with %i', async (code, status) => {
    const send = await ownSender();
    const res = await send(fakeRealtime({ started: false, code }));
    // The body first, because the status alone cannot say which refusal
    // answered: the row whose status is 429 is satisfied by any limiter's 429,
    // and would then hold whatever the table said rather than what the route
    // decided.
    expect(await res.json()).toEqual({ code });
    expect(res.status).toBe(status);
  });

  it.each([...DOMAIN_ERROR_CODES])(
    'answers a refused %s the same way the failed call carrying it answers',
    async (domainCode) => {
      // The admission hook projects any non-`unavailable` DomainError onto
      // `domainWireCode(error)`, so a refusal carrying that wire code and the
      // transport failure carrying the error itself must land on one status.
      const wireCode = DOMAIN_ERROR_CODE_TO_WIRE_CODE[domainCode];
      const failed = { code: domainCode, message: 'admission infrastructure failure' };
      const send = await ownSender();
      const viaError = await send(
        fakeRealtime(STARTED, { startRun: () => errAsync(failed as DomainError) })
      );
      const viaRefusal = await send(fakeRealtime({ started: false, code: wireCode }));

      // Read the bodies first: a parity check is vacuous if something upstream
      // of the lookup answered both sides, and the limiter's 429 would satisfy
      // it either way. Its body carries `details`, so a bare `{ code }` pins
      // that both responses really came from the paths under test.
      expect(await viaError.json()).toEqual({ code: wireCode });
      expect(await viaRefusal.json()).toEqual({ code: wireCode });
      expect(viaRefusal.status).toBe(viaError.status);
    }
  );

  it('holds a row for every code the taxonomy arm can project', () => {
    for (const domainCode of DOMAIN_ERROR_CODES) {
      expect(RUN_REFUSAL_STATUS).toHaveProperty(DOMAIN_ERROR_CODE_TO_WIRE_CODE[domainCode]);
    }
  });

  it('holds a row for every code a producer carries as a literal', () => {
    for (const [code] of LITERAL_REFUSALS) {
      expect(RUN_REFUSAL_STATUS).toHaveProperty(code);
    }
  });

  it('holds a row for the code every admission refusal reason answers', () => {
    for (const code of Object.values(ADMISSION_REFUSAL_REASONS)) {
      expect(RUN_REFUSAL_STATUS).toHaveProperty(code);
    }
  });
});
