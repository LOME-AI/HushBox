import { describe, expect, it } from 'vitest';

import { toolCallBillableNano } from './tool-pricing.ts';

describe('toolCallBillableNano', () => {
  it('bakes the web-search per-call price to exactly 5,750,000 nano, fee included', () => {
    expect(toolCallBillableNano('webSearch')).toBe(5_750_000n);
  });
});
