import { describe, expect, it } from 'vitest';
import { deviceFamily, edgeGeography, normaliseCountry, normaliseRegion } from './dimensions.js';

describe('deviceFamily', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    [
      'desktop Chrome on macOS',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'desktop',
    ],
    [
      'desktop Firefox on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/121.0',
      'desktop',
    ],
    [
      'desktop Chrome on Linux',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120',
      'desktop',
    ],
    [
      'iPhone Safari',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      'mobile',
    ],
    [
      'Android phone Chrome',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537.36',
      'mobile',
    ],
    [
      'iPad Safari',
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1',
      'tablet',
    ],
    [
      'Android tablet Chrome',
      'Mozilla/5.0 (Linux; Android 14; SM-X200) Chrome/120 Safari/537.36',
      'tablet',
    ],
    ['an empty user agent', '', 'other'],
    ['a user agent naming no platform', 'my-own-client/1.0', 'other'],
  ];

  it.each(cases)('classifies %s', (_label, userAgent, expected) => {
    expect(deviceFamily(userAgent)).toBe(expected);
  });

  // A tablet reports the same platform token as a phone and differs only by
  // the absence of the mobile marker, so the tablet test has to run first.
  it('does not call an Android tablet a phone', () => {
    expect(deviceFamily('Mozilla/5.0 (Linux; Android 14; SM-X200) Chrome/120 Safari/537.36')).toBe(
      'tablet'
    );
  });
});

describe('normaliseCountry', () => {
  it('keeps a two-letter country code', () => {
    expect(normaliseCountry('DE')).toBe('DE');
  });

  it('uppercases a lowercase code', () => {
    expect(normaliseCountry('de')).toBe('DE');
  });

  // "We do not know where this was" has ONE spelling in these rows. The edge
  // says it two ways — `XX` for an address it could not place, `T1` for Tor —
  // and one of them is two uppercase letters, so a shape test alone would let
  // it through and leave a permanently-retained table carrying two values that
  // mean the same thing.
  const unknownToTheEdge: readonly (readonly [string, string])[] = [
    ['the unplaced marker', 'XX'],
    ['the Tor marker', 'T1'],
  ];
  it.each(unknownToTheEdge)('folds %s into the one unknown spelling', (_label, raw) => {
    expect(normaliseCountry(raw)).toBe('');
  });

  it('gives both edge markers the same stored value', () => {
    expect(normaliseCountry('XX')).toBe(normaliseCountry('T1'));
  });

  const dropped: readonly (readonly [string, string])[] = [
    ['a three-letter code', 'DEU'],
    ['an empty header', ''],
  ];
  it.each(dropped)('drops %s', (_label, raw) => {
    expect(normaliseCountry(raw)).toBe('');
  });

  it('drops an absent header', () => {
    expect(normaliseCountry()).toBe('');
  });
});

describe('normaliseRegion', () => {
  it('keeps a US state code', () => {
    expect(normaliseRegion('US', 'CA')).toBe('CA');
  });

  it('uppercases a lowercase US state code', () => {
    expect(normaliseRegion('US', 'ca')).toBe('CA');
  });

  // Nothing finer than a US state exists anywhere in this design: a region
  // outside the US is dropped at the beacon, so no row can ever carry one.
  it('drops a region outside the United States', () => {
    expect(normaliseRegion('DE', 'BY')).toBe('');
  });

  it('drops a region when the country itself was dropped', () => {
    expect(normaliseRegion('', 'CA')).toBe('');
  });

  it('drops a region that is not two letters', () => {
    expect(normaliseRegion('US', 'CAL')).toBe('');
  });

  it('drops an absent region', () => {
    expect(normaliseRegion('US')).toBe('');
  });
});

describe('edgeGeography', () => {
  it('reads the country and the subdivision code the edge attached', () => {
    const request = new Request('http://localhost/e');
    Object.defineProperty(request, 'cf', {
      value: { country: 'US', region: 'California', regionCode: 'CA' },
    });
    expect(edgeGeography(request)).toEqual({ country: 'US', region: 'CA' });
  });

  // The normalisers above own every judgement about these values, so this read
  // hands over whatever the edge attached rather than deciding anything itself.
  it('hands over a value that names no country unchanged', () => {
    const request = new Request('http://localhost/e');
    Object.defineProperty(request, 'cf', { value: { country: 7, regionCode: null } });
    expect(edgeGeography(request)).toEqual({ country: 7, region: null });
  });

  // A request that never crossed the edge carries no such property at all,
  // which is what every local run and every test that builds its own request
  // looks like.
  it('finds nothing on a request the edge never touched', () => {
    expect(edgeGeography(new Request('http://localhost/e'))).toEqual({
      country: undefined,
      region: undefined,
    });
  });

  it('finds nothing when the edge attached no geography', () => {
    const request = new Request('http://localhost/e');
    Object.defineProperty(request, 'cf', { value: {} });
    expect(edgeGeography(request)).toEqual({ country: undefined, region: undefined });
  });

  const nothingToRead: readonly (readonly [string, unknown])[] = [
    ['an absent request', undefined],
    ['a null request', null],
    ['a property holding no object', 'CF'],
  ];
  it.each(nothingToRead)('finds nothing in %s', (_label, source) => {
    const request =
      typeof source === 'string'
        ? Object.defineProperty(new Request('http://localhost/e'), 'cf', { value: source })
        : source;
    expect(edgeGeography(request)).toEqual({ country: undefined, region: undefined });
  });
});
