import { describe, expect, it } from 'vitest';
import {
  MIN_DEPOSIT_USD,
  WELCOME_CREDIT_CENTS,
  charStorageNanoUsd,
  dollarsToNanoUsd,
  freeDailyAllowanceNanoUsd,
  mediaStorageNanoUsd,
} from '@hushbox/shared';
import {
  MONEY_ASSERTION_HOLDS,
  allowedMinimumDeposit,
  assertServedChargeBasis,
  catalogPerImageCharge,
  compareBalanceDelta,
  compareChargeAttribution,
  compareDelegatedBudget,
  compareExactCharge,
  compareHoldCoverage,
  compareMoneyState,
  compareNoMoneyMoved,
  compareNoWalletMovement,
  asReading,
  grantedDailyFreeAllowance,
  grantedWelcomeCredit,
  mockEchoTextFor,
  mockGenerationCharge,
  mockTextTurnCharge,
  nanoUsdFromDecimalString,
  nanoUsdFromWire,
  pickModelPricing,
  seededUsageCharge,
  seededWalletBalance,
  spendOf,
  storedMediaCharge,
  storedTextCharge,
  sumOfCharges,
} from './money.js';
import type {
  MemberDelegation,
  MoneyState,
  ServedAttributionRow,
  ObservedNanoUsd,
  ServedChargeBasis,
  ServedModelPricing,
  ServedSeededBalance,
  ServedSeededUsage,
} from './money.js';

/**
 * Nothing this module exports mints an observation or a served payload — only a
 * read does, and a read needs a server. So every fixture below is a cast, which
 * is exactly the visibility the vocabulary promises: a spec taking this route
 * is writing `as` too, and `as` is greppable.
 *
 * A payload fixture goes on through {@link asReading}, which is the second half
 * of what a read does: it records the object as one the wire produced and
 * freezes it. A fixture that skipped it would be testing the comparators
 * against values the vocabulary refuses, and the routes below need a genuine
 * reading to forge FROM.
 */
const observed = (amount: bigint): ObservedNanoUsd => amount as ObservedNanoUsd;
const observedWire = (wire: string): ObservedNanoUsd => observed(nanoUsdFromWire(wire));
const observedDecimal = (decimal: string): ObservedNanoUsd =>
  observed(nanoUsdFromDecimalString(decimal));

const BASIS = asReading({
  generationChargeNanoUsd: '1150',
  echoPrefix: 'Echo:\n',
  echoSuffix: '\n\n```json\n{\n  "ok": true\n}\n```',
} as ServedChargeBasis);

const PER_IMAGE_PRICING = asReading({ perImage: '46000000' } as ServedModelPricing);

/** What the seed route hands back after a spec establishes a balance. */
const SEEDED_TEN = asReading({ newBalance: '10.000000000' } as ServedSeededBalance);

/** What the usage-history seed route hands back after a spec seeds spend. */
const SEEDED_USAGE = asReading({
  usageRecordsCreated: 1,
  totalChargedNanoUsd: '2500000000',
} as ServedSeededUsage);

/** A member's delegation as the read layer hands one back. */
const readDelegation = (cap: bigint, remaining: bigint): MemberDelegation =>
  asReading({
    capNanoUsd: observed(cap),
    effectiveRemainingNanoUsd: observed(remaining),
  });

// A brand that spells itself exactly like the module's own, to pin that a
// `unique symbol` is unique to where it was declared.
declare const derivedBrand: unique symbol;
type LookAlikeDerived = bigint & { readonly [derivedBrand]: 'derived' };

const ATTRIBUTION_ROW = asReading({
  messageId: 'm1',
  payerId: 'owner',
  senderUserId: 'bob',
  senderLinkId: null,
} as ServedAttributionRow);

const GUEST_ROW = asReading({
  messageId: 'm2',
  payerId: 'owner',
  senderUserId: null,
  senderLinkId: 'link',
} as ServedAttributionRow);

/** A money state as the read layer hands one back: components and all. */
const readState = (
  over: { purchased?: bigint; free?: bigint; allowance?: bigint } = {}
): MoneyState =>
  asReading({
    purchasedNanoUsd: observed(over.purchased ?? 0n),
    freeNanoUsd: observed(over.free ?? 0n),
    allowanceRemainingNanoUsd: observed(over.allowance ?? 0n),
  });

const ZERO_STATE = readState();

