import { requireEnv } from './env.js';
import { idempotentPost } from './idempotent-request.js';
import { expectOkResponse } from './ok-response.js';
import { withRequestRetry } from './resilient-request.js';
import type { APIRequestContext, APIResponse } from '@playwright/test';

const API_BASE = requireEnv('VITE_API_URL');

/**
 * The one construction of the `POST /dev/wallet-balance` request.
 *
 * It exists to be the only one. Every caller of that route under the E2E tree
 * builds the call here, because a caller building it for itself would be a
 * second copy that has to keep agreeing with the first about the path, the
 * body's field names and the retry. That copy would be structural rather than
 * textual, which is the class of duplication a text comparison does not see.
 *
 * It sits in its own module rather than in `exact-money.ts` because
 * `exact-money.ts` already imports `budget.ts`, so putting it there would have
 * forced the import back the other way and closed a cycle.
 *
 * The URL is absolute rather than `baseURL`-relative so the construction is
 * whole here and does not depend on how a caller built its context.
 * `VITE_API_URL` is the same value the contexts set as their `baseURL`.
 *
 * What it deliberately does NOT do, because a module made to break a cycle is
 * exactly the kind that accretes:
 *
 *  - It does not brand, register or freeze. Only the reads in `exact-money.ts`
 *    may say a payload came off the wire, and the checked export returns
 *    `unknown` so that calling it directly buys nothing a comparator will
 *    accept.
 *  - It does not state the response shape. That is the route's own published
 *    result type, stated once in `ServedSeededBalance` where the amount is read.
 *  - It does not read a balance or assert anything, and it grows no export that
 *    is a second CALL. The two exports are one call under the two error
 *    postures its callers have: a seed a spec depends on fails loudly, and a
 *    fixture's best-effort zeroing stays silent. A second dev call belongs
 *    beside its own caller, not here.
 */
function sendWalletBalanceSeed(
  request: APIRequestContext,
  email: string,
  walletType: 'purchased' | 'free_tier',
  balance: string
): Promise<APIResponse> {
  return idempotentPost(withRequestRetry(request), `${API_BASE}/dev/wallet-balance`, {
    data: { email, walletType, balance },
  });
}

/** Seed a wallet balance, failing loudly if the route refuses. */
export async function postWalletBalanceSeed(
  request: APIRequestContext,
  email: string,
  walletType: 'purchased' | 'free_tier',
  balance: string
): Promise<unknown> {
  const response = await sendWalletBalanceSeed(request, email, walletType, balance);
  await expectOkResponse(response, 'postWalletBalanceSeed');
  return response.json();
}

/**
 * Seed a wallet balance without checking the outcome, for a best-effort seed
 * that must not fail its caller: the fixture module's wallet zeroing runs in a
 * fixture's setup and again in its teardown, so a non-2xx becoming a throw
 * there would fail tests that are not about the seed — including after their
 * own body has already passed.
 *
 * The response never leaves this module and no status is read, so no status
 * this route can return reaches a caller as a throw. A transport failure does
 * reach one: {@link withRequestRetry} retries a dropped connection and rethrows
 * one it cannot settle.
 */
export async function postWalletBalanceSeedUnchecked(
  request: APIRequestContext,
  email: string,
  walletType: 'purchased' | 'free_tier',
  balance: string
): Promise<void> {
  await sendWalletBalanceSeed(request, email, walletType, balance);
}
