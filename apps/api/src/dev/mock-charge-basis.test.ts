import { describe, expect, it } from 'vitest';
import { MOCK_ECHO_AFFIXES, MOCK_GENERATION_COST_USD } from '../slices/models/index.js';
import { mockChargeBasis } from './mock-charge-basis.js';

describe('mockChargeBasis', () => {
  it('bills one mock generation at its declared cost carried through the markup seam', () => {
    // 0.000001 USD = 1000 nano-USD raw, +15% customer markup = 1150 nano-USD.
    // The literal is the alarm: a change to the mock's cost or to the markup
    // must be seen, because every E2E money derivation prices through it.
    expect(mockChargeBasis().generationChargeNanoUsd).toBe('1150');
    expect(MOCK_GENERATION_COST_USD).toBe(0.000_001);
  });

  it('serves the echo affixes the mock actually streams', () => {
    const basis = mockChargeBasis();
    expect(basis.echoPrefix).toBe(MOCK_ECHO_AFFIXES.prefix);
    expect(basis.echoSuffix).toBe(MOCK_ECHO_AFFIXES.suffix);
  });

  it('serves a canonical integer NanoUSD string, never a decimal', () => {
    expect(mockChargeBasis().generationChargeNanoUsd).toMatch(/^\d+$/);
  });
});