describe('derivation from the mock provider s declared basis', () => {
  it('prices one generation at the served generation charge', () => {
    expect(mockGenerationCharge(BASIS, 1)).toBe(1150n);
  });

  it('scales the generation charge by the number of charged calls', () => {
    expect(mockGenerationCharge(BASIS, 3)).toBe(3450n);
  });

  it('rejects a generation count that is not a positive integer', () => {
    expect(() => mockGenerationCharge(BASIS, 0)).toThrow(RangeError);
    expect(() => mockGenerationCharge(BASIS, 1.5)).toThrow(RangeError);
  });

  it('reproduces the echo the mock streams for a prompt', () => {
    expect(mockEchoTextFor(BASIS, 'hi')).toBe(`${BASIS.echoPrefix}hi${BASIS.echoSuffix}`);
  });

  it('prices a one-answer text turn as the generation charge plus stored characters', () => {
    const prompt = 'hello';
    const echo = mockEchoTextFor(BASIS, prompt);
    expect(mockTextTurnCharge(BASIS, { prompt, answers: 1 })).toBe(
      1150n + charStorageNanoUsd(prompt.length) + charStorageNanoUsd(echo.length)
    );
  });

  it('stores the shared prompt once and each answer s own echo separately', () => {
    const prompt = 'hello';
    const echo = mockEchoTextFor(BASIS, prompt);
    expect(mockTextTurnCharge(BASIS, { prompt, answers: 2 })).toBe(
      2n * 1150n + charStorageNanoUsd(prompt.length) + 2n * charStorageNanoUsd(echo.length)
    );
  });

  it('bills a contentless call without adding storage for it', () => {
    const prompt = 'hello';
    const withClassifier = mockTextTurnCharge(BASIS, {
      prompt,
      answers: 1,
      contentlessCalls: 1,
    });
    expect(withClassifier - mockTextTurnCharge(BASIS, { prompt, answers: 1 })).toBe(1150n);
  });

  it('rejects a turn with no answers, which would price nothing', () => {
    expect(() => mockTextTurnCharge(BASIS, { prompt: 'hi', answers: 0 })).toThrow(RangeError);
  });
});

describe('derivation from the served catalog row', () => {
  it('prices images at the row s billable per-image rate', () => {
    expect(catalogPerImageCharge(PER_IMAGE_PRICING, 2)).toBe(92_000_000n);
  });

  it('refuses a row that carries no per-image rate', () => {
    expect(() => catalogPerImageCharge(asReading({} as ServedModelPricing), 1)).toThrow(/perImage/);
  });

  it('rejects an image count that is not a positive integer', () => {
    expect(() => catalogPerImageCharge(PER_IMAGE_PRICING, 0)).toThrow(RangeError);
  });
});

describe('reading the served sources', () => {
  it('takes the three declared fields off the charge-basis payload', () => {
    expect(
      assertServedChargeBasis({
        generationChargeNanoUsd: '1150',
        echoPrefix: 'Echo:\n',
        echoSuffix: '!',
      })
    ).toEqual({ generationChargeNanoUsd: '1150', echoPrefix: 'Echo:\n', echoSuffix: '!' });
  });

  it('refuses a charge-basis payload missing a field rather than deriving from undefined', () => {
    expect(() => assertServedChargeBasis({ generationChargeNanoUsd: '1150' })).toThrow(
      /mock-charge-basis/
    );
  });

  it('refuses a payload that is not an object at all', () => {
    expect(() => assertServedChargeBasis('nope')).toThrow(/not an object/);
  });

  it('refuses a charge-basis payload whose charge is not a NanoUSD amount', () => {
    expect(() =>
      assertServedChargeBasis({ generationChargeNanoUsd: '', echoPrefix: '', echoSuffix: '' })
    ).toThrow();
  });

  it('finds the named model s pricing in a served catalog', () => {
    expect(
      pickModelPricing(
        {
          models: [
            { id: 'other', pricing: {} },
            { id: 'wanted', pricing: { perImage: '7' } },
          ],
        },
        'wanted'
      )
    ).toEqual({ perImage: '7' });
  });

  it('refuses a catalog that does not carry the named model', () => {
    expect(() => pickModelPricing({ models: [{ id: 'other', pricing: {} }] }, 'wanted')).toThrow(
      /wanted/
    );
  });

  it('refuses a payload that is not a served catalog', () => {
    expect(() => pickModelPricing({ nope: true }, 'wanted')).toThrow(/catalog/);
  });
});

describe('derivation from the shared storage rates', () => {
  it('prices stored characters through the shared per-character rate', () => {
    expect(storedTextCharge(7)).toBe(charStorageNanoUsd(7));
  });

  it('prices stored bytes through the shared per-byte rate', () => {
    expect(storedMediaCharge(9)).toBe(mediaStorageNanoUsd(9));
  });

  it('rejects a negative or fractional size', () => {
    expect(() => storedTextCharge(-1)).toThrow(RangeError);
    expect(() => storedMediaCharge(0.5)).toThrow(RangeError);
  });
});

