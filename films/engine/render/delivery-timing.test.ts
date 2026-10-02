import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME } from '../time/grid.js';

import { AAC_ENCODER_DELAY, LEAD_FRAMES, LEAD_SAMPLES, PAD_SAMPLES } from './delivery-timing.js';

describe('delivery timing', () => {
  it("names the bundled native aac encoder's priming delay", () => {
    expect(AAC_ENCODER_DELAY).toBe(1024);
  });

  it('leads the picture by the fewest whole frames that cover the priming', () => {
    expect(LEAD_FRAMES).toBe(2);
  });

  it('pads the master by what the lead covers beyond the priming', () => {
    expect(PAD_SAMPLES).toBe(576);
  });

  it('shifts every delivered sample by the lead in samples', () => {
    expect(LEAD_SAMPLES).toBe(LEAD_FRAMES * SAMPLES_PER_FRAME);
  });

  it('makes the priming and the pad fill the lead exactly', () => {
    expect(AAC_ENCODER_DELAY + PAD_SAMPLES).toBe(LEAD_SAMPLES);
  });

  it('keeps the pad under one frame of samples', () => {
    expect(PAD_SAMPLES).toBeLessThan(SAMPLES_PER_FRAME);
  });
});
