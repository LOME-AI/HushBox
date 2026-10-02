import { describe, expect, it } from 'vitest';

import {
  beaconSchema,
  GROWTH_BEACON_MAX_BODY_BYTES,
  GROWTH_BEACON_PATH,
  isKnownEvent,
  canonicalMarketingPath,
  isKnownMarketingPage,
} from './beacon.ts';
import {
  GROWTH_EVENT_NAME_MAX_LENGTH,
  GROWTH_HOST_MAX_LENGTH,
  GROWTH_PATH_MAX_LENGTH,
} from './patterns.ts';
import type { GrowthEventIndex } from './beacon.ts';

describe('beaconSchema', () => {
  it('accepts a pageview carrying every optional field', () => {
    const result = beaconSchema.safeParse({
      t: 'v',
      p: '/blog/a-hyphenated-slug',
      r: 'news.ycombinator.com',
      c: 'launch-2026',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an event carrying a derived name', () => {
    expect(beaconSchema.safeParse({ t: 'e', p: '/welcome', n: 'link:/chat' }).success).toBe(true);
  });

  it('accepts a pageview carrying only the two required fields', () => {
    expect(beaconSchema.safeParse({ t: 'v', p: '/welcome' }).success).toBe(true);
  });

  it.each([
    ['an unknown type', { t: 'x', p: '/welcome' }],
    ['a missing type', { p: '/welcome' }],
    ['a missing path', { t: 'v' }],
    ['a path with a query string', { t: 'v', p: '/welcome?c=launch' }],
    ['a path with no leading slash', { t: 'v', p: 'welcome' }],
    ['a non-string path', { t: 'v', p: 7 }],
  ])('rejects %s', (_reason, body) => {
    expect(beaconSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a path one character past the bound and accepts one at it', () => {
    const atBound = `/${'a'.repeat(GROWTH_PATH_MAX_LENGTH - 1)}`;
    expect(beaconSchema.safeParse({ t: 'v', p: atBound }).success).toBe(true);
    expect(beaconSchema.safeParse({ t: 'v', p: `${atBound}a` }).success).toBe(false);
  });

  it('rejects a referrer that carries a scheme separator rather than a bare hostname', () => {
    expect(
      beaconSchema.safeParse({ t: 'v', p: '/welcome', r: 'https://evil.example.com' }).success
    ).toBe(false);
  });

  it('accepts a referrer at exactly the hostname bound', () => {
    expect(
      beaconSchema.safeParse({ t: 'v', p: '/welcome', r: 'a'.repeat(GROWTH_HOST_MAX_LENGTH) })
        .success
    ).toBe(true);
  });

  it('rejects a referrer past the hostname bound', () => {
    expect(beaconSchema.safeParse({ t: 'v', p: '/welcome', r: 'a'.repeat(254) }).success).toBe(
      false
    );
  });

  it('rejects a campaign tag the tag shape refuses', () => {
    expect(beaconSchema.safeParse({ t: 'v', p: '/welcome', c: 'Launch 2026' }).success).toBe(false);
  });

  it('accepts an event name at exactly the 80-character bound', () => {
    const atBound = 'a'.repeat(GROWTH_EVENT_NAME_MAX_LENGTH);
    expect(beaconSchema.safeParse({ t: 'e', p: '/welcome', n: atBound }).success).toBe(true);
  });

  it('rejects an event name one character past the 80-character bound', () => {
    const pastBound = 'a'.repeat(GROWTH_EVENT_NAME_MAX_LENGTH + 1);
    expect(beaconSchema.safeParse({ t: 'e', p: '/welcome', n: pastBound }).success).toBe(false);
  });
});

describe('GROWTH_BEACON_PATH', () => {
  it('is the same-origin path the beacon posts to', () => {
    expect(GROWTH_BEACON_PATH).toBe('/e');
  });
});

describe('GROWTH_BEACON_MAX_BODY_BYTES', () => {
  it('is the 1 KB body the sender must stay under and the reader refuses past', () => {
    expect(GROWTH_BEACON_MAX_BODY_BYTES).toBe(1024);
  });
});

describe('canonicalMarketingPath', () => {
  // Validating under one spelling and COUNTING under another writes a Redis
  // key, an index member and then a permanently-retained row under a value the
  // built page set never contained, splitting one page across two rows that
  // nothing downstream can recognise as one page. So the reader canonicalises
  // once and counts under the answer.
  it('drops a trailing slash, which is how a browser reports a directory-built page', () => {
    expect(canonicalMarketingPath('/welcome/')).toBe('/welcome');
  });

  it('leaves a path that carries no trailing slash', () => {
    expect(canonicalMarketingPath('/welcome')).toBe('/welcome');
  });

  it('leaves the site root, whose only character is the slash', () => {
    expect(canonicalMarketingPath('/')).toBe('/');
  });

  it('drops only the last slash of a nested path', () => {
    expect(canonicalMarketingPath('/blog/a-post/')).toBe('/blog/a-post');
  });

  it('answers the same value for a value it already canonicalised', () => {
    expect(canonicalMarketingPath(canonicalMarketingPath('/welcome/'))).toBe(
      canonicalMarketingPath('/welcome/')
    );
  });
});

describe('isKnownMarketingPage', () => {
  const built = ['/blog/a-hyphenated-slug', '/newsletter/confirmed'];

  it('accepts a static marketing route', () => {
    expect(isKnownMarketingPage('/welcome', built)).toBe(true);
  });

  it('accepts a page the marketing build emitted', () => {
    expect(isKnownMarketingPage('/blog/a-hyphenated-slug', built)).toBe(true);
  });

  it('accepts a path whose only difference is a trailing slash, which is how the site serves it', () => {
    expect(isKnownMarketingPage('/welcome/', built)).toBe(true);
    expect(isKnownMarketingPage('/blog/a-hyphenated-slug/', built)).toBe(true);
  });

  it('refuses a path under a known prefix that was never built', () => {
    expect(isKnownMarketingPage('/blog/anything-at-all', built)).toBe(false);
  });

  it('refuses an app route that is not a marketing page', () => {
    expect(isKnownMarketingPage('/chat', built)).toBe(false);
  });

  it('refuses a path with no built page and no static route', () => {
    expect(isKnownMarketingPage('/junk', [])).toBe(false);
  });
});

describe('isKnownEvent', () => {
  const index: GrowthEventIndex = {
    '/welcome': ['link:/chat', 'scroll-25'],
    '/privacy': ['link:/terms'],
  };

  it('accepts a name the build derived for that page', () => {
    expect(isKnownEvent('/welcome', 'link:/chat', index)).toBe(true);
  });

  it('refuses a name the build derived for a different page', () => {
    expect(isKnownEvent('/privacy', 'link:/chat', index)).toBe(false);
  });

  it('refuses a name no page carries, so a name cannot be minted by a caller', () => {
    expect(isKnownEvent('/welcome', 'attacker-minted', index)).toBe(false);
  });

  it('refuses every name for a page the index does not carry', () => {
    expect(isKnownEvent('/junk', 'link:/chat', index)).toBe(false);
  });

  it('matches a page whose only difference is a trailing slash', () => {
    expect(isKnownEvent('/welcome/', 'link:/chat', index)).toBe(true);
  });
});
