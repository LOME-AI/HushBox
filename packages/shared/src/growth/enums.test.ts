import { describe, expect, it } from 'vitest';

import {
  GROWTH_CAMPAIGN_STATUS,
  GROWTH_CHANNELS,
  GROWTH_DEVICE,
  GROWTH_FUNNEL_STEP,
  GROWTH_GRAIN,
  GROWTH_SCROLL_EVENTS,
  GROWTH_SELF_REPORT_CONTEXT,
  GrowthChannel,
  GrowthSelfReportContext,
} from './enums.ts';
import { isGrowthEventName } from './patterns.ts';

describe('the growth closed sets', () => {
  it.each([
    [
      'GROWTH_SCROLL_EVENTS',
      GROWTH_SCROLL_EVENTS,
      ['scroll-25', 'scroll-50', 'scroll-75', 'scroll-100'],
    ],
    ['GROWTH_DEVICE', GROWTH_DEVICE, ['desktop', 'mobile', 'tablet', 'other']],
    ['GROWTH_GRAIN', GROWTH_GRAIN, ['hour', 'day']],
    [
      'GROWTH_CHANNELS',
      GROWTH_CHANNELS,
      ['podcast', 'search', 'social', 'friend', 'ad', 'newsletter', 'article', 'other'],
    ],
    ['GROWTH_SELF_REPORT_CONTEXT', GROWTH_SELF_REPORT_CONTEXT, ['post_signup', 'first_payment']],
    ['GROWTH_FUNNEL_STEP', GROWTH_FUNNEL_STEP, ['started']],
    ['GROWTH_CAMPAIGN_STATUS', GROWTH_CAMPAIGN_STATUS, ['active', 'archived']],
  ])(
    '%s holds exactly its members, in the order the pgEnum is built from',
    (_name, actual, expected) => {
      expect([...actual]).toEqual(expected);
    }
  );
});

describe('GROWTH_SELF_REPORT_CONTEXT', () => {
  it('is ordered by when the prompt is shown, which is what the monotonic skip compares', () => {
    expect(GROWTH_SELF_REPORT_CONTEXT.indexOf('post_signup')).toBeLessThan(
      GROWTH_SELF_REPORT_CONTEXT.indexOf('first_payment')
    );
  });
});

describe('GROWTH_SCROLL_EVENTS', () => {
  it('holds names the event-name contract accepts, since the beacon validates them like any other', () => {
    for (const name of GROWTH_SCROLL_EVENTS) expect(isGrowthEventName(name)).toBe(true);
  });
});

describe('the growth enum schemas', () => {
  it('accepts a member', () => {
    expect(GrowthChannel.parse('podcast')).toBe('podcast');
    expect(GrowthSelfReportContext.parse('first_payment')).toBe('first_payment');
  });

  it('rejects a value outside the closed set', () => {
    expect(GrowthChannel.safeParse('tiktok').success).toBe(false);
    expect(GrowthSelfReportContext.safeParse('later').success).toBe(false);
  });
});
