import { describe, expect, it } from 'vitest';
import { promptUtf8Bytes } from '@hushbox/shared';
import { inputTokensOf } from '@hushbox/shared/affordability';
import { perImagePricingFixture, tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { callMaxPrice, maxPriceReachesAnchor } from './call-routing.js';

/**
 * Claude Sonnet 4.5's anchor: 3,450 / 17,250 billable at base and 6,900 /
 * 25,875 above 200,000 prompt tokens, its own tier inside its own 1,000,000
 * context, with no larger-context segment.
 */
const SONNET_45 = tokenPricingFixture({
  input: 3450n,
  output: 17_250n,
  anchorContextTokens: 1_000_000,
  tiers: [{ abovePromptTokens: 200_000, input: 6900n, output: 25_875n }],
});

/**
 * The recorded `openai/gpt-5.4` shape: a $0.20 / $1.25 anchor with 400,000
 * tokens of context, and above it the 1,050,000-context segment's $2.50 / $15
 * endpoint at its 2× / 1.5× tier (it applies above 272,000), baked billable.
 */
const GPT_54 = tokenPricingFixture({
  input: 230n,
  output: 1438n,
  anchorContextTokens: 400_000,
  tiers: [{ abovePromptTokens: 400_000, input: 5750n, output: 25_875n }],
});

/** The anchor's base ceiling, 288 / 1,798, un-baked. */
const GPT_54_ANCHOR_CAP = { prompt: '0.250434', completion: '1.563478' };

/** The segment's ceiling, 7,188 / 32,344, un-baked. */
const GPT_54_SEGMENT_CAP = { prompt: '6.250434', completion: '28.125217' };

function asciiPrompt(bytes: number): number {
  return promptUtf8Bytes([{ content: 'a'.repeat(bytes) }]);
}

/** 133,333 three-byte CJK characters and two ASCII ones: 400,001 UTF-8 bytes in 133,335 characters. */
const CJK_PROMPT = `${'漢'.repeat(133_333)}ab`;

describe('callMaxPrice', () => {
  it('caps a 10-byte Sonnet 4.5 call at its own tier’s ceiling', () => {
    expect(callMaxPrice(SONNET_45, asciiPrompt(10))).toEqual({
      prompt: '7.500000',
      completion: '28.125217',
    });
  });

  it('caps a 900,000-byte Sonnet 4.5 call at the same own-tier ceiling', () => {
    expect(callMaxPrice(SONNET_45, asciiPrompt(900_000))).toEqual({
      prompt: '7.500000',
      completion: '28.125217',
    });
  });

  it('caps a 1,000-byte GPT-5.4 call at the anchor’s own ceiling, leaving the segment out', () => {
    expect(callMaxPrice(GPT_54, asciiPrompt(1000))).toEqual(GPT_54_ANCHOR_CAP);
  });

  it('caps a GPT-5.4 call bounded at exactly the anchor’s context at the anchor’s own ceiling', () => {
    expect(callMaxPrice(GPT_54, asciiPrompt(400_000))).toEqual(GPT_54_ANCHOR_CAP);
  });

  it('caps a 400,001-byte GPT-5.4 call at the segment’s ceiling', () => {
    expect(callMaxPrice(GPT_54, asciiPrompt(400_001))).toEqual(GPT_54_SEGMENT_CAP);
  });

  it('caps a 400,001-byte CJK call at the segment’s ceiling, which its 3-characters estimate falls short of', () => {
    expect(inputTokensOf(CJK_PROMPT.length)).toBeLessThan(400_000);
    expect(callMaxPrice(GPT_54, promptUtf8Bytes([{ content: CJK_PROMPT }]))).toEqual(
      GPT_54_SEGMENT_CAP
    );
  });

  it('refuses a media price, which no language call carries', () => {
    const image = perImagePricingFixture({ anchor: 40_000n, dearest: 90_000n });

    expect(() => callMaxPrice(image, 10)).toThrow(/token/);
  });
});

describe('maxPriceReachesAnchor', () => {
  it('admits a cap at exactly the anchor’s un-baked base rates', () => {
    expect(maxPriceReachesAnchor({ prompt: '3.000000', completion: '15.000000' }, SONNET_45)).toBe(
      true
    );
  });

  it('refuses a cap one micro-dollar below the anchor’s prompt rate', () => {
    expect(maxPriceReachesAnchor({ prompt: '2.999999', completion: '15.000000' }, SONNET_45)).toBe(
      false
    );
  });

  it('refuses a cap one micro-dollar below the anchor’s completion rate', () => {
    expect(maxPriceReachesAnchor({ prompt: '3.000000', completion: '14.999999' }, SONNET_45)).toBe(
      false
    );
  });

  it('admits the cap the call routing computes for the same price', () => {
    expect(maxPriceReachesAnchor(callMaxPrice(SONNET_45, 10), SONNET_45)).toBe(true);
  });

  it('admits any cap on a media price, which routes no max_price', () => {
    const image = perImagePricingFixture({ anchor: 40_000n, dearest: 90_000n });

    expect(maxPriceReachesAnchor({ prompt: '0.000000', completion: '0.000000' }, image)).toBe(true);
  });
});
