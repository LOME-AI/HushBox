/**
 * The exact-money assertion vocabulary for the E2E suite: where an expected
 * amount comes from, and how an observed one is compared to it.
 *
 * The rule the whole module exists to make structural is that an expected
 * amount is DERIVED, never typed. The sanctioned sources are:
 *
 *  - the mock provider's declared charge and echo — {@link mockGenerationCharge},
 *    {@link mockTextTurnCharge};
 *  - the served catalog row's billable rate — {@link catalogPerImageCharge};
 *  - the shared estimator's own storage rates — {@link storedTextCharge},
 *    {@link storedMediaCharge};
 *  - the constant that mints a grant — {@link grantedWelcomeCredit},
 *    {@link grantedDailyFreeAllowance};
 *  - the constant that fixes an amount the product requires of a payer —
 *    {@link allowedMinimumDeposit};
 *  - what a seed route reports it applied, for a balance or a spend the setup
 *    itself established — {@link seededWalletBalance},
 *    {@link seededUsageCharge}.
 *
 * Every minter returns a `DerivedNanoUsd`, and every comparator takes one. The
 * door is shut on both sides of a minter, and by the compiler rather than by
 * convention:
 *
 *  - no comparator has a `bigint`, `number` or money-string parameter, so a
 *    literal expectation does not type-check, and arithmetic on two derived
 *    amounts widens back to `bigint`, so composition has to go through
 *    {@link sumOfCharges} and {@link spendOf};
 *  - every input a minter prices FROM — the mock's charge basis, a catalog
 *    pricing row, a money-state reading — is branded FIELD BY FIELD, so neither
 *    a hand-written object nor a spread that rewrites one field type-checks;
 *  - nothing exported here returns a branded value from caller-supplied data.
 *    The parsers return plain `bigint`; the validators return bare wire shapes.
 *    The brand is applied in the read layer, on the line that fetched the
 *    payload.
 *
 * **What is refused, and where.** Every entry below has a test that plants the
 * route; none of them is a claim about what is left.
 *
 *  - At rung 1, by the compiler: a literal, hand-rolled arithmetic over two
 *    derivations, a structurally identical object, `satisfies`, a look-alike
 *    brand declared elsewhere, and a spread that rewrites any served or
 *    observed field. Each has a `@ts-expect-error` test beside it, so a green
 *    typecheck is itself the evidence they still refuse.
 *  - At rung 2, by the vendored `e2e-money/no-forged-money-input` rule, which
 *    asks the TYPE of a value rather than the spelling of what produced it:
 *    an argument that is `any` or an intersection assembled at the call site;
 *    a member write through a binding whose initialiser was a reading, which
 *    is how `readonly` is defeated without a cast; and a call into a
 *    declaration this codebase does not own that is handed a brand and hands
 *    one back. The reads are covered too, because a forged request context
 *    makes a read mint a brand over numbers the running system never served.
 *  - At rung 4, by this module at runtime, which is where the guarantee lives.
 *    A rung-1 or rung-2 predicate reads the TYPE of a value, and a type belongs
 *    to the position the value sits in, so parking it one token away — on a
 *    property, in a destructure, in a binding assigned a statement later,
 *    behind a helper — puts it out of every compile-time predicate's reach.
 *    Two refusals close that, and they close different halves:
 *    **provenance** — a comparator compares only a payload {@link asReading}
 *    registered, so a fabricated one is refused however it is spelled; and
 *    **freeze** — a registered payload is frozen, so rewriting one in place
 *    fails rather than forging a reading whose object identity is genuine. An
 *    assignment spelling throws; `Reflect.set` returns `false` and mutates
 *    nothing without throwing, so the reading is intact either way but only the
 *    first is loud.
 *    `compareHoldCoverage` adds a third: it is the one comparator that ORDERS,
 *    and `>=` coerces a string, a wrapper object or a number where a sibling's
 *    `!==` would report the divergence, so it refuses a non-bigint.
 *
 * **What is known and not refused.** This list is what is known, not what
 * exists — five versions of a completeness claim about this module have been
 * falsified, so no sentence here makes one.
 *
 *  - A cast of an AMOUNT — `… as DerivedNanoUsd`, `… as ObservedNanoUsd` — and
 *    a direct call to {@link asReading}. Both are deliberately open and both
 *    are greppable, which is the point of leaving them open rather than
 *    chased. A
 *    cast of a PAYLOAD is not on this list: it reaches a comparator with no
 *    registration behind it, and provenance refuses it.
 *  - **A forged request CONTEXT, in two spellings.** `Object.assign({},
 *    request, { get: … })` handed to a read makes the read brand and register a
 *    payload the running system never served, so neither provenance nor freeze
 *    can tell. The lint rule reports that spelling; nothing refuses it at
 *    runtime, because every runtime marker distinguishing an honest context
 *    from a forged one is itself forgeable. The second spelling is quieter
 *    still: intercepting the routes the read layer fetches — the honest context
 *    fetching a fabricated payload — leaves the lint rule nothing to see, since
 *    every value at the call site is then genuinely a reading.
 *  - An amount, as opposed to a payload: `ObservedNanoUsd` is a bigint and a
 *    primitive has no identity to register, so provenance covers the objects a
 *    read returns and not the amounts. `compareHoldCoverage`'s type check is
 *    what stands there.
 *  - At rung 2 only, so open to anything the lint rule cannot see: a forger
 *    behind its own alias, a member named only at runtime, a value laundered
 *    through a property path or across a file boundary, and a write moved into
 *    a first-party helper. Each of those reaches rung 4 anyway — which is the
 *    reason the guarantee was moved there.
 *  - A limit of REACH rather than of refusal, recorded here because this is
 *    where this module's limits live: {@link compareChargeAttribution} asserts
 *    over EVERY assistant message a conversation holds, which is what makes it
 *    catch a dropped charge — and is also why it cannot be pointed at a
 *    conversation whose fixture seeds uncharged assistant rows. Such a row
 *    reports a null payer and fails an assertion it was never in scope for. A
 *    spec in that position reads the payer it means to assert on and says why,
 *    which is what the group-billing spec does.
 *
 * One thing deliberately NOT branded: counts. `storedTextCharge(chars)` and
 * `mockTextTurnCharge`'s `answers` take caller-supplied numbers, because a spec
 * legitimately knows what it sent and how many answers it asked for. A count is
 * not money; the rate it multiplies is the shared constant, never a parameter.
 *
 * It lives beside the other `e2e-*` support modules rather than in `e2e/helpers`
 * because `@hushbox/e2e` has no unit-test runner: the falsifying logic — every
 * comparator below — is pinned by real tests here, and the helpers that fetch
 * and poll are the thin layer over it.
 *
 * Pricing CORRECTNESS is deliberately not what these comparisons prove. Storage
 * is priced through the shared rate helpers settlement itself calls, and the
 * markup is applied server-side at its own confined seam; re-deriving either
 * here would be a second implementation that has to agree with the first, which
 * the code rules ban. What they prove is the pipeline around the price: that a
 * charge is not dropped, doubled, mis-anchored, mis-attributed or mis-rounded
 * between settlement and the wallet.
 */

