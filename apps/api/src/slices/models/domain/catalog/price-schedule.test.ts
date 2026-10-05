import { describe, expect, it } from 'vitest';

import { zdrEndpointFixture } from './gateway-fixtures.js';
import { anchorScheduleOf, endpointBucketCounts, endpointsInBand } from './price-schedule.js';
import type { RawOverride, ZdrEndpoint } from './gateway-metadata.js';
import type { AnchorSchedule, CatalogLimits } from './price-schedule.js';

const LIMITS: CatalogLimits = {
  maxOutputTokens: undefined,
  contextLength: undefined,
  supportedParameters: ['max_tokens'],
};

function withOverrides(
  overrides: readonly RawOverride[],
  extra: Partial<ZdrEndpoint> = {}
): ZdrEndpoint {
  return zdrEndpointFixture({
    pricing: { prompt: '0.000001', completion: '0.000002' },
    overrides,
    ...extra,
  });
}

function kindOf(result: AnchorSchedule): string {
  return result.kind === 'excluded' ? result.reason : 'scheduled';
}

function scheduled(result: AnchorSchedule): Extract<AnchorSchedule, { kind: 'scheduled' }> {
  if (result.kind !== 'scheduled') throw new Error(`expected a schedule, got ${result.reason}`);
  return result;
}

describe('anchorScheduleOf (override conditions)', () => {
  it.each([
    [
      'a threshold that is not a positive whole count',
      [{ min_prompt_tokens: 0, prompt: '0.000002' }],
    ],
    ['a threshold that is fractional', [{ min_prompt_tokens: 1.5, prompt: '0.000002' }]],
    ['a rate that is not a decimal', [{ min_prompt_tokens: 1000, prompt: 'twice' }]],
    ['a weekday the vendor does not name', [{ utc_days: ['funday'], prompt: '0.000002' }]],
    ['weekdays that are not a list', [{ utc_days: 'monday', prompt: '0.000002' }]],
    ['a clock past the end of the day', [{ utc_start: 2500, utc_end: 0, prompt: '0.000002' }]],
    ['a clock with more than 59 minutes', [{ utc_start: 1260, utc_end: 0, prompt: '0.000002' }]],
    ['a window with only a start', [{ utc_start: 900, prompt: '0.000002' }]],
    [
      'windows that leave one weekday uncovered',
      [
        { utc_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], prompt: '0.000002' },
        { utc_days: ['saturday'], prompt: '0.000001' },
      ],
    ],
    [
      'windows with a gap inside the day',
      [
        { utc_start: 0, utc_end: 1000, prompt: '0.000002' },
        { utc_start: 1100, utc_end: 0, prompt: '0.000001' },
      ],
    ],
    [
      'tiered windows that do not tile',
      [{ min_prompt_tokens: 1000, utc_start: 0, utc_end: 1200, prompt: '0.000002' }],
    ],
  ])('cannot represent an override with %s', (_label, overrides) => {
    expect(kindOf(anchorScheduleOf([withOverrides(overrides)], LIMITS))).toBe(
      'unrepresentable-endpoint-price'
    );
  });

  it('folds weekday and weekend windows that tile the week into base, at the dearer rate', () => {
    const endpoint = withOverrides([
      { utc_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], prompt: '0.000003' },
      { utc_days: ['saturday', 'sunday'], prompt: '0.000001' },
    ]);
    expect(scheduled(anchorScheduleOf([endpoint], LIMITS)).schedule.base).toEqual({
      prompt: '0.000003',
      completion: '0.000002',
    });
  });

  it('folds an override that carries no condition into base', () => {
    const endpoint = withOverrides([{ completion: '0.000005' }]);
    expect(scheduled(anchorScheduleOf([endpoint], LIMITS)).schedule.base.completion).toBe(
      '0.000005'
    );
  });

  it('folds tiered windows that tile the day into their tier, at the dearer rate', () => {
    const endpoint = withOverrides([
      { min_prompt_tokens: 1000, utc_start: 0, utc_end: 1200, prompt: '0.000004' },
      { min_prompt_tokens: 1000, utc_start: 1200, utc_end: 0, prompt: '0.000003' },
    ]);
    expect(scheduled(anchorScheduleOf([endpoint], LIMITS)).schedule.tiers).toEqual([
      { abovePromptTokens: 1000, rates: { prompt: '0.000004', completion: '0.000002' } },
    ]);
  });
});

