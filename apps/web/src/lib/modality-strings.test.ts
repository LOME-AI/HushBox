import { describe, it, expect } from 'vitest';
import type { Modality } from '@hushbox/shared';
import {
  getPromptPlaceholder,
  getSendAriaLabel,
  getGeneratingLabel,
  getMediaLoadingLabel,
  getTaglineSubtitle,
  getInspirationLabel,
  getCostUnit,
  getTypingActivityLabel,
} from './modality-strings';

const noModality: Modality | undefined = undefined;

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

  it('returns the caller-provided fallback for undefined modality', () => {
    expect(getPromptPlaceholder(undefined, 'caller fallback')).toBe('caller fallback');
  });
});

describe('getSendAriaLabel', () => {
  it('returns "Send message" for text modality', () => {
    expect(getSendAriaLabel('text')).toBe('Send message');
  });

  it('returns "Send message" for undefined modality', () => {
    expect(getSendAriaLabel(noModality)).toBe('Send message');
  });

  it('returns "Generate image" for image modality', () => {
    expect(getSendAriaLabel('image')).toBe('Generate image');
  });

  it('returns "Generate video" for video modality', () => {
    expect(getSendAriaLabel('video')).toBe('Generate video');
  });

  it('returns "Generate audio" for audio modality', () => {
    expect(getSendAriaLabel('audio')).toBe('Generate audio');
  });
});

describe('getGeneratingLabel', () => {
  it('returns typing label for text modality', () => {
    expect(getGeneratingLabel('text', 'GPT-4')).toBe('GPT-4 is typing...');
  });

  it('returns typing label for undefined modality', () => {
    expect(getGeneratingLabel(undefined, 'GPT-4')).toBe('GPT-4 is typing...');
  });

  it('returns image generation label for image modality', () => {
    expect(getGeneratingLabel('image', 'DALL-E')).toBe('DALL-E is generating an image...');
  });

  it('returns video generation label for video modality', () => {
    expect(getGeneratingLabel('video', 'Sora')).toBe('Sora is generating a video...');
  });

  it('returns audio generation label for audio modality', () => {
    expect(getGeneratingLabel('audio', 'ElevenLabs')).toBe('ElevenLabs is generating audio...');
  });
});

describe('getMediaLoadingLabel', () => {
  it('returns image loading label for image modality', () => {
    expect(getMediaLoadingLabel('image')).toBe('Generating image...');
  });

  it('returns video loading label for video modality', () => {
    expect(getMediaLoadingLabel('video')).toBe('Generating video...');
  });

  it('returns audio loading label for audio modality', () => {
    expect(getMediaLoadingLabel('audio')).toBe('Generating audio...');
  });

  it('returns generic loading label for text modality', () => {
    expect(getMediaLoadingLabel('text')).toBe('Loading...');
  });

  it('returns generic loading label for undefined modality', () => {
    expect(getMediaLoadingLabel(noModality)).toBe('Loading...');
  });
});

describe('getTaglineSubtitle', () => {
  it('returns caller fallback for text modality', () => {
    expect(getTaglineSubtitle('text', 'Good morning')).toBe('Good morning');
  });

  it('returns caller fallback for undefined modality', () => {
    expect(getTaglineSubtitle(undefined, 'Good morning')).toBe('Good morning');
  });

  it('returns image tagline for image modality', () => {
    expect(getTaglineSubtitle('image', 'fallback')).toBe('What should we create?');
  });

  it('returns video tagline for video modality', () => {
    expect(getTaglineSubtitle('video', 'fallback')).toBe('What scene should we make?');
  });

  it('returns audio tagline for audio modality', () => {
    expect(getTaglineSubtitle('audio', 'fallback')).toBe('What should we listen to?');
  });
});

describe('getInspirationLabel', () => {
  it('returns generic inspiration label for text modality', () => {
    expect(getInspirationLabel('text')).toBe('Need inspiration? Try these:');
  });

  it('returns generic inspiration label for undefined modality', () => {
    expect(getInspirationLabel(noModality)).toBe('Need inspiration? Try these:');
  });

  it('returns generic inspiration label for image modality', () => {
    expect(getInspirationLabel('image')).toBe('Need inspiration? Try these:');
  });

  it('returns generic inspiration label for video modality', () => {
    expect(getInspirationLabel('video')).toBe('Need inspiration? Try these:');
  });

  it('returns generic inspiration label for audio modality', () => {
    expect(getInspirationLabel('audio')).toBe('Need inspiration? Try these:');
  });
});

describe('getCostUnit', () => {
  it('returns "$/1M tokens" for text modality', () => {
    expect(getCostUnit('text')).toBe('$/1M tokens');
  });

  it('returns "$/1M tokens" for undefined modality (text default)', () => {
    expect(getCostUnit(noModality)).toBe('$/1M tokens');
  });

  it('returns "$/image" for image modality', () => {
    expect(getCostUnit('image')).toBe('$/image');
  });

  it('returns "$/second" for video modality', () => {
    expect(getCostUnit('video')).toBe('$/second');
  });

  it('returns "$/second" for audio modality', () => {
    expect(getCostUnit('audio')).toBe('$/second');
  });
});

describe('getTypingActivityLabel', () => {
  describe('singular subject', () => {
    it('returns "X is typing..." for text modality', () => {
      expect(getTypingActivityLabel('text', 'Alice', false)).toBe('Alice is typing...');
    });

    it('returns "X is typing..." for undefined modality', () => {
      expect(getTypingActivityLabel(undefined, 'Alice', false)).toBe('Alice is typing...');
    });

    it('returns "X is generating an image..." for image modality', () => {
      expect(getTypingActivityLabel('image', 'Alice', false)).toBe(
        'Alice is generating an image...'
      );
    });

    it('returns "X is generating a video..." for video modality', () => {
      expect(getTypingActivityLabel('video', 'Alice', false)).toBe(
        'Alice is generating a video...'
      );
    });

    it('returns "X is generating audio..." for audio modality', () => {
      expect(getTypingActivityLabel('audio', 'Alice', false)).toBe('Alice is generating audio...');
    });
  });

  describe('plural subject', () => {
    it('returns "X are typing..." for text modality', () => {
      expect(getTypingActivityLabel('text', 'Alice and Bob', true)).toBe(
        'Alice and Bob are typing...'
      );
    });

    it('returns "X are generating images..." for image modality', () => {
      expect(getTypingActivityLabel('image', 'Alice and Bob', true)).toBe(
        'Alice and Bob are generating images...'
      );
    });

    it('returns "X are generating videos..." for video modality', () => {
      expect(getTypingActivityLabel('video', 'Alice and Bob', true)).toBe(
        'Alice and Bob are generating videos...'
      );
    });

    it('returns "X are generating audio..." for audio modality (no plural noun)', () => {
      expect(getTypingActivityLabel('audio', 'Alice and Bob', true)).toBe(
        'Alice and Bob are generating audio...'
      );
    });

    it('handles count-based plural subject', () => {
      expect(getTypingActivityLabel('text', '3 people', true)).toBe('3 people are typing...');
    });
  });
});