describe('derivation from the constant that mints the grant', () => {
  it('derives the welcome credit from the constant the grant is minted from', () => {
    expect(grantedWelcomeCredit()).toBe(BigInt(WELCOME_CREDIT_CENTS) * 10_000_000n);
  });

  it('takes the daily free allowance from the shared publisher, never a second conversion', () => {
    expect(grantedDailyFreeAllowance()).toBe(freeDailyAllowanceNanoUsd());
  });
});

describe('derivation from the constant the product requires', () => {
  it('takes the minimum deposit from the shared publisher, never a second conversion', () => {
    expect(allowedMinimumDeposit()).toBe(BigInt(dollarsToNanoUsd(String(MIN_DEPOSIT_USD))));
  });
});

describe('derivation from the balance the setup established', () => {
  it('derives the seeded balance from what the seed route reported applying', () => {
    expect(seededWalletBalance(SEEDED_TEN)).toBe(10_000_000_000n);
  });

  it('derives a seeded zero, which is a real zero rather than a not-yet', () => {
    expect(
      seededWalletBalance(asReading({ newBalance: '0.000000000' } as ServedSeededBalance))
    ).toBe(0n);
  });

  it('refuses a seeded balance that never came from a read', () => {
    const written = { newBalance: '999.000000000' } as ServedSeededBalance;
    expect(() => seededWalletBalance(written)).toThrow(/never came from a read/);
  });
});

describe('derivation from the spend the setup seeded', () => {
  it('derives the seeded spend from what the usage-history route reported charging', () => {
    expect(seededUsageCharge(SEEDED_USAGE)).toBe(2_500_000_000n);
  });

  it('refuses a seeded spend that never came from a read', () => {
    const written = { usageRecordsCreated: 1, totalChargedNanoUsd: '999' } as ServedSeededUsage;
    expect(() => seededUsageCharge(written)).toThrow(/never came from a read/);
  });
});

describe('composition', () => {
  it('sums derived parts into one derived amount', () => {
    expect(sumOfCharges(storedTextCharge(1), storedMediaCharge(1))).toBe(318n);
  });

  it('refuses an empty sum, which would assert nothing', () => {
    expect(() => sumOfCharges()).toThrow(RangeError);
  });

  it('turns a charge into the balance movement it causes', () => {
    expect(spendOf(storedTextCharge(1))).toBe(-300n);
  });
});

describe('observation', () => {
  it('parses without branding, so no export can turn a written amount into a reading', () => {
    const parsed: bigint = nanoUsdFromWire('42');
    expect(parsed).toBe(42n);
  });

  it('reads a canonical NanoUSD wire string exactly', () => {
    expect(observedWire('1150')).toBe(1150n);
  });

  it('reads a nine-fraction-digit decimal dollar string without losing nano', () => {
    expect(observedDecimal('0.000001150')).toBe(1150n);
  });

  it('reads a negative decimal dollar string', () => {
    expect(observedDecimal('-0.000001150')).toBe(-1150n);
  });

  it('reads a decimal dollar string with fewer fraction digits', () => {
    expect(observedDecimal('2.5')).toBe(2_500_000_000n);
  });

  it('refuses a malformed decimal rather than reading it as zero', () => {
    expect(() => observedDecimal('not-a-number')).toThrow(/not-a-number/);
  });

  it('refuses an empty wire string rather than reading it as zero', () => {
    // `BigInt('')` is `0n`, and a zero fed to the nothing-moved assertion is the
    // shape in which a broken read looks like a passing proof.
    expect(() => observedWire('')).toThrow();
  });

  it('refuses wire forms the canonical parser refuses, not merely non-digits', () => {
    expect(() => observedWire('1.5')).toThrow();
    expect(() => observedWire('01')).toThrow();
    expect(() => observedWire('-0')).toThrow();
  });
});

