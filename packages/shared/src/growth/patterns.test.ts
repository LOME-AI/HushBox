import { describe, expect, it } from 'vitest';

import {
  campaignTagSchema,
  GROWTH_CAMPAIGN_TAG_PATTERN,
  GROWTH_DIRECT_CAMPAIGN,
  GROWTH_EVENT_NAME_MAX_LENGTH,
  GROWTH_EVENT_NAME_PATTERN,
  GROWTH_HOST_MAX_LENGTH,
  GROWTH_HOST_PATTERN,
  GROWTH_PATH_MAX_LENGTH,
  GROWTH_PATH_PATTERN,
  GROWTH_UNKNOWN_CAMPAIGN,
  isGrowthEventName,
} from './patterns.ts';

const pathRegex = new RegExp(GROWTH_PATH_PATTERN);
const hostRegex = new RegExp(GROWTH_HOST_PATTERN);
const eventRegex = new RegExp(GROWTH_EVENT_NAME_PATTERN);

/** A bracket body with every `X-Y` range removed, leaving only the characters it means literally. */
function literalsOf(bracketBody: string): string {
  return bracketBody.replaceAll(/[a-z0-9]-[a-z0-9]/g, '');
}

describe('the pattern sources', () => {
  it('are the exact strings the growth column checks interpolate', () => {
    expect(GROWTH_PATH_PATTERN).toBe('^/[a-z0-9/-]*$');
    expect(GROWTH_HOST_PATTERN).toBe('^[a-z0-9][a-z0-9.-]*$');
    expect(GROWTH_EVENT_NAME_PATTERN).toBe('^[a-z0-9][a-z0-9:/._-]*$');
    expect(GROWTH_CAMPAIGN_TAG_PATTERN).toBe('^[a-z0-9-]{1,40}$');
  });

  it('put a literal hyphen last in every bracket expression so POSIX reads it as a literal', () => {
    for (const pattern of [
      GROWTH_PATH_PATTERN,
      GROWTH_HOST_PATTERN,
      GROWTH_EVENT_NAME_PATTERN,
      GROWTH_CAMPAIGN_TAG_PATTERN,
    ]) {
      for (const bracketed of pattern.matchAll(/\[([^\]]*)\]/g)) {
        const body = bracketed[1] ?? '';
        if (literalsOf(body).includes('-')) expect(body.endsWith('-')).toBe(true);
      }
    }
  });

  it('carry no length bound, because the column checks and the schemas bound length separately', () => {
    for (const pattern of [GROWTH_PATH_PATTERN, GROWTH_HOST_PATTERN, GROWTH_EVENT_NAME_PATTERN]) {
      expect(pattern).not.toMatch(/\{/);
    }
  });
});

describe('GROWTH_PATH_PATTERN', () => {
  it.each([
    '/welcome',
    '/',
    '/blog/a-hyphenated-slug',
    '/newsletter/confirmed',
    '/other',
    '/welcome/',
  ])('accepts %s', (path) => {
    expect(pathRegex.test(path)).toBe(true);
  });

  it.each([
    ['a relative path with no leading slash', 'welcome'],
    ['an uppercase letter', '/Welcome'],
    ['a query string', '/welcome?c=x'],
    ['a fragment', '/welcome#demo'],
    ['a scheme', 'https://hushbox.ai/welcome'],
    ['an underscore', '/welcome_page'],
    ['a space', '/welcome page'],
  ])('rejects %s', (_reason, path) => {
    expect(pathRegex.test(path)).toBe(false);
  });

  it('bounds a path at 200 characters', () => {
    expect(GROWTH_PATH_MAX_LENGTH).toBe(200);
  });
});

describe('GROWTH_HOST_PATTERN', () => {
  it.each(['news.ycombinator.com', 'other', 'x.com', 'sub-domain.example.co.uk'])(
    'accepts %s',
    (host) => {
      expect(hostRegex.test(host)).toBe(true);
    }
  );

  it.each([
    ['a scheme separator', 'https://evil.example.com'],
    ['a bare scheme separator', '://evil.example.com'],
    ['a path', 'example.com/a'],
    ['an uppercase letter', 'Example.com'],
    ['a leading hyphen', '-example.com'],
    ['a leading dot', '.example.com'],
    ['the empty string', ''],
  ])('rejects %s', (_reason, host) => {
    expect(hostRegex.test(host)).toBe(false);
  });

  it('bounds a hostname at 253 characters', () => {
    expect(GROWTH_HOST_MAX_LENGTH).toBe(253);
  });
});

describe('GROWTH_EVENT_NAME_PATTERN', () => {
  it.each(['scroll-25', 'link:/welcome', 'link:example.com', 'hero_cta', 'start-chatting-free'])(
    'accepts %s',
    (name) => {
      expect(eventRegex.test(name)).toBe(true);
    }
  );

  it.each([
    ['an uppercase letter', 'Hero'],
    ['a space', 'hero cta'],
    ['a leading hyphen', '-hero'],
    ['a leading colon', ':hero'],
    ['the empty string', ''],
  ])('rejects %s', (_reason, name) => {
    expect(eventRegex.test(name)).toBe(false);
  });

  it('bounds an event name at 80 characters', () => {
    expect(GROWTH_EVENT_NAME_MAX_LENGTH).toBe(80);
  });
});

describe('isGrowthEventName', () => {
  it('accepts a name of exactly 80 characters', () => {
    expect(isGrowthEventName('a'.repeat(GROWTH_EVENT_NAME_MAX_LENGTH))).toBe(true);
  });

  it('rejects a name of 81 characters', () => {
    expect(isGrowthEventName('a'.repeat(GROWTH_EVENT_NAME_MAX_LENGTH + 1))).toBe(false);
  });

  it('rejects a name the pattern refuses', () => {
    expect(isGrowthEventName('Hero CTA')).toBe(false);
  });
});

describe('campaignTagSchema', () => {
  it.each(['podcast', 'launch-2026', 'a', 'direct', 'unknown', 'a'.repeat(40)])(
    'accepts %s',
    (tag) => {
      expect(campaignTagSchema.safeParse(tag).success).toBe(true);
    }
  );

  it.each([
    ['the empty string', ''],
    ['41 characters', 'a'.repeat(41)],
    ['an uppercase letter', 'Podcast'],
    ['an underscore', 'launch_2026'],
    ['a slash', 'launch/2026'],
  ])('rejects %s', (_reason, tag) => {
    expect(campaignTagSchema.safeParse(tag).success).toBe(false);
  });
});

describe('the seeded campaign tags', () => {
  it('are the exact tags the campaigns migration seeds', () => {
    expect(GROWTH_DIRECT_CAMPAIGN).toBe('direct');
    expect(GROWTH_UNKNOWN_CAMPAIGN).toBe('unknown');
  });
});
