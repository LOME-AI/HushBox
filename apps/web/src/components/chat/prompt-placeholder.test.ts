import { describe, it, expect } from 'vitest';
import { getPromptPlaceholder } from './prompt-placeholder';

describe('getPromptPlaceholder', () => {
  it('returns the image-specific placeholder for image modality', () => {
    expect(getPromptPlaceholder('image', 'fallback')).toBe('Describe the image you want...');
  });

  it('returns the video-specific placeholder for video modality', () => {
    expect(getPromptPlaceholder('video', 'fallback')).toBe('Describe the video you want...');
  });

  it('returns the audio-specific placeholder for audio modality', () => {
    expect(getPromptPlaceholder('audio', 'fallback')).toBe('Describe the audio you want...');
  });

  it('returns the caller-provided fallback for text modality', () => {
    expect(getPromptPlaceholder('text', 'caller fallback')).toBe('caller fallback');
  });
});
