/**
 * The exact-money assertion vocabulary: read the money the running system
 * actually moved, and compare it to an amount DERIVED from a sanctioned source
 * (Pillar 1, rule 1.6). Deriving is the easy path because
 * the compiler makes it the only one that needs no ceremony: an expected amount
 * is branded and so is each served input a minter prices from, so
 * `expectExactCharge(…, 1150n)` and `mockGenerationCharge({…}, 1)` are both
 * type errors.
 *
 * What that guarantees exactly — read this before relying on it. Every value
 * the vocabulary prices from is branded FIELD BY FIELD, so a hand-written
 * object is refused and so is the easier route, a spread that rewrites one
 * field and carries the rest of the brand through. The same holds for a money
 * state: its components are readings, so a fabricated "before" cannot be handed
 * to {@link expectNoMoneyMoved} to pass over numbers nothing read. Nothing in
 * the vocabulary returns a branded value from data you supplied — the reads
 * below are the only place a brand is applied, each on the line that fetched
 * the payload.
 *
 * **What is refused, and where.** Every entry has a test that plants the route;
 * none of them is a claim about what is left.
 *
 *  - The compiler refuses a literal, hand-rolled arithmetic, a structurally
 *    identical object, `satisfies`, a look-alike brand declared elsewhere, and
 *    a spread that rewrites any served or observed field — each with a
 *    `@ts-expect-error` test beside it in `scripts/lib/money/money.test.ts`.
 *  - The `e2e-money/no-forged-money-input` rule refuses, by asking the TYPE of
 *    a value rather than the spelling of what produced it: an argument that is
 *    `any` or an intersection assembled at the call site; a member write
 *    through a binding whose initialiser was a reading; and a call into a
 *    declaration this codebase does not own that is handed a brand and hands
 *    one back. The reads below are covered too, because a forged request
 *    context (`Object.assign({}, request, { get: cannedGet })`) makes a read
 *    mint a brand over numbers the running system never served, and no later
 *    assertion can tell. Its reach is exactly the names its list holds, so the
 *    list is derived through the compiler's checker from this module's and
 *    `scripts/lib/money/money.ts`'s exports, and gated by a test — one that also fails on any
 *    callable export the derivation did not admit and no one classified, so a
 *    read added here in a shape the checker walk misses is named rather than
 *    left unprotected.
 *  - The vocabulary itself refuses at runtime, which is where the guarantee
 *    lives: every read below that returns a PAYLOAD hands it to `asReading`,
 *    which records and freezes it, and every comparator refuses a payload it
 *    was not handed by a read. The two that return an AMOUNT
 *    ({@link readSettledCharge}, {@link readHold}) register nothing — a bigint
 *    has no identity to record — so a forged amount is refused only by the type
 *    system and by `compareHoldCoverage`'s runtime check. That is two refusals closing two halves — a payload
 *    that never came from a read, and a payload that did and was then rewritten
 *    in place. Both hold against a forgery parked where a type predicate cannot
 *    look: on a property, in a destructure, in a binding assigned a statement
 *    later, or inside a helper the spec wrote itself. `compareHoldCoverage`
 *    adds a third, refusing a non-bigint: it orders with `>=`, which coerces
 *    where its siblings' `!==` reports a divergence.
 *
 * **What is known and not refused**, in full in `scripts/lib/money/money.ts`'s
 * header. The two worth knowing here: a cast of an AMOUNT and a direct
 * `asReading` call are deliberately open and both are greppable — a cast of a
 * PAYLOAD is refused, since nothing registered it; and a forged request CONTEXT
 * is not refused at runtime at all — it makes a read brand and register a
 * payload the running system never served. The lint rule reports one spelling
 * of it (`Object.assign({}, request, { get: cannedGet })`) and cannot see the
 * other: intercepting the routes the reads below fetch hands the honest context
 * a fabricated payload, and every value at the call site is then genuinely a
 * reading. This list is what is known, not what exists.
 *
 * The derivation minters and the comparison logic live in
 * `scripts/lib/money/money.ts`, where they are unit-tested; this module is the
 * reads and the polling around them. Import the minters from here so a spec has
 * one import for the whole vocabulary.
 *
 * Every read goes through a typed dev or product route. Nothing here scrapes a
 * rendered number: a badge is the display side of the money, and comparing
 * display to display proves nothing about what the wallet lost.
 *
 * **The forged request context is an accepted residual, not an open item.** Closing
 * it would mean the runtime telling a real request context from a fabricated one,
 * and any marker it could look for is mintable by whatever fabricated the context —
 * the check would cost ceremony at every read while the forgery mints the marker
 * too. What this vocabulary is built to refuse is the mistake an author makes
 * without meaning to; standing up a fake transport underneath a read is a decision,
 * and a decision is caught in review, not by a type.
 */

