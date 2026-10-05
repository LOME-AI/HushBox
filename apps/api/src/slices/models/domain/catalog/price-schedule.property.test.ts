/**
 * Whatever endpoints a model lists, the anchor schedule read off them keeps
 * the descriptor invariants: tiers strictly ascending by the prompt-token
 * count they apply above, and no rate falling as tiers rise, the first tier at
 * least the base. The anchor does not depend on the order the listing names
 * its endpoints, and its base is one eligible endpoint's own listed price.
 *
 * Generators: `rateArb` draws vendor decimal rates of up to 30 fractional
 * digits, magnitude first: the digit count is drawn before the digits, so a
 * rate a few digits long is as likely as one 30 digits long; `endpointArb`
 * draws a tag that is a flex variant one time in four, a cap and a context
 * that are unstated one time in four, and up to three long-context overrides
 * that each restate neither, one or both rates.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { zdrEndpointFixture } from './gateway-fixtures.js';
import { anchorScheduleOf } from './price-schedule.js';
import type { LanguageTokenPricing, RawOverride, ZdrEndpoint } from './gateway-metadata.js';
import type { DecimalSchedule } from './price-schedule.js';

/** The most fractional digits a drawn vendor rate carries. */
const VENDOR_FRACTION_DIGITS = 30;

function decimalOf(units: bigint, fractionDigits: number): string {
  const digits = units.toString().padStart(fractionDigits + 1, '0');
  return `${digits.slice(0, -fractionDigits)}.${digits.slice(-fractionDigits)}`;
}

/** A decimal rate, its digit count drawn before its value. */
const rateArb: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: VENDOR_FRACTION_DIGITS })
  .chain((fractionDigits) =>
    fc
      .bigInt({ min: 1n, max: 10n ** BigInt(Math.min(fractionDigits, 12)) })
      .map((units) => decimalOf(units, fractionDigits))
  );

const limitArb: fc.Arbitrary<number | undefined> = fc.option(
  fc.integer({ min: 1000, max: 2_000_000 }),
  { nil: undefined, freq: 4 }
);

const overrideArb: fc.Arbitrary<RawOverride> = fc.record(
  {
    min_prompt_tokens: fc.integer({ min: 1, max: 2_000_000 }),
    prompt: rateArb,
    completion: rateArb,
  },
  { requiredKeys: ['min_prompt_tokens'] }
);

const endpointArb: fc.Arbitrary<ZdrEndpoint> = fc
  .record({
    name: fc.constantFrom('alpha', 'beta', 'gamma', 'delta'),
    flex: fc.integer({ min: 0, max: 3 }).map((draw) => draw === 0),
    prompt: rateArb,
    completion: rateArb,
    maxCompletionTokens: limitArb,
    contextLength: limitArb,
    overrides: fc.array(overrideArb, { maxLength: 3 }),
  })
  .map((drawn) =>
    zdrEndpointFixture({
      tag: drawn.flex ? `${drawn.name}/flex` : drawn.name,
      pricing: { prompt: drawn.prompt, completion: drawn.completion },
      overrides: drawn.overrides,
      ...(drawn.maxCompletionTokens === undefined
        ? {}
        : { maxCompletionTokens: drawn.maxCompletionTokens }),
      ...(drawn.contextLength === undefined ? {} : { contextLength: drawn.contextLength }),
    })
  );

const listingArb = fc.array(endpointArb, { minLength: 1, maxLength: 5 });

const catalogArb = fc.record({ maxOutputTokens: limitArb, contextLength: limitArb });

/** Two decimal strings compared exactly. */
function compareDecimal(a: string, b: string): number {
  const [aWhole = '', aFraction = ''] = a.split('.');
  const [bWhole = '', bFraction = ''] = b.split('.');
  const scale = Math.max(aFraction.length, bFraction.length);
  const left = BigInt(aWhole + aFraction.padEnd(scale, '0'));
  const right = BigInt(bWhole + bFraction.padEnd(scale, '0'));
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function noRateFalls(below: LanguageTokenPricing, above: LanguageTokenPricing): boolean {
  return (
    compareDecimal(above.prompt, below.prompt) >= 0 &&
    compareDecimal(above.completion, below.completion) >= 0
  );
}

function scheduleOf(
  endpoints: readonly ZdrEndpoint[],
  catalog: { maxOutputTokens: number | undefined; contextLength: number | undefined }
): DecimalSchedule | undefined {
  const result = anchorScheduleOf(endpoints, {
    ...catalog,
    supportedParameters: ['max_tokens', 'tools', 'reasoning'],
  });
  return result.kind === 'scheduled' ? result.schedule : undefined;
}

describe('anchorScheduleOf over generated listings', () => {
  it('orders tiers strictly ascending by threshold', () => {
    fc.assert(
      fc.property(listingArb, catalogArb, (endpoints, catalog) => {
        const tiers = scheduleOf(endpoints, catalog)?.tiers ?? [];
        const thresholds = tiers.map((tier) => tier.abovePromptTokens);
        expect(thresholds).toEqual([...new Set(thresholds)].toSorted((a, b) => a - b));
      })
    );
  });

  it('never lets a rate fall as tiers rise, the first tier at least the base', () => {
    fc.assert(
      fc.property(listingArb, catalogArb, (endpoints, catalog) => {
        const schedule = scheduleOf(endpoints, catalog);
        const levels =
          schedule === undefined
            ? []
            : [schedule.base, ...schedule.tiers.map((tier) => tier.rates)];
        expect(
          levels.filter(
            (rates, index) => index > 0 && !noRateFalls(levels[index - 1] ?? rates, rates)
          )
        ).toEqual([]);
      })
    );
  });

  it('keeps every tier below the model context', () => {
    fc.assert(
      fc.property(listingArb, catalogArb, (endpoints, catalog) => {
        const result = anchorScheduleOf(endpoints, {
          ...catalog,
          supportedParameters: ['max_tokens'],
        });
        const tiers = result.kind === 'scheduled' ? result.schedule.tiers : [];
        const contextLength = result.kind === 'scheduled' ? result.contextLength : undefined;
        expect(
          tiers.filter(
            (tier) => contextLength !== undefined && tier.abovePromptTokens >= contextLength
          )
        ).toEqual([]);
      })
    );
  });

  it('gives the same schedule whichever order the listing names its endpoints', () => {
    fc.assert(
      fc.property(listingArb, catalogArb, (endpoints, catalog) => {
        expect(scheduleOf(endpoints.toReversed(), catalog)).toEqual(scheduleOf(endpoints, catalog));
      })
    );
  });

  it("takes its base from one standard-tier endpoint's own listed price", () => {
    fc.assert(
      fc.property(listingArb, catalogArb, (endpoints, catalog) => {
        const schedule = scheduleOf(endpoints, catalog);
        if (schedule === undefined) return;
        const listed = endpoints.some(
          (endpoint) =>
            !endpoint.tag.endsWith('/flex') &&
            endpoint.pricing !== 'unreadable' &&
            endpoint.pricing['prompt'] !== undefined &&
            compareDecimal(String(endpoint.pricing['prompt']), schedule.base.prompt) === 0 &&
            compareDecimal(String(endpoint.pricing['completion']), schedule.base.completion) === 0
        );
        expect(listed).toBe(true);
      })
    );
  });
});
