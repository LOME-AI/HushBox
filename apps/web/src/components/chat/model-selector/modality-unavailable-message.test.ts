import { describe, it, expect } from 'vitest';
import { modalityUnavailableMessage } from '@/components/chat/model-selector/modality-unavailable-message';
import type { ChatModality } from '@hushbox/shared';

const EVERY_MODALITY = [
  'text',
  'image',
  'audio',
  'video',
] as const satisfies readonly ChatModality[];

describe('modalityUnavailableMessage', () => {
  it('states the approved sentence with the modality named', () => {
    expect(modalityUnavailableMessage('video')).toBe(
      'No video model supports zero data retention at this time, or we are experiencing intermittent issues. To protect your privacy, this feature is temporarily unavailable. Please check back later.'
    );
  });

  it('reads grammatically for every modality', () => {
    for (const modality of EVERY_MODALITY) {
      expect(modalityUnavailableMessage(modality)).toContain(`No ${modality} model supports`);
    }
  });
});