describe('the signatures admit no written-out expectation', () => {
  // These are the enforcement, and it is the compiler's. Each directive fails
  // the build the moment its refusal stops happening — remove the brand and the
  // directive goes unused, which TypeScript reports as an error of its own.
  //
  // Where the value is a payload rather than an amount, the same route is
  // refused a second time at runtime — the object never came from a read — so
  // the assertion is the throw. An amount is a primitive and has no identity to
  // record, which is why those cases still assert over a returned verdict.

  const NEVER_READ = /never came from a read/;

  it('refuses a bigint literal where a derivation is required', () => {
    const literal = 1150n;
    // @ts-expect-error a written-out amount is not a derivation
    expect(compareExactCharge(observedWire('1150'), literal)).toBe(MONEY_ASSERTION_HOLDS);
  });

  it('refuses hand-rolled arithmetic over two derivations', () => {
    const prompt = storedTextCharge(1);
    const answer = storedTextCharge(2);
    // @ts-expect-error adding two derivations widens back to bigint; use sumOfCharges
    expect(compareExactCharge(observedWire('900'), prompt + answer)).toBe(MONEY_ASSERTION_HOLDS);
  });

  it('refuses a number where a money-state component is expected', () => {
    const literal = 0;
    // @ts-expect-error a number is not a derivation
    expect(compareMoneyState(ZERO_STATE, { purchased: literal })).not.toBe(MONEY_ASSERTION_HOLDS);
  });

  it('refuses an observation where a derivation is required', () => {
    // @ts-expect-error what the system reports is not what a spec expects of it
    expect(compareExactCharge(observedWire('1150'), observedWire('1150'))).toBe(
      MONEY_ASSERTION_HOLDS
    );
  });

  it('refuses a hand-written charge basis where a served one is required', () => {
    const handWritten = { generationChargeNanoUsd: '1', echoPrefix: '', echoSuffix: '' };
    // @ts-expect-error a basis carries the money value, so only a read may mint one
    expect(() => mockGenerationCharge(handWritten, 1)).toThrow(NEVER_READ);
  });

  it('refuses a hand-written charge basis in the text-turn minter too', () => {
    const handWritten = { generationChargeNanoUsd: '1', echoPrefix: '', echoSuffix: '' };
    // @ts-expect-error the turn minter takes the same served basis, for the same reason
    expect(() => mockTextTurnCharge(handWritten, { prompt: '', answers: 1 })).toThrow(NEVER_READ);
  });

  it('refuses a hand-written pricing row where a served one is required', () => {
    const handWritten = { perImage: '1' };
    // @ts-expect-error a pricing row carries the money value, so only a read may mint one
    expect(() => catalogPerImageCharge(handWritten, 1)).toThrow(NEVER_READ);
  });

  it('refuses a spread that rewrites the served charge and keeps the brand', () => {
    // A spread carries a symbol-keyed brand on the OBJECT straight through, so
    // branding the object alone leaves the amount rewritable with no cast. The
    // field itself is branded for that reason, and this is the pin.
    const rewritten = { ...BASIS, generationChargeNanoUsd: '424242' };
    // @ts-expect-error a plain string is not the served field it would replace
    expect(() => mockGenerationCharge(rewritten, 1)).toThrow(NEVER_READ);
  });

  it('refuses a spread that rewrites the echo the storage fee is sized from', () => {
    // Not money, but it prices money: the persisted echo's length is the
    // storage term, so rewriting it forges the expectation just as well.
    const rewritten = { ...BASIS, echoSuffix: '' };
    // @ts-expect-error every served field is branded, not only the one holding an amount
    expect(() => mockTextTurnCharge(rewritten, { prompt: 'hi', answers: 1 })).toThrow(NEVER_READ);
  });

  it('refuses a decimal dollar string where a seeded balance is required', () => {
    // The whole reason the seeded amount is a minter and not a literal: there
    // is no parameter a spec can type an amount into, so an expectation exists
    // only where the seed that established it was performed.
    const typedOut = '10.000000000';
    // @ts-expect-error a spec's own string is not the amount the seed route applied
    expect(() => seededWalletBalance(typedOut)).toThrow(NEVER_READ);
  });

  it('refuses a hand-written seeded balance where a served one is required', () => {
    const handWritten = { newBalance: '10.000000000' };
    // @ts-expect-error a seeded balance carries the money value, so only a read may mint one
    expect(() => seededWalletBalance(handWritten)).toThrow(NEVER_READ);
  });

  it('refuses a spread that rewrites the amount the seed route applied', () => {
    const rewritten = { ...SEEDED_TEN, newBalance: '424242.000000000' };
    // @ts-expect-error a plain string is not the served field it would replace
    expect(() => seededWalletBalance(rewritten)).toThrow(NEVER_READ);
  });

  it('refuses a spread that rewrites the served per-image rate', () => {
    const rewritten = { ...PER_IMAGE_PRICING, perImage: '1' };
    // @ts-expect-error a plain string is not the served field it would replace
    expect(() => catalogPerImageCharge(rewritten, 1)).toThrow(NEVER_READ);
  });

  it('refuses a hand-written money state, which would pass over numbers nothing read', () => {
    const handWritten = {
      purchasedNanoUsd: 0n,
      freeNanoUsd: 0n,
      allowanceRemainingNanoUsd: 0n,
    };
    // @ts-expect-error a fabricated before makes the nothing-moved assertion vacuous
    expect(() => compareNoMoneyMoved(handWritten, handWritten, observedWire('0'))).toThrow(
      NEVER_READ
    );
  });

  it('refuses a payload that satisfies the wire shape but was never read', () => {
    const satisfied = {
      generationChargeNanoUsd: '1150',
      echoPrefix: 'Echo:\n',
      echoSuffix: '',
    } satisfies Record<string, string>;
    // @ts-expect-error `satisfies` checks a shape against a type; it does not mint a brand
    expect(() => mockGenerationCharge(satisfied, 1)).toThrow(NEVER_READ);
  });

  it('refuses a look-alike brand declared outside this module', () => {
    const lookAlike = 1150n as LookAlikeDerived;
    // @ts-expect-error a unique symbol declared elsewhere is a different brand, whatever it is named
    expect(compareExactCharge(observedWire('1150'), lookAlike)).toBe(MONEY_ASSERTION_HOLDS);
  });

  it('refuses a hand-written attribution row, which would pass over rows nothing read', () => {
    const handWritten = [
      { messageId: 'm1', payerId: 'owner', senderUserId: null, senderLinkId: null },
    ];
    // @ts-expect-error an attribution row is a reading, so only a read may mint one
    expect(() => compareChargeAttribution(handWritten, { payerId: 'owner' })).toThrow(NEVER_READ);
  });

  it('refuses a spread that rewrites who paid', () => {
    const rewritten = [{ ...ATTRIBUTION_ROW, payerId: 'someone-else' }];
    // @ts-expect-error the served brand rides each field, so a spread cannot replace one
    expect(() => compareChargeAttribution(rewritten, { payerId: 'someone-else' })).toThrow(
      NEVER_READ
    );
  });

  it('refuses a spread that rewrites a money-state component', () => {
    const rewritten = { ...ZERO_STATE, purchasedNanoUsd: 5n };
    // @ts-expect-error the observed brand rides the field, so a spread cannot replace it
    expect(() => compareNoMoneyMoved(ZERO_STATE, rewritten, observedWire('0'))).toThrow(NEVER_READ);
  });
});