import {
  MIN_DEPOSIT_USD,
  WELCOME_CREDIT_CENTS,
  centsToNanoUsd,
  charStorageNanoUsd,
  dollarsToNanoUsd,
  freeDailyAllowanceNanoUsd,
  mediaStorageNanoUsd,
  parseNanoUSD,
} from '@hushbox/shared';
import { noteMoneyComparison } from './money-gate.js';
import type { MockChargeBasis, SetWalletBalanceResult } from '@hushbox/api/dev-seed';
import type { WireModelPricing } from '@hushbox/shared';

declare const derivedBrand: unique symbol;
declare const observedBrand: unique symbol;
declare const servedBrand: unique symbol;

/** An expected amount, produced only by a minter in this module. */
export type DerivedNanoUsd = bigint & { readonly [derivedBrand]: 'derived' };

/** An amount read back from the running system. */
export type ObservedNanoUsd = bigint & { readonly [observedBrand]: 'observed' };

/**
 * Brands a payload FIELD BY FIELD, never the object alone.
 *
 * Branding the object is not enough, and the reason is worth keeping: object
 * spread copies a symbol-keyed brand straight through, so
 * `{ ...basis, generationChargeNanoUsd: '424242' }` would rewrite the amount
 * while the brand survived — no cast, nothing to grep for, and a spread is less
 * work than a read. With the brand on each field, the replacement value is a
 * plain string and does not type-check.
 *
 * Homomorphic on purpose: it maps over the wire contract rather than restating
 * it, so a field added to the payload is branded automatically and keeps its own
 * type and optionality. `BigInt(…)`, `.length` and template interpolation all
 * work on a branded string, so no minter body changes shape for this.
 *
 * `null` passes through unbranded because `null & {…}` is `never`, which would
 * make an honestly-read nullable field untypeable. That costs nothing: nulling a
 * field is a divergence the comparators report loudly, while substituting an id
 * or an amount — the forgery that would pass — still needs a branded value.
 */