import {
  MONEY_ASSERTION_HOLDS,
  asReading,
  assertServedChargeBasis,
  compareBalanceDelta,
  compareChargeAttribution,
  compareDelegatedBudget,
  compareExactCharge,
  compareHoldCoverage,
  compareMoneyState,
  compareNoMoneyMoved,
  compareNoWalletMovement,
  nanoUsdFromDecimalString,
  nanoUsdFromWire,
  pickModelPricing,
} from '../../scripts/lib/money/money.js';
import { noteMoneyRead } from '../../scripts/lib/money/money-gate.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { getFundingSnapshot } from './budget.js';
import { postWalletBalanceSeed } from './dev-wallet-balance.js';
import { requireEnv } from './env.js';
import { expect } from './expect.js';
import { expectOkResponse } from './ok-response.js';
import { withRequestRetry } from './resilient-request.js';
import type {
  ChargeAttribution,
  ChargeAttributionRow,
  DerivedNanoUsd,
  MemberDelegation,
  MoneyExpectation,
  MoneyState,
  ObservedNanoUsd,
  ServedAttributionRow,
  ServedChargeBasis,
  ServedModelPricing,
  ServedSeededBalance,
  ServedSeededUsage,
} from '../../scripts/lib/money/money.js';
import type { GetBalanceResponse } from '@hushbox/shared';
import type { APIRequestContext } from '@playwright/test';

export {
  allowedMinimumDeposit,
  catalogPerImageCharge,
  grantedDailyFreeAllowance,
  grantedWelcomeCredit,
  mockGenerationCharge,
  mockTextTurnCharge,
  seededUsageCharge,
  seededWalletBalance,
  spendOf,
  storedMediaCharge,
  storedTextCharge,
  sumOfCharges,
} from '../../scripts/lib/money/money.js';
export type { DerivedNanoUsd } from '../../scripts/lib/money/money.js';

const API_BASE = requireEnv('VITE_API_URL');

async function readJson<T>(request: APIRequestContext, path: string, what: string): Promise<T> {
  // A fetch door, and every door in this module tells the teardown gate that
  // this test looked at money. Announced on the line that fetches rather than
  // in a list of reads kept elsewhere: a read added here is covered by the door
  // it already goes through.
  noteMoneyRead(what);
  const response = await withRequestRetry(request).get(`${API_BASE}${path}`);
  await expectOkResponse(response, what);
  return (await response.json()) as T;
}

/**
 * The only place an amount becomes a reading, called only on a value that has
 * just come back from the wire. It is a cast because no exported minter for the
 * observed brand exists anywhere — which is what makes a fabricated reading
 * cost an author a visible `as` of their own.
 */
function observed(amount: bigint): ObservedNanoUsd {
  return amount as ObservedNanoUsd;
}

/**
 * What the mock provider declares it charges and echoes. Every text-turn
 * derivation starts here, so a change to the mock moves every expectation with
 * it instead of leaving a stale number behind in ten specs.
 */
export async function readMockChargeBasis(request: APIRequestContext): Promise<ServedChargeBasis> {
  const raw = await readJson<unknown>(request, '/dev/mock-charge-basis', 'readMockChargeBasis');
  // The one place entitled to brand a basis: it has just come off the wire.
  return asReading(assertServedChargeBasis(raw) as ServedChargeBasis);
}

/**
 * A model's billable pricing as the catalog serves it — the derivation source
 * for a media charge, where the deterministic per-image estimate IS what
 * settlement bills. Read rather than written for the same reason the mock's
 * basis is: a hand-written rate is the literal the vocabulary exists to refuse.
 */
export async function readServedModelPricing(
  request: APIRequestContext,
  modelId: string
): Promise<ServedModelPricing> {
  const raw = await readJson<unknown>(request, '/models', 'readServedModelPricing');
  return asReading(pickModelPricing(raw, modelId) as ServedModelPricing);
}

/**
 * What settlement actually debited for this conversation's surviving content,
 * to the nano. The dev route renders nine fraction digits, which is nano-exact;
 * it is parsed with integer string math, never through `Number()`.
 */
export async function readSettledCharge(
  request: APIRequestContext,
  conversationId: string
): Promise<ObservedNanoUsd> {
  const body = await readJson<{ cost: string }>(
    request,
    `/dev/conversation-cost/${conversationId}`,
    'readSettledCharge'
  );
  return observed(nanoUsdFromDecimalString(body.cost));
}