/* eslint-disable e2e-money/no-forged-money-input -- this block plants the write-through
   routes the rule reports; what it asserts is the refusal that catches the same write where
   no compile-time predicate can see it. A report here is the rule working, not a defect. */
describe('a value that never came from a read', () => {
  // Every route below type-checks, and each one parks the value where a
  // compile-time predicate cannot follow it: on a property, in a destructure,
  // in a binding assigned a statement later, or behind a helper the spec wrote
  // itself. They are refused where a resolver cannot be out-parsed — by the
  // registry the read layer records what it branded in, and by the freeze it
  // applies to the same payload.

  const NEVER_READ = /never came from a read/;
  const FROZEN = /read only property/;

  it('refuses a money state assembled at the call site', () => {
    const fabricated = {
      purchasedNanoUsd: observed(0n),
      freeNanoUsd: observed(0n),
      allowanceRemainingNanoUsd: observed(0n),
    };
    expect(() => compareNoMoneyMoved(fabricated, fabricated, observedWire('0'))).toThrow(
      NEVER_READ
    );
  });

  it('refuses a state rebuilt out of components destructured from a reading', () => {
    const { purchasedNanoUsd, freeNanoUsd } = ZERO_STATE;
    const rebuilt = {
      purchasedNanoUsd,
      freeNanoUsd,
      allowanceRemainingNanoUsd: observed(9_999_999_990n),
    };
    expect(() => compareNoMoneyMoved(ZERO_STATE, rebuilt, observedWire('0'))).toThrow(NEVER_READ);
  });

  it('refuses a fabricated state swapped in behind a property that held a reading', () => {
    const holder: { state: MoneyState } = { state: ZERO_STATE };
    const fabricated = {
      purchasedNanoUsd: observed(0n),
      freeNanoUsd: observed(0n),
      allowanceRemainingNanoUsd: observed(0n),
    };
    holder.state = fabricated;
    expect(() => compareNoMoneyMoved(ZERO_STATE, holder.state, observedWire('0'))).toThrow(
      NEVER_READ
    );
  });

  it('refuses a rewrite through an alias the annotation widened', () => {
    const widened: { purchasedNanoUsd: bigint } = ZERO_STATE;
    expect(() => {
      widened.purchasedNanoUsd = 9_999_999_990n;
    }).toThrow(FROZEN);
  });

  // The header says the reading survives either spelling but only the
  // assignment one is loud, which is the half a spec author has to know: a
  // rewrite that fails quietly leaves the assertion honest and the author
  // wondering why their forgery did nothing.
  it('leaves a reading intact under a rewrite that reports failure instead of throwing', () => {
    const reading: { purchasedNanoUsd: bigint } = ZERO_STATE;
    expect(Reflect.set(reading, 'purchasedNanoUsd', 9_999_999_990n)).toBe(false);
    expect(ZERO_STATE.purchasedNanoUsd).toBe(0n);
  });

  it('refuses a rewrite through a binding a reading was assigned into afterwards', () => {
    let widened: { purchasedNanoUsd: bigint } = { purchasedNanoUsd: 0n };
    widened = ZERO_STATE;
    expect(() => {
      widened.purchasedNanoUsd = 9_999_999_990n;
    }).toThrow(FROZEN);
  });

  it('refuses a rewrite made inside a helper the spec wrote itself', () => {
    const rewrite = (state: { purchasedNanoUsd: bigint }): void => {
      state.purchasedNanoUsd = 9_999_999_990n;
    };
    expect(() => {
      rewrite(ZERO_STATE);
    }).toThrow(FROZEN);
  });

  it('refuses a rewrite of who paid, through the row a read handed back', () => {
    const widened: { payerId: string | null } = ATTRIBUTION_ROW;
    expect(() => {
      widened.payerId = 'attacker';
    }).toThrow(FROZEN);
  });

  it('refuses an attribution row a spec wrote itself', () => {
    const written = [
      { messageId: 'm1', payerId: 'owner', senderUserId: null, senderLinkId: null },
    ] as ServedAttributionRow[];
    expect(() => compareChargeAttribution(written, { payerId: 'owner' })).toThrow(NEVER_READ);
  });

  it('refuses a charge basis that never came from a read', () => {
    const written = {
      generationChargeNanoUsd: '1',
      echoPrefix: '',
      echoSuffix: '',
    } as ServedChargeBasis;
    expect(() => mockTextTurnCharge(written, { prompt: 'hi', answers: 1 })).toThrow(NEVER_READ);
  });

  it('refuses a pricing row that never came from a read', () => {
    const written = { perImage: '1' } as ServedModelPricing;
    expect(() => catalogPerImageCharge(written, 1)).toThrow(NEVER_READ);
  });

  it('refuses a seeded balance rewritten in place through a widened alias', () => {
    const alias: { newBalance: string } = SEEDED_TEN;
    expect(() => {
      alias.newBalance = '424242.000000000';
    }).toThrow(FROZEN);
  });

  it('refuses a fabricated baseline against a genuine wallet reading', () => {
    // The caller-supplied arm: a spec holds the baseline across the action, so
    // this is the half a forgery actually reaches.
    const fabricated = {
      purchasedNanoUsd: observed(0n),
      freeNanoUsd: observed(0n),
      allowanceRemainingNanoUsd: observed(0n),
    };
    expect(() => compareNoWalletMovement(fabricated, readState())).toThrow(NEVER_READ);
  });

  it('refuses a fabricated wallet reading against a genuine baseline', () => {
    const fabricated = {
      purchasedNanoUsd: observed(0n),
      freeNanoUsd: observed(0n),
      allowanceRemainingNanoUsd: observed(0n),
    };
    expect(() => compareNoWalletMovement(readState(), fabricated)).toThrow(NEVER_READ);
  });

  it('compares the subset of read rows a spec means, which is not a forgery', () => {
    const rows = [ATTRIBUTION_ROW, GUEST_ROW].filter(
      (candidate) => candidate.senderLinkId === null
    );
    expect(compareChargeAttribution(rows, { payerId: 'owner', senderUserId: 'bob' })).toBe(
      MONEY_ASSERTION_HOLDS
    );
  });

  it('compares a delta the vocabulary itself derived from two readings', () => {
    expect(
      compareBalanceDelta(readState({ purchased: 200_000_000n }), readState(), {
        purchased: spendOf(mockGenerationCharge(BASIS, 1)),
      })
    ).not.toBe(MONEY_ASSERTION_HOLDS);
  });
});
/* eslint-enable e2e-money/no-forged-money-input */