type Served<T> = { readonly [K in keyof T]: ServedField<T[K]> };

type ServedField<T> = T extends null ? null : T & { readonly [servedBrand]: 'served' };

/**
 * The mock's charge basis AS SERVED. Every field is branded because every field
 * prices something: the charge is money outright, and the echo affixes size the
 * persisted text the storage fee is charged on.
 */
export type ServedChargeBasis = Served<MockChargeBasis>;

/** A catalog row's pricing AS SERVED, branded for the same reason. */
export type ServedModelPricing = Served<WireModelPricing>;

/** The verdict every comparator returns when the assertion holds. */
export const MONEY_ASSERTION_HOLDS = 'the money assertion holds';

const NANO_FRACTION_DIGITS = 9;

// --- provenance and freeze: what a read declared it fetched -------------------
//
// The compiler and the lint rule both refuse a value by its TYPE, and a type is
// a property of the position a value sits in: park the value one token away —
// on a property, in a destructure, in a binding assigned a statement later,
// behind a helper — and the predicate has nothing left to look at. What no
// spelling changes is object identity, so the read layer records the payloads
// it brands and every consumer here asks the record.
//
// Freeze closes the other half. Provenance refuses a payload that never came
// from a read; it cannot refuse a payload that did come from one and was then
// rewritten in place, because the identity is genuine and only the contents
// changed. Frozen, that rewrite throws in strict mode wherever it is written.

const readings = new WeakSet<object>();

/**
 * The read layer's declaration that this payload came off the wire — the only
 * way an object enters the vocabulary, and deliberately greppable: a spec that
 * calls it is fabricating a reading as visibly as one writing `as`.
 *
 * Registers and freezes every object the payload reaches, so an array's rows
 * are readings in their own right and a spec may compare the subset it means.
 */
export function asReading<T extends object>(payload: T): T {
  recordAndFreeze(payload);
  return payload;
}

function recordAndFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || readings.has(value)) return;
  readings.add(value);
  Object.freeze(value);
  for (const member of Object.values(value)) recordAndFreeze(member);
}

function requireReading<T extends object>(payload: T, what: string): T {
  if (!readings.has(payload)) {
    throw new RangeError(
      `${what}: this value never came from a read. A money assertion compares what the ` +
        'running system served, so the payload has to come back from one of the reads in ' +
        'e2e/helpers/exact-money.ts — the only code entitled to say a payload came off the wire.'
    );
  }
  return payload;
}

function derived(amount: bigint): DerivedNanoUsd {
  return amount as DerivedNanoUsd;
}

function requirePositiveCount(count: number, what: string): void {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError(`${what} must be a positive integer, got ${String(count)}`);
  }
}

function requireSize(size: number, what: string): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError(`${what} must be a non-negative integer, got ${String(size)}`);
  }
}

// --- reading the served sources ---------------------------------------------
//
// These validate a payload and return its BARE wire shape. The brand is applied
// by the read that fetched it (`e2e/helpers/exact-money.ts`), which is the one
// place entitled to say "this came off the wire". Validation is separated from
// fetching so it is testable without a running server — and so a payload that
// changed shape fails here, naming itself, instead of surfacing as
// `BigInt(undefined)` three frames later.

function stringField(payload: Record<string, unknown>, key: string, what: string): string {
  const value = payload[key];
  if (typeof value !== 'string') {
    throw new RangeError(`${what}: served payload has no string '${key}'`);
  }
  return value;
}

function asRecord(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) {
    throw new RangeError(`${what}: served payload is not an object`);
  }
  return raw as Record<string, unknown>;
}

/**
 * The `GET /dev/mock-charge-basis` payload, validated. The charge goes through
 * the canonical NanoUSD parser, so a blank or non-canonical amount fails here
 * rather than deriving an expectation of zero.
 */
export function assertServedChargeBasis(raw: unknown): MockChargeBasis {
  const what = 'mock-charge-basis';
  const payload = asRecord(raw, what);
  const generationChargeNanoUsd = stringField(payload, 'generationChargeNanoUsd', what);
  parseNanoUSD(generationChargeNanoUsd);
  return {
    generationChargeNanoUsd,
    echoPrefix: stringField(payload, 'echoPrefix', what),
    echoSuffix: stringField(payload, 'echoSuffix', what),
  };
}

