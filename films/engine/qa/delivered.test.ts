import { describe, expect, it } from 'vitest';

import { LEAD_FRAMES } from '../render/delivery-timing.js';
import { filmFrame } from './delivered.js';

describe('filmFrame', () => {
  it('maps a delivered frame past the lead back to the film frame it shows', () => {
    expect(filmFrame(LEAD_FRAMES + 7)).toBe(7);
  });

  it('maps every copy of frame 0 in the lead to frame 0', () => {
    const lead = Array.from({ length: LEAD_FRAMES + 1 }, (_, delivered) => filmFrame(delivered));

    expect(lead.every((frame) => frame === 0)).toBe(true);
  });
});