describe('anchorScheduleOf (limits and segments)', () => {
  it('keeps the gateway limits when no eligible endpoint states one', () => {
    const result = scheduled(
      anchorScheduleOf([withOverrides([])], {
        ...LIMITS,
        maxOutputTokens: 4096,
        contextLength: 32_768,
      })
    );
    expect([result.maxOutputTokens, result.contextLength]).toEqual([4096, 32_768]);
  });

  it('reads a gateway limit that is not a whole positive count as unstated', () => {
    const endpoint = withOverrides([], { maxCompletionTokens: 2048, contextLength: 8192 });
    const result = scheduled(
      anchorScheduleOf([endpoint], { ...LIMITS, maxOutputTokens: 0.5, contextLength: -1 })
    );
    expect([result.maxOutputTokens, result.contextLength]).toEqual([2048, 8192]);
  });

  it('prices prompts past the anchor context at an endpoint that states no context', () => {
    const anchor = zdrEndpointFixture({
      tag: 'anchor',
      contextLength: 100_000,
      pricing: { prompt: '0.000001', completion: '0.000002' },
    });
    const unbounded = zdrEndpointFixture({
      tag: 'unbounded',
      pricing: { prompt: '0.000004', completion: '0.000008' },
    });
    expect(scheduled(anchorScheduleOf([anchor, unbounded], LIMITS)).schedule.tiers).toEqual([
      { abovePromptTokens: 100_000, rates: { prompt: '0.000004', completion: '0.000008' } },
    ]);
  });

  it("carries a covering endpoint's own tier inside its segment", () => {
    const anchor = zdrEndpointFixture({
      tag: 'anchor',
      contextLength: 100_000,
      pricing: { prompt: '0.000001', completion: '0.000002' },
    });
    const covering = zdrEndpointFixture({
      tag: 'covering',
      contextLength: 400_000,
      pricing: { prompt: '0.000002', completion: '0.000004' },
      overrides: [{ min_prompt_tokens: 200_000, prompt: '0.000006' }],
    });
    expect(
      scheduled(anchorScheduleOf([anchor, covering], { ...LIMITS, contextLength: 400_000 }))
        .schedule.tiers
    ).toEqual([
      { abovePromptTokens: 100_000, rates: { prompt: '0.000002', completion: '0.000004' } },
      { abovePromptTokens: 200_000, rates: { prompt: '0.000006', completion: '0.000004' } },
    ]);
  });

  it("serves the largest prompt the anchor reaches at the smaller of its context and the model's", () => {
    const endpoint = withOverrides([], { contextLength: 300_000 });
    expect(
      scheduled(anchorScheduleOf([endpoint], { ...LIMITS, contextLength: 200_000 })).anchorReach
    ).toBe(200_000);
  });
});

describe('endpointsInBand', () => {
  const limits = { input: 1_000_000n, output: 2_000_000n };

  it('compares a rate finer than 10⁻¹² USD by its round-up, so a hair above the limit counts as above it', () => {
    expect(
      endpointsInBand([{ prompt: '0.0000010000000000001', completion: '0.000001' }], limits, {
        input: 3_000_000n,
        output: 3_000_000n,
      })
    ).toBe(1);
  });

  it('leaves out a rate exactly at the base limit', () => {
    expect(
      endpointsInBand([{ prompt: '0.000001', completion: '0.000002' }], limits, {
        input: 3_000_000n,
        output: 3_000_000n,
      })
    ).toBe(0);
  });
});

/** The parameters a tool-capable reasoning model's calls carry. */
const TOOL_MODEL: CatalogLimits = {
  maxOutputTokens: undefined,
  contextLength: undefined,
  supportedParameters: ['max_tokens', 'tools', 'reasoning'],
};

function endpointAt(
  tag: string,
  prompt: string,
  completion: string,
  extra: Partial<ZdrEndpoint> = {}
): ZdrEndpoint {
  return zdrEndpointFixture({ tag, pricing: { prompt, completion }, ...extra });
}

const TOOL_CAPABLE = endpointAt('capable', '0.000001', '0.000002');