/** The named model's pricing out of a served `GET /models` payload. */
export function pickModelPricing(raw: unknown, modelId: string): WireModelPricing {
  const what = 'served catalog';
  const models = asRecord(raw, what)['models'];
  if (!Array.isArray(models)) {
    throw new RangeError(`${what}: payload carries no models array`);
  }
  const row = models.map((model) => asRecord(model, what)).find((model) => model['id'] === modelId);
  if (row === undefined) {
    throw new RangeError(`${what}: no row for model ${modelId}`);
  }
  return asRecord(row['pricing'], `${what} row ${modelId}`) as WireModelPricing;
}

// --- derivation: the mock provider's declared basis -------------------------

/** What a run of `generations` mock calls is billed, before any storage. */
export function mockGenerationCharge(
  basis: ServedChargeBasis,
  generations: number
): DerivedNanoUsd {
  requireReading(basis, 'mockGenerationCharge');
  requirePositiveCount(generations, 'generations');
  return derived(BigInt(basis.generationChargeNanoUsd) * BigInt(generations));
}

/** The assistant text the mock streams, and therefore persists, for a prompt. */
export function mockEchoTextFor(basis: ServedChargeBasis, prompt: string): string {
  requireReading(basis, 'mockEchoTextFor');
  return `${basis.echoPrefix}${prompt}${basis.echoSuffix}`;
}

interface MockTextTurn {
  /** The user's message. Its characters are stored once for the whole turn. */
  readonly prompt: string;
  /** Charged calls that persist an answer. Each stores its own echo. */
  readonly answers: number;
  /**
   * Charged calls that persist nothing of their own — a routed turn's
   * classifier is one. They are billed and add no storage.
   */
  readonly contentlessCalls?: number;
}

/**
 * A text turn's whole settled charge: every call's inference charge, plus the
 * prompt stored once and each answer's echo stored with it.
 */
export function mockTextTurnCharge(basis: ServedChargeBasis, turn: MockTextTurn): DerivedNanoUsd {
  requireReading(basis, 'mockTextTurnCharge');
  requirePositiveCount(turn.answers, 'answers');
  const contentlessCalls = turn.contentlessCalls ?? 0;
  requireSize(contentlessCalls, 'contentlessCalls');
  const echoChars = mockEchoTextFor(basis, turn.prompt).length;
  return derived(
    BigInt(basis.generationChargeNanoUsd) * BigInt(turn.answers + contentlessCalls) +
      charStorageNanoUsd(turn.prompt.length) +
      BigInt(turn.answers) * charStorageNanoUsd(echoChars)
  );
}

// --- derivation: the served catalog row -------------------------------------

/**
 * What `images` images cost at the row's own per-image rate. The served rate is
 * already billable (fees are baked at catalog ingestion), so nothing is applied
 * to it here.
 */
export function catalogPerImageCharge(pricing: ServedModelPricing, images: number): DerivedNanoUsd {
  requireReading(pricing, 'catalogPerImageCharge');
  requirePositiveCount(images, 'images');
  const perImage = pricing.perImage;
  if (perImage === undefined) {
    throw new RangeError('catalogPerImageCharge: the served row carries no perImage rate');
  }
  return derived(BigInt(perImage) * BigInt(images));
}

// --- derivation: the shared storage rates -----------------------------------

/** Stored text, priced through the rate settlement itself charges. */
export function storedTextCharge(chars: number): DerivedNanoUsd {
  requireSize(chars, 'chars');
  return derived(charStorageNanoUsd(chars));
}

/** Stored media bytes, priced through the rate settlement itself charges. */
export function storedMediaCharge(bytes: number): DerivedNanoUsd {
  requireSize(bytes, 'bytes');
  return derived(mediaStorageNanoUsd(bytes));
}

// --- derivation: the constant that mints the grant ---------------------------

/** The welcome credit a fresh account is granted, from the constant that mints it. */
export function grantedWelcomeCredit(): DerivedNanoUsd {
  return derived(BigInt(centsToNanoUsd(WELCOME_CREDIT_CENTS)));
}

/**
 * A day's free allowance, from the shared publisher of that figure. Converting
 * `FREE_ALLOWANCE_CENTS_VALUE` here instead would be the second cents-to-nano
 * implementation `freeDailyAllowanceNanoUsd`'s own docstring warns about.
 */
export function grantedDailyFreeAllowance(): DerivedNanoUsd {
  return derived(freeDailyAllowanceNanoUsd());
}

// --- derivation: the constant the product requires ---------------------------

/**
 * The smallest deposit the product accepts, from the constant that fixes it.
 * The constant is a dollars figure, so it converts through the shared
 * dollars-to-nano publisher, which runs the cents-to-nano one in turn; spelling
 * either step here is the second implementation
 * {@link grantedDailyFreeAllowance}'s own source warns about.
 */
