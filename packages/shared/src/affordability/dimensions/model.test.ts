import { describe, expect, it } from 'vitest';

import { MODEL_DIMENSION } from './model.ts';

describe('MODEL_DIMENSION', () => {
  it('declares the model a per-token rate added to the turn', () => {
    expect(MODEL_DIMENSION.resource).toBe('moneyPerToken');
    expect(MODEL_DIMENSION.costClass).toBe('additive');
  });
});
