/**
 * Forged-money-input lint extension: the routes into the E2E money vocabulary
 * that the type system provably cannot refuse.
 *
 * The vocabulary brands every value it prices from, field by field, so a
 * hand-written object and a spread that rewrites one field are compile errors.
 * What stays legal is structural: `Object.assign` is declared to return `T & U`,
 * assignable to `T` whatever `T` is branded with; `any` is assignable to
 * anything; and `readonly` is ignored in assignability, so a reading can be
 * aliased to a plain-typed binding and rewritten in place. Rung 2 is the right
 * altitude for shapes rung 1 cannot express.
 *
 * The rule asks the TYPE of the value, never the spelling of what produced it,
 * and it is scoped by neither file path nor a list of forgers: the `JSON.parse`
 * calls the suite already makes never reach a money input, so they stay legal.
 */
import noForgedMoneyInput from './rules/no-forged-money-input.mjs';

/**
 * The functions a forged value must not reach.
 *
 * **THE RULE RESTS ENTIRELY ON THIS LIST BEING COMPLETE.** A name missing here
 * is invisible to every behavioural test the rule has, because each of those
 * tests necessarily calls a name that IS here — they prove the mechanism and
 * can say nothing about its domain.
 *
 * Omitting `compareHoldCoverage` is the worst case, and worth knowing: it is
 * the one member that ORDERS rather than equates, and `>=` COERCES — a decimal
 * string, a wrapper object and a plain number all compare true against a bigint
 * and return a passing verdict where the honest reading returns "no hold was
 * placed", while every sibling's `!==` reports the divergence loudly. It now
 * also refuses a non-bigint at runtime, so the silence is closed at two rungs.
 *
 * So the list is DERIVED, not curated, and the derivation runs through the
 * compiler's checker rather than over source text: a colocated test admits
 * every exported function of `scripts/lib/money/money.ts` and
 * `e2e/helpers/exact-money.ts` that takes a branded value, produces one, or
 * takes the context a read is made from, and fails on a name missing from here,
 * a name here outside that domain, or a callable export in neither list. A
 * derivation with bounds cannot carry completeness on its own, so that last
 * failure is what does: an export the walk misses is unclassified, and
 * unclassified is loud. A brand is found structurally — an
 * arrow-function export, a type alias in parameter position and a renamed
 * import are all resolved rather than matched — but only as far as the walk
 * reaches: a type's own properties, its union and intersection constituents,
 * its type arguments and its NUMERIC index type, four levels deep. A brand held
 * behind a STRING index signature, one only a callback parameter takes, and one
 * a fifth level in are each missed, and each has a test that plants it. The
 * context arm is narrower still: it matches a parameter whose own type resolves
 * to `APIRequestContext`, so a context wrapped in `Readonly<>`, unioned with
 * `undefined`, held in an array or parked on a property is not matched.
 *
 * The third arm is the one worth explaining: a read takes a request context,
 * and a forged context — `Object.assign({}, request, { get: cannedGet })` —
 * makes the read mint a brand over numbers the running system never served.
 * Nothing downstream of that read can tell the difference, which is why the
 * refusal has to happen at the read.
 *
 * What falls outside the domain is listed by group in
 * {@link MONEY_NON_VOCABULARY}, and the two lists are GATED against the
 * modules' callable exports rather than described in a sentence here — this one
 * was wrong twice, and an enumeration a reader maintains is one edit from being
 * wrong again. The registrar is the group worth knowing: a spec calling
 * `asReading` registers a payload of its own making, which is why it sits on
 * the vocabulary's known-and-not-refused list beside the cast.
 */
export const MONEY_VOCABULARY = [
  // Minters that price from a served payload.
  'mockGenerationCharge',
  'mockTextTurnCharge',
  'mockEchoTextFor',
  'catalogPerImageCharge',
  // Minters that price from a count or a constant: they produce a brand, so a
  // forged quantity becomes a derivation nothing read.
  'storedTextCharge',
  'storedMediaCharge',
  'grantedWelcomeCredit',
  'grantedDailyFreeAllowance',
  'allowedMinimumDeposit',
  // The minters for what the setup itself established: each prices from what
  // its seed route reported applying, so a forged echo forges the expectation.
  'seededWalletBalance',
  'seededUsageCharge',
  // Composition over amounts that are already derived.
  'sumOfCharges',
  'spendOf',
  // Comparators over a reading, a derivation, or an attribution.
  'compareExactCharge',
  'compareHoldCoverage',
  'compareMoneyState',
  'compareBalanceDelta',
  'compareNoMoneyMoved',
  'compareNoWalletMovement',
  'compareChargeAttribution',
  'compareDelegatedBudget',
  // The reads themselves: a forged request context makes one mint a brand over
  // numbers the running system never served, and nothing downstream can tell.
  'readMockChargeBasis',
  'readServedModelPricing',
  'readSettledCharge',
  'readMoneyState',
  'readHold',
  'readChargeAttribution',
  // The seeds, each a read of what the running system applied: a forged
  // context makes one brand an amount nothing was seeded with.
  'seedWalletBalance',
  'seedBackdatedUsage',
  // The assertions specs call.
  'expectExactCharge',
  'expectHoldCovers',
  'expectChargeAttribution',
  'expectBalanceDelta',
  'expectExactBalance',
  'expectNoMoneyMoved',
  'expectNoWalletMovement',
  'expectDelegatedBudget',
];

/**
 * Every other callable export of the two vocabulary modules, by the group that
 * puts it outside the domain. It is here rather than in a sentence because the
 * sentence was wrong twice: a colocated test asserts that this and
 * {@link MONEY_VOCABULARY} together EXHAUST the modules' callable exports, so a
 * function added in a shape the derivation misses — a read taking a context the
 * checker resolves to something other than `APIRequestContext` — has to be
 * classified here, in a diff, rather than sliding past a green gate.
 *
 * A read does not belong in any of these groups. Adding one here says the
 * derivation was wrong about it, which is a claim worth making loudly.
 */
export const MONEY_NON_VOCABULARY = {
  /** Handed untrusted input by design; they return it unbranded. */
  validators: ['assertServedChargeBasis', 'pickModelPricing'],
  /** They take a string and hand back a plain bigint. */
  parsers: ['nanoUsdFromWire', 'nanoUsdFromDecimalString'],
  /** The read layer's registrar: generic, so it carries no brand to find. */
  registrar: ['asReading'],
};

const e2eMoneyPlugin = {
  meta: { name: 'e2e-money', version: '1.0.0' },
  rules: { 'no-forged-money-input': noForgedMoneyInput },
};

/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'e2e-money/no-forged-money-input',
    files: ['**/*.ts'],
    plugins: { 'e2e-money': e2eMoneyPlugin },
    rules: {
      'e2e-money/no-forged-money-input': ['error', { vocabulary: MONEY_VOCABULARY }],
    },
  },
];