export function allowedMinimumDeposit(): DerivedNanoUsd {
  return derived(BigInt(dollarsToNanoUsd(String(MIN_DEPOSIT_USD))));
}

// --- derivation: the balance the setup established ---------------------------

/**
 * What the wallet-seed route reports it applied, AS SERVED.
 *
 * The amount is the running system's, not the caller's: a balance becomes a
 * derivation source by being SEEDED, and this is what came back from seeding
 * it. That is the whole difference between the minter below and a literal
 * wearing a function call — there is no parameter an amount can be typed into,
 * so an expectation exists only where the seed that established it was
 * performed, and the two cannot drift apart the way two spellings of one number
 * can.
 *
 * The wire shape is the route's own published result type rather than a
 * restatement of it, for the reason `MockChargeBasis` is: one statement of the
 * shape, so renaming the field breaks this build instead of the founder's run.
 */
export type ServedSeededBalance = Served<SetWalletBalanceResult>;

/**
 * The balance a spec's own setup established, priced from what the seed route
 * reported applying — as traceable as {@link grantedWelcomeCredit}, and for the
 * same reason: the amount comes from whatever minted it, never from the caller.
 */
export function seededWalletBalance(seeded: ServedSeededBalance): DerivedNanoUsd {
  requireReading(seeded, 'seededWalletBalance');
  return derived(nanoUsdFromDecimalString(seeded.newBalance));
}

/**
 * What the usage-history seed route reports it charged, AS SERVED.
 *
 * The wire shape is stated here rather than imported because the route declares
 * its result inline in the handler and exports no type for it; the seed
 * toolkit's barrel, which is how every other wire shape reaches this module,
 * does not carry it.
 */
interface SeededUsageHistory {
  /**
   * Rows this call inserted. The route mints each row's arbitration key itself,
   * so it is the count of one delivery and never a running total: a second
   * delivery of the same call inserts the same rows again and reports them
   * again, which is why the door that posts it is not retried.
   */
  readonly usageRecordsCreated: number;
  /** Canonical NanoUSD: the sum the seed debited the payer's wallet by. */
  readonly totalChargedNanoUsd: string;
}

/** A usage-history seed's report of what it applied, AS SERVED. */
export type ServedSeededUsage = Served<SeededUsageHistory>;

/**
 * The spend a spec's own setup established, priced from what the usage-history
 * seed route reported charging — the same standing {@link seededWalletBalance}
 * has, for a seed that writes spend rather than a balance. The route debits the
 * payer's wallet by exactly this sum in the transaction that writes the rows,
 * so it is also the wallet movement the seed causes.
 */
export function seededUsageCharge(seeded: ServedSeededUsage): DerivedNanoUsd {
  requireReading(seeded, 'seededUsageCharge');
  return derived(nanoUsdFromWire(seeded.totalChargedNanoUsd));
}

// --- composition -------------------------------------------------------------

/** One derived amount from several — the only way to add two expectations. */
export function sumOfCharges(...parts: readonly DerivedNanoUsd[]): DerivedNanoUsd {
  if (parts.length === 0) {
    throw new RangeError('sumOfCharges: an empty sum expects nothing');
  }
  let total = 0n;
  for (const part of parts) total += part;
  return derived(total);
}

/** The balance movement a charge causes: a debit, so the negation of it. */
export function spendOf(charge: DerivedNanoUsd): DerivedNanoUsd {
  return derived(0n - charge);
}

// --- observation --------------------------------------------------------------

// These PARSE; they do not brand. Nothing this module exports returns an
// `ObservedNanoUsd`, a `ServedChargeBasis` or a `ServedModelPricing`, so there
// is no exported function a caller can hand a written-out value to and get a
// reading back. The brand goes on in the read layer, on the line that fetched
// the payload — see `e2e/helpers/exact-money.ts`.

/**
 * A canonical integer NanoUSD wire string. Every wire amount the vocabulary
 * reads goes through here, and here delegates to the shared parser rather than
 * testing a pattern of its own: a bare `BigInt(value)` turns the empty string
 * into `0n`, and a zero handed to the nothing-moved assertion is a broken read
 * wearing a passing proof's clothes.
 */
export function nanoUsdFromWire(wire: string): bigint {
  return parseNanoUSD(wire);
}

/**
 * A decimal dollar string, read to the nano. The dev conversation-cost route
 * renders nine fraction digits, which is nano-exact — parsing it with integer
 * string math keeps it that way, where `Number()` would not.
 */