describe('anchorScheduleOf (malformed endpoint limits)', () => {
  it('never anchors on an endpoint whose stated cap is unreadable, however cheap', () => {
    const malformed = endpointAt('malformed', '0.0000001', '0.0000002', {
      maxCompletionTokens: 'unreadable',
    });
    expect(
      scheduled(anchorScheduleOf([malformed, TOOL_CAPABLE], TOOL_MODEL)).schedule.base
    ).toEqual({ prompt: '0.000001', completion: '0.000002' });
  });

  it('never anchors on an endpoint whose stated context is unreadable, however cheap', () => {
    const malformed = endpointAt('malformed', '0.0000001', '0.0000002', {
      contextLength: 'unreadable',
    });
    expect(
      scheduled(anchorScheduleOf([malformed, TOOL_CAPABLE], TOOL_MODEL)).schedule.base
    ).toEqual({ prompt: '0.000001', completion: '0.000002' });
  });

  it('never widens the output cap with an endpoint whose stated cap is unreadable', () => {
    const malformed = endpointAt('malformed', '0.000002', '0.000004', {
      maxCompletionTokens: 'unreadable',
    });
    const capped = endpointAt('capped', '0.000001', '0.000002', { maxCompletionTokens: 1000 });
    expect(scheduled(anchorScheduleOf([malformed, capped], TOOL_MODEL)).maxOutputTokens).toBe(1000);
  });

  it('never widens the context with an endpoint whose stated context is unreadable', () => {
    const malformed = endpointAt('malformed', '0.000002', '0.000004', {
      contextLength: 'unreadable',
    });
    const bounded = endpointAt('bounded', '0.000001', '0.000002', { contextLength: 8192 });
    const result = scheduled(anchorScheduleOf([malformed, bounded], TOOL_MODEL));
    expect([result.contextLength, result.schedule.tiers]).toEqual([8192, []]);
  });

  it('still excludes the model when an endpoint with an unreadable cap lists an unrepresentable price', () => {
    const malformed = zdrEndpointFixture({
      tag: 'malformed',
      maxCompletionTokens: 'unreadable',
      pricing: { prompt: '0.000001', completion: '0.000002', request: '0.01' },
    });
    expect(kindOf(anchorScheduleOf([malformed, TOOL_CAPABLE], TOOL_MODEL))).toBe(
      'unrepresentable-endpoint-price'
    );
  });

  it('still counts an endpoint with an unreadable context in the max_price band', () => {
    const malformed = endpointAt('malformed', '0.0000015', '0.0000024', {
      contextLength: 'unreadable',
    });
    const anchor = endpointAt('anchor', '0.000001', '0.000002', {
      overrides: [{ min_prompt_tokens: 1000, prompt: '0.000002', completion: '0.000004' }],
    });
    // Base ceiling 1.25 / 2.5 USD a million; the tier's ceiling, 2.5 / 5, is max_price.
    expect(
      endpointsInBand(
        scheduled(anchorScheduleOf([malformed, anchor], TOOL_MODEL)).standardBases,
        { input: 1_250_000n, output: 2_500_000n },
        { input: 2_500_000n, output: 5_000_000n }
      )
    ).toBe(1);
  });
});

describe('anchorScheduleOf (an unbounded output cap)', () => {
  const capped = endpointAt('capped', '0.0000001', '0.0000004', { maxCompletionTokens: 4096 });
  const uncapped = endpointAt('uncapped', '0.0000005', '0.000002');

  it('anchors only on an endpoint stating no cap when no cap bounds the model', () => {
    expect(scheduled(anchorScheduleOf([capped, uncapped], TOOL_MODEL)).schedule.base).toEqual({
      prompt: '0.0000005',
      completion: '0.000002',
    });
  });

  it('anchors on an endpoint stating no cap when the model states one it cannot otherwise cover', () => {
    expect(
      scheduled(anchorScheduleOf([capped, uncapped], { ...TOOL_MODEL, maxOutputTokens: 16_384 }))
        .schedule.base
    ).toEqual({ prompt: '0.0000005', completion: '0.000002' });
  });

  it('anchors on a capped endpoint that covers the model cap when it is the cheapest', () => {
    expect(
      scheduled(anchorScheduleOf([capped, uncapped], { ...TOOL_MODEL, maxOutputTokens: 4096 }))
        .schedule.base
    ).toEqual({ prompt: '0.0000001', completion: '0.0000004' });
  });
});

describe('anchorScheduleOf (unreadable parameter lists)', () => {
  it('excludes the model when a standard-tier endpoint lists no readable parameters', () => {
    const unreadable = endpointAt('unreadable', '0.000001', '0.000002', {
      supportedParameters: 'unreadable',
    });
    expect(kindOf(anchorScheduleOf([unreadable, TOOL_CAPABLE], TOOL_MODEL))).toBe(
      'unrepresentable-endpoint-price'
    );
  });

  it('counts an unreadable parameter list as unreadable, not as a list missing a cap', () => {
    const unreadable = endpointAt('unreadable', '0.000001', '0.000002', {
      supportedParameters: 'unreadable',
    });
    expect(endpointBucketCounts([unreadable], TOOL_MODEL.supportedParameters)).toEqual({
      'service-tier': 0,
      'unsupported-parameter': 0,
      unreadable: 1,
      unrepresentable: 0,
      reachable: 0,
    });
  });

  it('ignores an unreadable parameter list on a flex endpoint', () => {
    const flex = endpointAt('vendor/flex', '0.000001', '0.000002', {
      supportedParameters: 'unreadable',
    });
    expect(kindOf(anchorScheduleOf([flex, TOOL_CAPABLE], TOOL_MODEL))).toBe('scheduled');
  });
});