/**
 * The caller's served money state: both wallets and the day's allowance.
 *
 * Typed by the wire contract itself (`GetBalanceResponse`, Zod-inferred in the
 * shared package) rather than a restatement of it, so a field rename fails the
 * build here instead of surfacing at E2E run time as a garbage amount. Each
 * string goes through the canonical NanoUSD parser rather than a bare `BigInt`,
 * which would read a blank field as zero.
 */
export async function readMoneyState(request: APIRequestContext): Promise<MoneyState> {
  const body = await readJson<GetBalanceResponse>(request, '/billing/balance', 'readMoneyState');
  return asReading({
    purchasedNanoUsd: observed(nanoUsdFromWire(body.purchased.balanceNanoUsd)),
    freeNanoUsd: observed(nanoUsdFromWire(body.free.balanceNanoUsd)),
    allowanceRemainingNanoUsd: observed(nanoUsdFromWire(body.allowance.remainingNanoUsd)),
  });
}

/**
 * The hold admission is currently holding against this conversation's payer.
 * Read it while the run is in flight — settlement releases the hold, so after
 * the turn completes there is nothing left to read.
 */
export async function readHold(
  request: APIRequestContext,
  conversationId: string
): Promise<ObservedNanoUsd> {
  // A fetch door of its own: it reads through `budget.ts` rather than through
  // `readJson`, so it announces itself to the teardown gate here.
  noteMoneyRead('readHold');
  const snapshot = await getFundingSnapshot(request, conversationId);
  return observed(snapshot.heldNanoUsd);
}

/**
 * Establish a wallet balance, and hand back what the route reports it applied.
 *
 * The one call here that CHANGES state, and it has to. A seeded balance is a
 * sanctioned derivation source only because the spec established it, so the
 * amount has to come back from establishing it — written into the seed and then
 * written again into the expectation, one number becomes two spellings free to
 * drift, which is the literal the vocabulary exists to refuse. Nothing else
 * changes: the amount is still branded on the line that fetched it, and
 * `seededWalletBalance` in `scripts/lib/money/money.ts` is the only thing that
 * prices from it.
 *
 * `setWalletBalance` in `budget.ts` remains the path for a spec that seeds a
 * precondition and asserts nothing about the amount.
 */
export async function seedWalletBalance(
  request: APIRequestContext,
  email: string,
  walletType: 'purchased' | 'free_tier',
  dollars: string
): Promise<ServedSeededBalance> {
  // A fetch door that writes. A seeded balance the spec goes on to price from is
  // money observed, so it counts as a touch exactly like a read does — and
  // `budget.ts`'s `setWalletBalance`, the path for a precondition nothing is
  // asserted about, announces nothing and stays outside the gate.
  noteMoneyRead('seedWalletBalance');
  const applied = await postWalletBalanceSeed(request, email, walletType, dollars);
  // The one place entitled to brand a seeded balance: it has just come off the
  // wire. The shape is the route's own published result type, stated once in
  // `ServedSeededBalance` and checked where the amount is actually read.
  return asReading(applied as ServedSeededBalance);
}

/**
 * One backdated usage row, in the shape the seed route's body takes.
 *
 * Restated here because the route declares its body schema inside `apps/api`
 * and publishes no type for it, unlike the wallet seed whose result type
 * crosses on the seed toolkit's barrel.
 */
interface BackdatedUsageRecord {
  readonly modelId: string;
  readonly providerName: string;
  /** Canonical NanoUSD: what the row bills, and what the payer's wallet loses. */
  readonly costNanoUsd: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** ISO-8601 instant the row is dated to — what puts it inside or outside a window. */
  readonly createdAt: string;
}

/**
 * Establish spend dated to an instant of the spec's choosing, and hand back what
 * the route reports it charged.
 *
 * The second call here that CHANGES state, and a seed for the same reason
 * {@link seedWalletBalance} is one: a window's contents are a derivation source
 * only because the spec established them, so the amount has to come back from
 * establishing it rather than being written twice. The route writes the rows and
 * debits the payer's wallet by the sum it returns, inside one transaction.
 *
 * Posted bare, with no `Idempotency-Key`, which is what keeps the suite's shared
 * retry wrapper from re-sending it: the route mints each row's arbitration key
 * server-side, so a second delivery of one call inserts the rows again and
 * debits the wallet again. A transient drop therefore fails the seed, and the
 * spec with it, rather than silently doubling what it established.
 */