export function nanoUsdFromDecimalString(decimal: string): bigint {
  const match = /^(?<sign>-?)(?<whole>\d+)(?:\.(?<fraction>\d{1,9}))?$/.exec(decimal);
  if (match?.groups === undefined) {
    throw new RangeError(`nanoUsdFromDecimalString: not a decimal dollar amount: ${decimal}`);
  }
  const { sign = '', whole = '0', fraction = '' } = match.groups;
  const nano =
    BigInt(whole) * 10n ** BigInt(NANO_FRACTION_DIGITS) +
    BigInt(fraction.padEnd(NANO_FRACTION_DIGITS, '0'));
  return sign === '-' ? -nano : nano;
}

// --- comparison ----------------------------------------------------------------
//
// Every comparator below announces itself to the teardown gate
// (`money-gate.ts`) before it compares, whatever verdict it goes on to
// return: "this test made an exact-money assertion" is a fact only a comparator
// can produce, and the gate reads it rather than being told which specs assert.

/**
 * The served money state a spec compares against.
 *
 * The components carry the observed brand rather than a bare `bigint`, and that
 * is load-bearing rather than decorative: a hand-written "before" handed to
 * {@link compareNoMoneyMoved} produces a PASSING assertion over numbers nothing
 * read, which is a vacuous proof reachable from the sanctioned surface. The
 * brand is on each field, not the object, so a spread cannot rewrite one either.
 */
export interface MoneyState {
  readonly purchasedNanoUsd: ObservedNanoUsd;
  readonly freeNanoUsd: ObservedNanoUsd;
  readonly allowanceRemainingNanoUsd: ObservedNanoUsd;
}

/** A difference between two readings is still a reading. */
function observedDelta(after: ObservedNanoUsd, before: ObservedNanoUsd): ObservedNanoUsd {
  return (after - before) as ObservedNanoUsd;
}

/** Which components an assertion names, and what each must equal. */
export interface MoneyExpectation {
  readonly purchased?: DerivedNanoUsd;
  readonly free?: DerivedNanoUsd;
  readonly allowanceRemaining?: DerivedNanoUsd;
}

/** What a conversation's charge is attributed to. */
export interface ChargeAttributionRow {
  readonly messageId: string;
  readonly payerId: string | null;
  readonly senderUserId: string | null;
  readonly senderLinkId: string | null;
}

/**
 * An attribution row AS SERVED. Branded for the same reason a money state is:
 * who paid is the thing under test, so a hand-written row — or a spread that
 * rewrites the payer and keeps the rest — would make the comparison pass over
 * rows nothing read.
 */
export type ServedAttributionRow = Served<ChargeAttributionRow>;

/**
 * A member's delegated budget as the budget view serves it: the cap delegated
 * to them, and the remaining the backend computes admission against — the
 * minimum of that cap less their spend and holds, the conversation's own
 * remaining, and the owner's balance.
 */
export interface MemberDelegation {
  readonly capNanoUsd: ObservedNanoUsd;
  readonly effectiveRemainingNanoUsd: ObservedNanoUsd;
}

/** Who a spec expects to have paid, and who it expects to have sent. */
export interface ChargeAttribution {
  readonly payerId: string;
  readonly senderUserId?: string | null;
  readonly senderLinkId?: string | null;
}

/**
 * The settled charge equals its derivation to the nano, or it does not.
 *
 * A ZERO derivation is refused rather than compared. The charge read sums usage
 * records, so an unsettled conversation reads zero and a zero expectation holds
 * over it on the first sample — the same vacuity {@link compareHoldCoverage}
 * refuses, reached here through a derivation rather than through a reading, and
 * costing no cast because the storage minters admit a zero size. A run that
 * genuinely bills nothing is {@link compareNoMoneyMoved}'s assertion, which
 * takes a before-state and so cannot pass by arriving early.
 */
export function compareExactCharge(actual: ObservedNanoUsd, expected: DerivedNanoUsd): string {
  noteMoneyComparison('compareExactCharge');
  if ((expected as bigint) === 0n) {
    throw new RangeError(
      'compareExactCharge: a zero derivation holds over any unsettled conversation. ' +
        'Asserting that nothing was charged is compareNoMoneyMoved.'
    );
  }
  if (actual === (expected as bigint)) return MONEY_ASSERTION_HOLDS;
  return `charged ${String(actual)} nano-USD, derivation expects ${String(expected)} nano-USD (off by ${String(actual - expected)})`;
}