describe('compareExactCharge', () => {
  it('holds when the charge equals the derivation to the nano', () => {
    expect(compareExactCharge(observedWire('1150'), mockGenerationCharge(BASIS, 1))).toBe(
      MONEY_ASSERTION_HOLDS
    );
  });

  it('fails on a one-nano divergence, naming both sides', () => {
    const verdict = compareExactCharge(observedWire('1151'), mockGenerationCharge(BASIS, 1));
    expect(verdict).not.toBe(MONEY_ASSERTION_HOLDS);
    expect(verdict).toContain('1151');
    expect(verdict).toContain('1150');
  });

  it('fails when a whole second charge lands', () => {
    expect(compareExactCharge(observedWire('2300'), mockGenerationCharge(BASIS, 1))).not.toBe(
      MONEY_ASSERTION_HOLDS
    );
  });

  // A zero derivation holds over the zero an unsettled conversation reads, and
  // it needs no cast to build: the storage minters admit a zero size.
  it('refuses a zero derivation, which any pre-settlement read satisfies', () => {
    expect(() => compareExactCharge(observedWire('0'), storedTextCharge(0))).toThrow(
      /compareNoMoneyMoved/
    );
  });
});

describe('compareHoldCoverage', () => {
  it('holds when the admission hold covers what settlement charged', () => {
    expect(compareHoldCoverage(observedWire('5000'), observedWire('1150'))).toBe(
      MONEY_ASSERTION_HOLDS
    );
  });

  it('fails when the charge exceeds the hold that admitted it', () => {
    expect(compareHoldCoverage(observedWire('1000'), observedWire('1150'))).not.toBe(
      MONEY_ASSERTION_HOLDS
    );
  });

  it('fails on a zero hold, which would cover any charge vacuously', () => {
    expect(compareHoldCoverage(observedWire('0'), observedWire('1150'))).not.toBe(
      MONEY_ASSERTION_HOLDS
    );
  });

  // The charge read sums usage records, so an unsettled conversation reads zero
  // — "not yet", not "nothing was charged". Holding there would end the poll on
  // its first pre-settlement sample, which is the window the hold is read in.
  it('fails on a zero charge, which is settlement not having happened yet', () => {
    expect(compareHoldCoverage(observedWire('5000'), observedWire('0'))).not.toBe(
      MONEY_ASSERTION_HOLDS
    );
  });

  // `>=` COERCES, where every sibling comparator's `===` does not: a decimal
  // string, a `BigInt` wrapper and a plain number all compare true against a
  // bigint and would return a passing verdict over a hold nothing read. The
  // refusal is at runtime because the values arrive through a parameter the
  // compiler has already accepted.
  it('refuses a hold that is a string, which `>=` would silently coerce', () => {
    expect(
      compareHoldCoverage('999999999' as unknown as ObservedNanoUsd, observedWire('1150'))
    ).not.toBe(MONEY_ASSERTION_HOLDS);
  });

  it('refuses a hold that is a BigInt wrapper object, which `>=` would silently coerce', () => {
    expect(
      compareHoldCoverage(new Object(999_999_999n) as ObservedNanoUsd, observedWire('1150'))
    ).not.toBe(MONEY_ASSERTION_HOLDS);
  });

  it('refuses a hold that is a plain number, which `>=` would silently coerce', () => {
    expect(
      compareHoldCoverage(999_999_999 as unknown as ObservedNanoUsd, observedWire('1150'))
    ).not.toBe(MONEY_ASSERTION_HOLDS);
  });

  it('refuses a charge that is not a bigint, the same coercion from the other side', () => {
    expect(compareHoldCoverage(observedWire('5000'), '1' as unknown as ObservedNanoUsd)).not.toBe(
      MONEY_ASSERTION_HOLDS
    );
  });
});