export async function seedBackdatedUsage(
  request: APIRequestContext,
  ownerEmail: string,
  conversationId: string,
  records: readonly BackdatedUsageRecord[]
): Promise<ServedSeededUsage> {
  // A fetch door: what it reports is the charge the route said it applied, which
  // is the value the spec then prices its expectation from.
  noteMoneyRead('seedBackdatedUsage');
  const response = await request.post(`${API_BASE}/dev/usage-history`, {
    data: { ownerEmail, conversationId, records },
  });
  await expectOkResponse(response, 'seedBackdatedUsage');
  // The one place entitled to brand a usage seed's report: it has just come off
  // the wire.
  return asReading((await response.json()) as ServedSeededUsage);
}

/**
 * A member's delegated cap and served remaining, as the budget view reports
 * them — or `null` where the view carries no row for that member, which is a
 * verdict the poll below can keep polling on rather than a throw.
 */
async function readMemberDelegation(
  request: APIRequestContext,
  conversationId: string,
  memberId: string
): Promise<MemberDelegation | null> {
  const body = await readJson<{
    members: { memberId: string; capNanoUsd: string; effectiveRemainingNanoUsd: string }[];
  }>(request, `/conversations/${conversationId}/budgets`, 'readMemberDelegation');
  const row = body.members.find((member) => member.memberId === memberId);
  if (row === undefined) return null;
  // The one place entitled to brand a delegation: it has just come off the wire.
  return asReading({
    capNanoUsd: observed(nanoUsdFromWire(row.capNanoUsd)),
    effectiveRemainingNanoUsd: observed(nanoUsdFromWire(row.effectiveRemainingNanoUsd)),
  });
}

/**
 * The member's whole delegated cap is theirs to spend — nothing has clamped it,
 * and a cap of nothing is refused rather than held over.
 *
 * Read through a caller whose session may see that member's row: the owner sees
 * every member's, a member only their own. Polled like its siblings, because the
 * row is served by a different request than the one that wrote the cap.
 */
export async function expectDelegatedBudget(
  request: APIRequestContext,
  conversationId: string,
  memberId: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const delegation = await readMemberDelegation(request, conversationId, memberId);
        return delegation === null
          ? 'the budget view carries no row for this member'
          : compareDelegatedBudget(delegation);
      },
      { timeout: TIMEOUTS.ASSERT, message: 'the delegated budget should be the member to spend' }
    )
    .toBe(MONEY_ASSERTION_HOLDS);
}

/**
 * Who paid, and who sent, each of the conversation's assistant messages.
 *
 * No file imports it. `packages/config`'s `no-forged-money-input` rule names it
 * in `MONEY_VOCABULARY`, and the colocated `money-vocabulary.test.mjs` reads
 * this module's exported surface through the TypeScript checker to assert that
 * list exhausts it — so withholding the export fails `packages/config`, not the
 * tree the symbol lives in.
 * @toolContract
 */
export async function readChargeAttribution(
  request: APIRequestContext,
  conversationId: string
): Promise<ServedAttributionRow[]> {
  const body = await readJson<{ payers: ChargeAttributionRow[] }>(
    request,
    `/dev/message-payers/${conversationId}`,
    'readChargeAttribution'
  );
  // The one place entitled to brand a row: it has just come off the wire.
  return asReading(body.payers as ServedAttributionRow[]);
}

/**
 * The conversation's settled charge is EXACTLY the derived amount.
 *
 * Polled, because settlement commits after the stream ends: a point-in-time
 * read taken too early sees zero, which is "not yet" rather than a failure. A
 * charge that never arrives fails on the derivation it missed, by amount.
 *
 * Which is why a ZERO derivation is refused outright rather than compared: it
 * would hold over that early zero on the first sample. Asserting that nothing
 * was charged is {@link expectNoMoneyMoved}.
 */
export async function expectExactCharge(
  request: APIRequestContext,
  conversationId: string,
  expected: DerivedNanoUsd
): Promise<void> {
  await expect
    .poll(
      async () => compareExactCharge(await readSettledCharge(request, conversationId), expected),
      {
        timeout: TIMEOUTS.ASSERT,
        message: 'the settled charge should equal its derivation exactly',
      }
    )
    .toBe(MONEY_ASSERTION_HOLDS);
}

/**
 * The hold admission placed covers what settlement went on to charge.
 *
 * Both sides are read, so there is no expected amount to derive — the assertion
 * is the relation. It falsifies the under-reserving admission, where a payer
 * spends past the gate that admitted them; a zero hold fails rather than
 * covering every charge vacuously.
 *
 * Polled, and a zero charge is "not yet" rather than a covered run: the hold is
 * captured before settlement, so the first samples read an unsettled zero and
 * the poll keeps going instead of ending green on one.
 *
 * Pass the hold captured mid-run by {@link readHold}.
 */