/**
 * The admission hold covered what settlement went on to charge. A hold that
 * does not cover its run is the shape in which a payer overspends their gate,
 * so a zero hold fails rather than covering everything vacuously.
 *
 * A zero CHARGE fails for the mirror reason: the charge read sums usage
 * records, so an unsettled conversation reads zero, which is "not yet" rather
 * than "nothing was charged". A holding verdict there would end a poll on its
 * first pre-settlement sample — the exact window the hold has to be read in.
 * A run that genuinely bills nothing is {@link compareNoMoneyMoved}'s
 * assertion, not this one's.
 */
export function compareHoldCoverage(hold: ObservedNanoUsd, charge: ObservedNanoUsd): string {
  noteMoneyComparison('compareHoldCoverage');
  // The only comparator that ORDERS rather than equates, and `>=`/`<=` coerce:
  // a decimal string, a `BigInt` wrapper and a plain number each compare true
  // against a bigint, so a value that never came from a read passes here
  // silently where a sibling's `===` reports the divergence loudly. Checked at
  // runtime because these arrive through a parameter the compiler accepted.
  if (typeof hold !== 'bigint' || typeof charge !== 'bigint') {
    return `a hold and a charge are read as bigint; got ${typeof hold} and ${typeof charge}`;
  }
  if (hold <= 0n) return `no hold was placed (read ${String(hold)} nano-USD)`;
  if (charge <= 0n) return `nothing has settled yet (read ${String(charge)} nano-USD charged)`;
  if (hold >= charge) return MONEY_ASSERTION_HOLDS;
  return `hold ${String(hold)} nano-USD does not cover the ${String(charge)} nano-USD charged`;
}

/** Every named component of a money state equals its derivation. */
export function compareMoneyState(actual: MoneyState, expected: MoneyExpectation): string {
  noteMoneyComparison('compareMoneyState');
  requireReading(actual, 'compareMoneyState');
  const components = [
    { name: 'purchased', have: actual.purchasedNanoUsd, want: expected.purchased },
    { name: 'free', have: actual.freeNanoUsd, want: expected.free },
    {
      name: 'allowanceRemaining',
      have: actual.allowanceRemainingNanoUsd,
      want: expected.allowanceRemaining,
    },
  ];
  const compared = components.filter((component) => component.want !== undefined);
  if (compared.length === 0) {
    throw new RangeError('compareMoneyState: an expectation naming no component asserts nothing');
  }
  const wrong = compared.filter((component) => component.have !== (component.want as bigint));
  if (wrong.length === 0) return MONEY_ASSERTION_HOLDS;
  return wrong
    .map(
      (component) =>
        `${component.name} is ${String(component.have)}, derivation expects ${String(component.want)}`
    )
    .join('; ');
}

/**
 * Each named component moved by exactly its derived amount.
 *
 * An expectation whose every named component is zero is refused: a delta of
 * zero is what a conversation reads before it settles, so the assertion would
 * hold on its first sample. One non-zero component is enough to gate it, which
 * is why a mixed expectation stands. Absolute balances are a different case and
 * are not refused — a zero there is a real zero.
 */
export function compareBalanceDelta(
  before: MoneyState,
  after: MoneyState,
  expected: MoneyExpectation
): string {
  noteMoneyComparison('compareBalanceDelta');
  requireReading(before, 'compareBalanceDelta');
  requireReading(after, 'compareBalanceDelta');
  const named = [expected.purchased, expected.free, expected.allowanceRemaining].filter(
    (want) => want !== undefined
  );
  if (named.length > 0 && named.every((want) => (want as bigint) === 0n)) {
    throw new RangeError(
      'compareBalanceDelta: an all-zero expectation holds over a wallet that has not moved yet. ' +
        'Asserting that nothing moved is compareNoMoneyMoved.'
    );
  }
  // A difference between two readings is a reading, so the derived state is
  // registered here rather than exempted at the comparator it is handed to.
  return compareMoneyState(
    asReading({
      purchasedNanoUsd: observedDelta(after.purchasedNanoUsd, before.purchasedNanoUsd),
      freeNanoUsd: observedDelta(after.freeNanoUsd, before.freeNanoUsd),
      allowanceRemainingNanoUsd: observedDelta(
        after.allowanceRemainingNanoUsd,
        before.allowanceRemainingNanoUsd
      ),
    }),
    expected
  );
}

/** Every wallet component that differs between two readings, named. */
function walletMovements(before: MoneyState, after: MoneyState): string[] {
  const moved: string[] = [];
  if (after.purchasedNanoUsd !== before.purchasedNanoUsd) {
    moved.push(`purchased moved by ${String(after.purchasedNanoUsd - before.purchasedNanoUsd)}`);
  }
  if (after.freeNanoUsd !== before.freeNanoUsd) {
    moved.push(`free moved by ${String(after.freeNanoUsd - before.freeNanoUsd)}`);
  }
  if (after.allowanceRemainingNanoUsd !== before.allowanceRemainingNanoUsd) {
    moved.push(
      `allowance moved by ${String(after.allowanceRemainingNanoUsd - before.allowanceRemainingNanoUsd)}`
    );
  }
  return moved;
}