describe('anchorScheduleOf (every standard-tier endpoint is price-checked)', () => {
  const TOOL_LESS = ['max_tokens', 'reasoning'];
  const REASONING_LESS = ['max_tokens', 'tools'];

  it('excludes the model when a tool-less endpoint lists a request fee', () => {
    const toolLess = zdrEndpointFixture({
      tag: 'tool-less',
      supportedParameters: TOOL_LESS,
      pricing: { prompt: '0.000001', completion: '0.000002', request: '0.01' },
    });
    expect(kindOf(anchorScheduleOf([TOOL_CAPABLE, toolLess], TOOL_MODEL))).toBe(
      'unrepresentable-endpoint-price'
    );
  });

  it('excludes the model when a reasoning-less endpoint lists reasoning dearer than completion', () => {
    const reasoningLess = zdrEndpointFixture({
      tag: 'reasoning-less',
      supportedParameters: REASONING_LESS,
      pricing: { prompt: '0.000001', completion: '0.000002', internal_reasoning: '0.000003' },
    });
    expect(kindOf(anchorScheduleOf([TOOL_CAPABLE, reasoningLess], TOOL_MODEL))).toBe(
      'unrepresentable-endpoint-price'
    );
  });

  it('excludes the model when a standard-tier endpoint accepts no output cap parameter', () => {
    const uncapped = endpointAt('uncapped', '0.000001', '0.000002', {
      supportedParameters: ['tools', 'reasoning'],
    });
    expect(kindOf(anchorScheduleOf([TOOL_CAPABLE, uncapped], TOOL_MODEL))).toBe(
      'unrepresentable-endpoint-price'
    );
  });

  it('accepts max_completion_tokens alone as an output cap parameter', () => {
    const completionCap = endpointAt('completion-cap', '0.000001', '0.000002', {
      supportedParameters: ['max_completion_tokens'],
    });
    expect(kindOf(anchorScheduleOf([TOOL_CAPABLE, completionCap], TOOL_MODEL))).toBe('scheduled');
  });

  it('counts a tool-less endpoint above the base ceiling toward the max_price band', () => {
    const anchor = endpointAt('anchor', '0.000003', '0.000015', {
      overrides: [{ min_prompt_tokens: 200_000, prompt: '0.000006', completion: '0.0000225' }],
    });
    const toolLess = endpointAt('tool-less', '0.0000039', '0.000016', {
      supportedParameters: TOOL_LESS,
    });
    const result = scheduled(anchorScheduleOf([anchor, toolLess], TOOL_MODEL));
    expect(
      endpointsInBand(
        result.standardBases,
        { input: 3_750_000n, output: 18_750_000n },
        { input: 7_500_000n, output: 28_125_000n }
      )
    ).toBe(1);
  });

  it('never anchors on a tool-less endpoint, however cheap', () => {
    const toolLess = endpointAt('tool-less', '0.0000005', '0.000001', {
      supportedParameters: TOOL_LESS,
    });
    expect(scheduled(anchorScheduleOf([TOOL_CAPABLE, toolLess], TOOL_MODEL)).schedule.base).toEqual(
      { prompt: '0.000001', completion: '0.000002' }
    );
  });

  it('never anchors on a reasoning-less endpoint, however cheap', () => {
    const reasoningLess = endpointAt('reasoning-less', '0.0000005', '0.000001', {
      supportedParameters: REASONING_LESS,
    });
    expect(
      scheduled(anchorScheduleOf([TOOL_CAPABLE, reasoningLess], TOOL_MODEL)).schedule.base
    ).toEqual({ prompt: '0.000001', completion: '0.000002' });
  });

  it('never widens the output cap with a tool-less endpoint', () => {
    const capable = endpointAt('capable', '0.000001', '0.000002', { maxCompletionTokens: 1000 });
    const toolLess = endpointAt('tool-less', '0.000001', '0.000002', {
      supportedParameters: TOOL_LESS,
      maxCompletionTokens: 64_000,
    });
    expect(scheduled(anchorScheduleOf([capable, toolLess], TOOL_MODEL)).maxOutputTokens).toBe(1000);
  });

  it('excludes the model as non-zdr when only tool-less endpoints remain', () => {
    const toolLess = endpointAt('tool-less', '0.000001', '0.000002', {
      supportedParameters: TOOL_LESS,
    });
    expect(kindOf(anchorScheduleOf([toolLess], TOOL_MODEL))).toBe('non-zdr');
  });
});