describe('compareMoneyState', () => {
  it('holds when every named component equals its derivation', () => {
    expect(
      compareMoneyState(readState({ purchased: 200_000_000n, allowance: 50_000_000n }), {
        purchased: grantedWelcomeCredit(),
        allowanceRemaining: grantedDailyFreeAllowance(),
      })
    ).toBe(MONEY_ASSERTION_HOLDS);
  });

  it('fails when a named component diverges', () => {
    const verdict = compareMoneyState(readState({ purchased: 199_999_999n }), {
      purchased: grantedWelcomeCredit(),
    });
    expect(verdict).toContain('purchased');
    expect(verdict).toContain('199999999');
  });

  it('compares the free wallet when it is named', () => {
    expect(compareMoneyState(readState({ free: 300n }), { free: storedTextCharge(1) })).toBe(
      MONEY_ASSERTION_HOLDS
    );
  });

  it('refuses an expectation that names no component', () => {
    expect(() => compareMoneyState(ZERO_STATE, {})).toThrow(RangeError);
  });
});

describe('compareBalanceDelta', () => {
  it('holds when the purchased wallet moved by exactly the derived spend', () => {
    expect(
      compareBalanceDelta(
        readState({ purchased: 200_000_000n }),
        readState({ purchased: 199_998_850n }),
        { purchased: spendOf(mockGenerationCharge(BASIS, 1)) }
      )
    ).toBe(MONEY_ASSERTION_HOLDS);
  });

  it('fails when the wallet moved by a different amount', () => {
    expect(
      compareBalanceDelta(
        readState({ purchased: 200_000_000n }),
        readState({ purchased: 199_997_700n }),
        { purchased: spendOf(mockGenerationCharge(BASIS, 1)) }
      )
    ).not.toBe(MONEY_ASSERTION_HOLDS);
  });

  it('refuses an expectation whose every named component is zero', () => {
    expect(() =>
      compareBalanceDelta(readState({ purchased: 500n }), readState({ purchased: 500n }), {
        purchased: storedTextCharge(0),
        free: storedTextCharge(0),
      })
    ).toThrow(/compareNoMoneyMoved/);
  });

  // One non-zero component keeps the assertion gated on something that has to
  // happen, so a zero beside it is a real expectation rather than a vacuity.
  it('compares a mixed expectation, where a zero component is meant', () => {
    expect(
      compareBalanceDelta(
        readState({ purchased: 200_000_000n, free: 100n }),
        readState({ purchased: 199_998_850n, free: 100n }),
        { purchased: spendOf(mockGenerationCharge(BASIS, 1)), free: storedTextCharge(0) }
      )
    ).toBe(MONEY_ASSERTION_HOLDS);
  });
});

