/**
 * Every fetch door of `e2e/helpers/exact-money.ts`, driven for real.
 *
 * A door's `noteMoneyRead` call is the gate's entire "touched money" half, so
 * deleting one silently disables the gate for every read behind it while every
 * other test stays green. That is the failure this file exists to make loud: it
 * drives each door and asserts the ledger names it, so each deletion reddens a
 * test of its own. That holds only while every door has a case here, so a door
 * added to that module earns one in the same change.
 *
 * A door is a plain async function over an `APIRequestContext`, so a canned
 * context reaches it without a browser, a server or the Playwright runner —
 * which is why this test lives here, in the package that has a unit runner,
 * rather than in `@hushbox/e2e`, which has none. The same canned context is
 * what lets a door's replay behaviour be driven here too: whether a door
 * presents an `Idempotency-Key` decides whether the suite's shared retry
 * wrapper re-sends it, and a door whose route cannot collapse a replay must
 * present none.
 *
 * The teardown FIXTURE is genuinely out of reach: it is a Playwright
 * auto-fixture, and running one means running Playwright. It is not faked here.
 * What is proven here is that the doors feed the ledger; that the ledger feeds
 * the verdict is proven in `money-gate.test.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import {
  readHold,
  readMoneyState,
  readSettledCharge,
  seedBackdatedUsage,
  seedWalletBalance,
} from '../../../e2e/helpers/exact-money.js';
import { withRequestRetry } from '../../../e2e/helpers/resilient-request.js';
import { resetMoneyLedger, takeMoneyLedger } from './money-gate.js';
import type { CheckedResponse } from '../../../e2e/helpers/ok-response.js';
import type { APIRequestContext, APIResponse } from '@playwright/test';

/**
 * A request context that answers every call with one canned body.
 *
 * `text()` is left off deliberately: the doors read it only on a non-ok
 * response, and this one is always ok, so supplying it would be dead weight a
 * reader has to check against the door.
 */
function cannedRequest(body: unknown): APIRequestContext {
  const response = {
    ok: (): boolean => true,
    status: (): number => 200,
    json: (): Promise<unknown> => Promise.resolve(body),
  } as unknown as APIResponse;
  const respond = (): Promise<APIResponse> => Promise.resolve(response);
  return { get: respond, post: respond } as unknown as APIRequestContext;
}

/**
 * A request context whose first POST answers with the runtime envelope a
 * recycling worker returns and whose later ones succeed, counting what it
 * received.
 *
 * 503 is a status {@link withRequestRetry} re-sends when — and only when — the
 * call it wraps is one the server can recognise as a replay, so the count this
 * hands back is what separates a door that is re-sent from a door that is not.
 */
function recyclingRequest(body: unknown): {
  request: APIRequestContext;
  posts: () => number;
} {
  let posts = 0;
  const post = (): Promise<CheckedResponse & Pick<APIResponse, 'json'>> => {
    posts += 1;
    const accepted = posts > 1;
    return Promise.resolve({
      ok: (): boolean => accepted,
      status: (): number => (accepted ? 201 : 503),
      headers: (): Record<string, string> => ({ 'content-type': 'text/plain;charset=UTF-8' }),
      json: (): Promise<unknown> => Promise.resolve(body),
      text: (): Promise<string> => Promise.resolve('the runtime restarted mid-request'),
    });
  };
  return { request: { post } as unknown as APIRequestContext, posts: (): number => posts };
}

const BALANCE_BODY = {
  purchased: { balanceNanoUsd: '1000' },
  free: { balanceNanoUsd: '0' },
  allowance: { remainingNanoUsd: '0' },
};

const FUNDING_BODY = { spendableNanoUsd: '5000', heldNanoUsd: '2000', payer: 'self' };

const SEEDED_USAGE_BODY = { usageRecordsCreated: 1, totalChargedNanoUsd: '2500000000' };

const OWNER_EMAIL = 'someone@example.test';

const BACKDATED_RECORD = {
  modelId: 'seeded/backdated-history',
  providerName: 'seeded',
  costNanoUsd: '2500000000',
  inputTokens: 1000,
  outputTokens: 1000,
  createdAt: isoAt(TEST_DAY_START - 30 * DAY_MS),
};

beforeEach(() => {
  resetMoneyLedger();
});

describe('every fetch door announces its read to the teardown gate', () => {
  it('records a read through the shared JSON door under the name of that read', async () => {
    await readSettledCharge(cannedRequest({ cost: '0.000001150' }), 'a-conversation');
    await readMoneyState(cannedRequest(BALANCE_BODY));

    expect(takeMoneyLedger().reads).toEqual(['readSettledCharge', 'readMoneyState']);
  });

  it('records the hold read, which fetches through budget.ts and not that door', async () => {
    await readHold(cannedRequest(FUNDING_BODY), 'a-conversation');

    expect(takeMoneyLedger().reads).toEqual(['readHold']);
  });

  it('records the wallet seed, whose applied amount a spec goes on to price from', async () => {
    await seedWalletBalance(
      cannedRequest({ newBalance: '10.000000000' }),
      OWNER_EMAIL,
      'purchased',
      '10.00'
    );

    expect(takeMoneyLedger().reads).toEqual(['seedWalletBalance']);
  });

  it('records the usage-history seed, whose reported charge a spec goes on to price from', async () => {
    await seedBackdatedUsage(cannedRequest(SEEDED_USAGE_BODY), OWNER_EMAIL, 'a-conversation', [
      BACKDATED_RECORD,
    ]);

    expect(takeMoneyLedger().reads).toEqual(['seedBackdatedUsage']);
  });
});

describe('a seed the server cannot recognise as a replay is sent once', () => {
  it('surfaces the usage seed transient instead of re-posting rows that would be inserted twice', async () => {
    const { request, posts } = recyclingRequest(SEEDED_USAGE_BODY);

    await expect(
      seedBackdatedUsage(withRequestRetry(request), OWNER_EMAIL, 'a-conversation', [
        BACKDATED_RECORD,
      ])
    ).rejects.toThrow('503');

    expect(posts()).toBe(1);
  });
});