/** Nothing was charged and no wallet moved. */
export function compareNoMoneyMoved(
  before: MoneyState,
  after: MoneyState,
  charge: ObservedNanoUsd
): string {
  noteMoneyComparison('compareNoMoneyMoved');
  requireReading(before, 'compareNoMoneyMoved');
  requireReading(after, 'compareNoMoneyMoved');
  const reasons = walletMovements(before, after);
  if (charge !== 0n) reasons.unshift(`the conversation was charged ${String(charge)} nano-USD`);
  return reasons.length === 0 ? MONEY_ASSERTION_HOLDS : reasons.join('; ');
}

/**
 * No wallet moved, over two readings and no conversation.
 *
 * {@link compareNoMoneyMoved} less its charge term, for the refusal that never
 * reached a conversation — a declined card, a rejected top-up — where there is
 * no conversation id to read a charge from. Same semantics otherwise, and the
 * wallet halves are the same code rather than a second copy of it: two
 * comparators that had to agree about what "moved" means would be exactly the
 * drift the vocabulary exists to refuse.
 */
export function compareNoWalletMovement(before: MoneyState, after: MoneyState): string {
  noteMoneyComparison('compareNoWalletMovement');
  requireReading(before, 'compareNoWalletMovement');
  requireReading(after, 'compareNoWalletMovement');
  const moved = walletMovements(before, after);
  return moved.length === 0 ? MONEY_ASSERTION_HOLDS : moved.join('; ');
}

/**
 * A member's whole delegated cap is theirs to spend: the served remaining IS
 * the cap, so nothing — their own accrued spend, the conversation's cap, the
 * owner's balance — has clamped the delegation below what was delegated.
 *
 * Both sides are read, so there is no expected amount to derive; the assertion
 * is the relation, as in {@link compareHoldCoverage}. A zero cap is refused for
 * the reason a zero hold is: every remaining equals it, so the assertion would
 * hold over a delegation that never happened.
 */
export function compareDelegatedBudget(delegation: MemberDelegation): string {
  noteMoneyComparison('compareDelegatedBudget');
  requireReading(delegation, 'compareDelegatedBudget');
  const cap = delegation.capNanoUsd;
  const remaining = delegation.effectiveRemainingNanoUsd;
  if (cap <= 0n) return 'no budget was delegated';
  if (remaining === cap) return MONEY_ASSERTION_HOLDS;
  return `a ${String(cap)} nano-USD delegation leaves ${String(remaining)} nano-USD spendable`;
}

/**
 * Every ASSISTANT message names the expected payer, and the expected sender —
 * not every charged one. The distinction is load-bearing and the stronger
 * reading is deliberate: an assistant message carrying no charge reports a null
 * payer and fails here, which is what makes this a catcher for a dropped charge
 * rather than only for a misrouted one. A spec that legitimately expects an
 * uncharged assistant message asserts over the subset it means.
 */
export function compareChargeAttribution(
  rows: readonly ServedAttributionRow[],
  expected: ChargeAttribution
): string {
  noteMoneyComparison('compareChargeAttribution');
  if (expected.payerId === '') {
    throw new RangeError('compareChargeAttribution: an expectation must name a payer');
  }
  // Per row rather than over the array: a spec legitimately asserts over the
  // subset it means, and a filtered array is a new object holding read rows.
  for (const row of rows) requireReading(row, 'compareChargeAttribution');
  if (rows.length === 0) return 'no assistant message carries a charge to attribute';
  const wrong = rows.filter((row) => {
    // Each read value widens back to its plain type for the comparison: a
    // branded string and the spec's plain one hold the same id.
    const payerId: string | null = row.payerId;
    const senderUserId: string | null = row.senderUserId;
    const senderLinkId: string | null = row.senderLinkId;
    return (
      payerId !== expected.payerId ||
      (expected.senderUserId !== undefined && senderUserId !== expected.senderUserId) ||
      (expected.senderLinkId !== undefined && senderLinkId !== expected.senderLinkId)
    );
  });
  if (wrong.length === 0) return MONEY_ASSERTION_HOLDS;
  return wrong
    .map(
      (row) =>
        `message ${row.messageId} was paid by ${String(row.payerId)} and sent by ${String(row.senderUserId ?? row.senderLinkId)}`
    )
    .join('; ');
}
