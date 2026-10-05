/**
 * Whatever rows a media listing states, the reserve covers each of them, every
 * rate read as ingestion reads it (a rate below 1 nano-USD reads as 0): an
 * image's dearest rate is at least every per-image row and is one of them, its
 * anchor at most every row and one of them; a video resolution that some SKU
 * can bill is priced at least every SKU that can bill it — its own and the flat
 * ones, with and without audio — and at one of them.
 *
 * Generators: `rateArb` draws vendor decimal rates of up to 30 fractional
 * digits, half from `pooledRateArb` and half from `deepRateArb`.
 * `pooledRateArb` draws from a small value pool, so equal rates recur, mostly
 * below 1 nano-USD, and pads half of its draws with trailing zeros, so two
 * spellings of one value meet. `deepRateArb` draws rates of at least 1 nano-USD
 * that carry nonzero digits to the 30th place, on shared 20-digit prefixes;
 * `imageRowsArb` draws one to five per-image rows; `videoSkusArb` draws a rate
 * for each of a subset of a fixed set of resolution-specific and flat SKU keys.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { imageRates, videoRates } from './media-rates.js';
import type { ImagePricingEntry } from './gateway-metadata.js';

/** The most fractional digits a drawn vendor rate carries. */
const VENDOR_FRACTION_DIGITS = 30;

/** Every drawn rate as an integer count of 10⁻⁴⁰ USD: an exact order that shares no code with the module. */
function scaled(rate: string): bigint {
  const [whole = '', fraction = ''] = rate.split('.');
  return BigInt(whole + fraction.padEnd(40, '0'));
}

/** 1 nano-USD, scaled as {@link scaled} scales a rate. */
const ONE_NANO_SCALED = 10n ** 31n;

/** A drawn rate as ingestion reads it: one below 1 nano-USD reads as `0`. */
function asRead(rate: string): string {
  return scaled(rate) < ONE_NANO_SCALED ? '0' : rate;
}

function decimalOf(units: bigint, fractionDigits: number): string {
  const digits = units.toString().padStart(fractionDigits + 1, '0');
  return `${digits.slice(0, -fractionDigits)}.${digits.slice(-fractionDigits)}`;
}

/** A short rate from a small pool, sub-nano more often than not, half of them zero-padded. */
const pooledRateArb: fc.Arbitrary<string> = fc
  .record({
    fractionDigits: fc.integer({ min: 1, max: VENDOR_FRACTION_DIGITS - 3 }),
    units: fc.bigInt({ min: 1n, max: 40n }),
    padding: fc.constantFrom('', '', '0', '000'),
  })
  .map(({ fractionDigits, units, padding }) => decimalOf(units, fractionDigits) + padding);

/**
 * A rate of at least 1 nano-USD whose digits run to the 30th fractional place:
 * one of a few 20-digit prefixes, then 10 drawn digits ending in a nonzero one.
 * Two draws on one prefix differ only past the 20th place, where a 12-digit
 * truncation or a float comparison sees them as equal.
 */
const deepRateArb: fc.Arbitrary<string> = fc
  .record({
    prefix: fc.constantFrom(
      '0.00000000200000000000',
      '0.00004500000000000000',
      '0.09000000000000000000'
    ),
    tail: fc.bigInt({ min: 0n, max: 10n ** 9n - 1n }),
    last: fc.integer({ min: 1, max: 9 }),
  })
  .map(({ prefix, tail, last }) => `${prefix}${tail.toString().padStart(9, '0')}${String(last)}`);

const rateArb: fc.Arbitrary<string> = fc.oneof(pooledRateArb, deepRateArb);

const imageRowsArb: fc.Arbitrary<ImagePricingEntry[]> = fc.array(
  rateArb.map((costUsd) => ({ billable: 'output_image', unit: 'image', costUsd })),
  { minLength: 1, maxLength: 5 }
);

const VIDEO_SKU_KEYS = [
  'duration_seconds',
  'duration_seconds_with_audio',
  'duration_seconds_without_audio',
  'duration_seconds_720p',
  'duration_seconds_with_audio_720p',
  'duration_seconds_without_audio_720p',
  'text_to_video_duration_seconds_1080p',
  'duration_seconds_with_audio_1080p',
] as const;

/** Which declared resolution each key can bill; a flat key bills every one. */
const BILLS: Readonly<Record<string, string | null>> = {
  duration_seconds: null,
  duration_seconds_with_audio: null,
  duration_seconds_without_audio: null,
  duration_seconds_720p: '720p',
  duration_seconds_with_audio_720p: '720p',
  duration_seconds_without_audio_720p: '720p',
  text_to_video_duration_seconds_1080p: '1080p',
  duration_seconds_with_audio_1080p: '1080p',
};

const videoSkusArb: fc.Arbitrary<Record<string, string>> = fc
  .subarray([...VIDEO_SKU_KEYS])
  .chain((keys) =>
    fc.array(rateArb, { minLength: keys.length, maxLength: keys.length }).map((rates) =>
      Object.fromEntries(
        keys.flatMap((key, index) => {
          const rate = rates[index];
          return rate === undefined ? [] : [[key, rate] as const];
        })
      )
    )
  );

describe('media rates (property)', () => {
  it('reserves an image at a listed row no cheaper than any other', () => {
    fc.assert(
      fc.property(imageRowsArb, (rows) => {
        const rates = imageRates(rows);
        if (rates.kind !== 'priced') throw new Error(`expected priced, got ${rates.kind}`);
        const listed = rows.map((row) => asRead(row.costUsd));
        expect(listed).toContain(rates.dearest);
        for (const rate of listed) expect(scaled(rates.dearest) >= scaled(rate)).toBe(true);
      })
    );
  });

  it('anchors an image at a listed row no dearer than any other', () => {
    fc.assert(
      fc.property(imageRowsArb, (rows) => {
        const rates = imageRates(rows);
        if (rates.kind !== 'priced') throw new Error(`expected priced, got ${rates.kind}`);
        const listed = rows.map((row) => asRead(row.costUsd));
        expect(listed).toContain(rates.anchor);
        for (const rate of listed) expect(scaled(rates.anchor) <= scaled(rate)).toBe(true);
      })
    );
  });

  it('prices each video resolution some SKU can bill at one such SKU, no cheaper than any other', () => {
    fc.assert(
      fc.property(videoSkusArb, (skus) => {
        const priced = videoRates(['720p', '1080p'], skus);
        if (priced.kind !== 'priced') return;
        for (const resolution of ['720p', '1080p']) {
          const billing = Object.entries(skus)
            .filter(([key]) => BILLS[key] === null || BILLS[key] === resolution)
            .map(([, rate]) => asRead(rate));
          if (billing.length === 0) continue;
          const stored = priced.perSecondByResolution[resolution] ?? '';
          expect(billing).toContain(stored);
          for (const rate of billing) expect(scaled(stored) >= scaled(rate)).toBe(true);
        }
      })
    );
  });
});
