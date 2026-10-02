import { describe, expect, it } from 'vitest';

import {
  ACQUISITION_PLATFORMS,
  acquisitionSchema,
  acquisitionSourceViewSchema,
  selfReportActionSchema,
} from './acquisition.ts';

describe('ACQUISITION_PLATFORMS', () => {
  it('holds the device_platform members, in the order that pgEnum declares them', () => {
    expect([...ACQUISITION_PLATFORMS]).toEqual(['ios', 'android', 'web']);
  });
});

describe('acquisitionSchema', () => {
  it('accepts a signup that names its campaign', () => {
    expect(acquisitionSchema.parse({ campaign: 'launch-2026', platform: 'web' })).toEqual({
      campaign: 'launch-2026',
      platform: 'web',
    });
  });

  it('accepts a signup with no campaign, which the writer records as direct', () => {
    expect(acquisitionSchema.safeParse({ platform: 'ios' }).success).toBe(true);
  });

  it.each([
    ['a missing platform', { campaign: 'launch-2026' }],
    ['a platform outside the device set', { platform: 'windows' }],
    ['a build variant the column does not carry', { platform: 'android-direct' }],
    ['a malformed campaign tag', { campaign: 'Launch 2026', platform: 'web' }],
  ])('rejects %s', (_reason, body) => {
    expect(acquisitionSchema.safeParse(body).success).toBe(false);
  });
});

describe('selfReportActionSchema', () => {
  it('accepts an answer naming a channel and the context it was asked in', () => {
    expect(
      selfReportActionSchema.safeParse({
        action: 'answer',
        channel: 'podcast',
        context: 'post_signup',
      }).success
    ).toBe(true);
  });

  it('accepts a skip naming only the context', () => {
    expect(
      selfReportActionSchema.safeParse({ action: 'skip', context: 'first_payment' }).success
    ).toBe(true);
  });

  it.each([
    ['an answer with no channel', { action: 'answer', context: 'post_signup' }],
    [
      'an answer with a channel outside the closed set',
      { action: 'answer', channel: 'tiktok', context: 'post_signup' },
    ],
    ['an answer with no context', { action: 'answer', channel: 'podcast' }],
    ['a skip carrying a channel', { action: 'skip', channel: 'podcast', context: 'post_signup' }],
    [
      'an answer carrying a field the schema does not declare',
      { action: 'answer', channel: 'podcast', context: 'post_signup', note: 'a friend told me' },
    ],
    ['an unknown verb', { action: 'dismiss', context: 'post_signup' }],
    [
      'free text where a channel belongs',
      { action: 'answer', channel: 'a friend told me', context: 'post_signup' },
    ],
  ])('rejects %s', (_reason, body) => {
    expect(selfReportActionSchema.safeParse(body).success).toBe(false);
  });
});

describe('acquisitionSourceViewSchema', () => {
  it.each(['post_signup', 'first_payment'])('accepts %s as the prompt that is due', (duePrompt) => {
    expect(acquisitionSourceViewSchema.safeParse({ duePrompt }).success).toBe(true);
  });

  it('accepts null, which is how the server says no prompt is due', () => {
    expect(acquisitionSourceViewSchema.parse({ duePrompt: null })).toEqual({ duePrompt: null });
  });

  it('rejects a missing field, so a client cannot read absence as "not due"', () => {
    expect(acquisitionSourceViewSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a context outside the closed set', () => {
    expect(acquisitionSourceViewSchema.safeParse({ duePrompt: 'later' }).success).toBe(false);
  });
});