export async function expectHoldCovers(
  request: APIRequestContext,
  conversationId: string,
  hold: ObservedNanoUsd
): Promise<void> {
  await expect
    .poll(async () => compareHoldCoverage(hold, await readSettledCharge(request, conversationId)), {
      timeout: TIMEOUTS.ASSERT,
      message: 'the admission hold should cover the settled charge',
    })
    .toBe(MONEY_ASSERTION_HOLDS);
}

/**
 * Every ASSISTANT message names the expected payer, and the expected sender.
 *
 * The two differ on an owner-funded group turn and coincide on a self-funded
 * one, which is exactly why the payer alone is not the assertion. "Assistant",
 * not "charged", is deliberate: an assistant message with no charge behind it
 * reports a null payer and fails here, which is what makes this catch a dropped
 * charge and not only a misrouted one.
 */
export async function expectChargeAttribution(
  request: APIRequestContext,
  conversationId: string,
  expected: ChargeAttribution
): Promise<void> {
  await expect
    .poll(
      async () =>
        compareChargeAttribution(await readChargeAttribution(request, conversationId), expected),
      { timeout: TIMEOUTS.ASSERT, message: 'each charge should be attributed as expected' }
    )
    .toBe(MONEY_ASSERTION_HOLDS);
}

/**
 * Each named component of the money state moved by exactly its derived amount.
 *
 * An expectation whose every component is zero is refused — a wallet that has
 * not moved yet satisfies it — and belongs to {@link expectNoMoneyMoved}. A
 * mixed expectation stands: one non-zero component gates the poll.
 */
export async function expectBalanceDelta(
  request: APIRequestContext,
  before: MoneyState,
  expected: MoneyExpectation
): Promise<void> {
  await expect
    .poll(async () => compareBalanceDelta(before, await readMoneyState(request), expected), {
      timeout: TIMEOUTS.ASSERT,
      message: 'the balance should move by exactly the derived amount',
    })
    .toBe(MONEY_ASSERTION_HOLDS);
}

/**
 * Each named component of the money state IS its derived amount — the shape a
 * granted or allowed value is asserted in, where there is no "before".
 */
export async function expectExactBalance(
  request: APIRequestContext,
  expected: MoneyExpectation
): Promise<void> {
  await expect
    .poll(async () => compareMoneyState(await readMoneyState(request), expected), {
      timeout: TIMEOUTS.ASSERT,
      message: 'the balance should equal the constant that mints it',
    })
    .toBe(MONEY_ASSERTION_HOLDS);
}

/**
 * Nothing was charged and no wallet moved.
 *
 * A negative cannot be established by waiting, so this must follow a terminal
 * signal — the refusal rendered, the failure tile shown, the deletion done.
 * Called before the run reaches its end it will pass on a conversation that is
 * about to be billed.
 *
 * Reached only by the gate {@link readChargeAttribution} names, for the same
 * reason: the rule lists it in `MONEY_VOCABULARY`.
 * @toolContract
 */
export async function expectNoMoneyMoved(
  request: APIRequestContext,
  conversationId: string,
  before: MoneyState
): Promise<void> {
  await expect
    .poll(
      async () =>
        compareNoMoneyMoved(
          before,
          await readMoneyState(request),
          await readSettledCharge(request, conversationId)
        ),
      { timeout: TIMEOUTS.ASSERT, message: 'no money should have moved' }
    )
    .toBe(MONEY_ASSERTION_HOLDS);
}

/**
 * No wallet moved, where there is no conversation to read a charge from.
 *
 * {@link expectNoMoneyMoved} less its charge term — the shape a refusal that
 * never reached a conversation is asserted in: a declined card, a rejected
 * top-up. Comparing two readings by hand instead would work and would be
 * refused nowhere; this is the same assertion with the vocabulary's refusals
 * behind it.
 *
 * A negative cannot be established by waiting, so this must follow a terminal
 * signal — the decline rendered, the failure tile shown.
 */
export async function expectNoWalletMovement(
  request: APIRequestContext,
  before: MoneyState
): Promise<void> {
  await expect
    .poll(async () => compareNoWalletMovement(before, await readMoneyState(request)), {
      timeout: TIMEOUTS.ASSERT,
      message: 'no wallet should have moved',
    })
    .toBe(MONEY_ASSERTION_HOLDS);
}