describe('compareNoMoneyMoved', () => {
  it('holds when nothing was charged and no balance moved', () => {
    expect(compareNoMoneyMoved(ZERO_STATE, ZERO_STATE, observedWire('0'))).toBe(
      MONEY_ASSERTION_HOLDS
    );
  });

  it('fails when the conversation was charged', () => {
    expect(compareNoMoneyMoved(ZERO_STATE, ZERO_STATE, observedWire('1150'))).toContain('1150');
  });

  it('fails when the purchased wallet moved even though nothing was charged', () => {
    expect(
      compareNoMoneyMoved(readState({ purchased: 5n }), ZERO_STATE, observedWire('0'))
    ).toContain('purchased moved');
  });

  it('fails when the free wallet moved even though nothing was charged', () => {
    expect(compareNoMoneyMoved(readState({ free: 5n }), ZERO_STATE, observedWire('0'))).toContain(
      'free moved'
    );
  });

  it('fails when the day s allowance moved even though nothing was charged', () => {
    expect(
      compareNoMoneyMoved(readState({ allowance: 5n }), ZERO_STATE, observedWire('0'))
    ).toContain('allowance moved');
  });
});

describe('compareNoWalletMovement', () => {
  it('holds when no wallet and no allowance moved', () => {
    expect(compareNoWalletMovement(ZERO_STATE, ZERO_STATE)).toBe(MONEY_ASSERTION_HOLDS);
  });

  it('fails when the purchased wallet moved', () => {
    expect(compareNoWalletMovement(readState({ purchased: 5n }), ZERO_STATE)).toContain(
      'purchased moved'
    );
  });

  it('fails when the free wallet moved', () => {
    expect(compareNoWalletMovement(readState({ free: 5n }), ZERO_STATE)).toContain('free moved');
  });

  it('fails when the day s allowance moved', () => {
    expect(compareNoWalletMovement(readState({ allowance: 5n }), ZERO_STATE)).toContain(
      'allowance moved'
    );
  });

  it('names every wallet that moved, not only the first', () => {
    expect(compareNoWalletMovement(readState({ purchased: 5n, free: 7n }), ZERO_STATE)).toBe(
      'purchased moved by -5; free moved by -7'
    );
  });
});

describe('compareChargeAttribution', () => {
  const row = ATTRIBUTION_ROW;

  it('holds when every charged message names the expected payer and sender', () => {
    expect(compareChargeAttribution([row], { payerId: 'owner', senderUserId: 'bob' })).toBe(
      MONEY_ASSERTION_HOLDS
    );
  });

  it('fails when the wrong wallet paid', () => {
    expect(compareChargeAttribution([row], { payerId: 'bob' })).toContain('bob');
  });

  it('fails when the sender is not the one expected', () => {
    expect(compareChargeAttribution([row], { payerId: 'owner', senderUserId: 'carol' })).not.toBe(
      MONEY_ASSERTION_HOLDS
    );
  });

  it('compares the link sender when a guest sent the turn', () => {
    expect(compareChargeAttribution([GUEST_ROW], { payerId: 'owner', senderLinkId: 'link' })).toBe(
      MONEY_ASSERTION_HOLDS
    );
  });

  it('fails on no charged messages rather than passing over an empty set', () => {
    expect(compareChargeAttribution([], { payerId: 'owner' })).not.toBe(MONEY_ASSERTION_HOLDS);
  });

  it('refuses an expectation that names no payer', () => {
    expect(() => compareChargeAttribution([row], { payerId: '' })).toThrow(RangeError);
  });
});

describe('compareDelegatedBudget', () => {
  it('holds when the served remaining is the whole delegated cap', () => {
    expect(compareDelegatedBudget(readDelegation(5_000_000_000n, 5_000_000_000n))).toBe(
      MONEY_ASSERTION_HOLDS
    );
  });

  it('reports a remaining that something clamped below the delegated cap', () => {
    expect(compareDelegatedBudget(readDelegation(5_000_000_000n, 1_000_000_000n))).toBe(
      'a 5000000000 nano-USD delegation leaves 1000000000 nano-USD spendable'
    );
  });

  it('refuses a zero cap, which every remaining would satisfy vacuously', () => {
    expect(compareDelegatedBudget(readDelegation(0n, 0n))).toBe('no budget was delegated');
  });

  it('refuses a delegation that never came from a read', () => {
    const written: MemberDelegation = {
      capNanoUsd: observed(5_000_000_000n),
      effectiveRemainingNanoUsd: observed(5_000_000_000n),
    };
    expect(() => compareDelegatedBudget(written)).toThrow(/never came from a read/);
  });
});
