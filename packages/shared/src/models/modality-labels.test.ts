import { describe, it, expect } from 'vitest';
import { MODALITY_ARIA_LABELS } from './modality-labels.js';

describe('MODALITY_ARIA_LABELS', () => {
  it('maps every modality to its composer switch-button aria-label', () => {
    expect(MODALITY_ARIA_LABELS).toEqual({
      text: 'Switch to text',
      image: 'Switch to image generation',
      video: 'Switch to video generation',
      audio: 'Switch to audio generation',
    });
  });
});
