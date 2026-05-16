import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('./lib/tts-engine', () => ({
  TTS_VOICES: [{ id: 'af_heart', displayName: 'Heart', accent: 'American', gender: 'female' }],
  getTtsService: () => ({
    load: vi.fn(),
    isLoaded: vi.fn().mockReturnValue(false),
    preloadVoice: vi.fn(),
    speak: vi.fn(),
    stop: vi.fn(),
    unlockAudio: vi.fn(),
  }),
}));

vi.mock('./lib/font-loader', () => ({
  activateFont: vi.fn().mockResolvedValue(true),
}));

import { AccessibilityPanel } from './accessibility-panel';

describe('AccessibilityPanel', () => {
  it('renders every section heading', () => {
    render(<AccessibilityPanel />);
    expect(screen.getByText('Quick starts')).not.toBeNull();
    expect(screen.getByText('Visual')).not.toBeNull();
    expect(screen.getByText('Text')).not.toBeNull();
    expect(screen.getByText('Reading helpers')).not.toBeNull();
    expect(screen.getByText('Sound')).not.toBeNull();
    expect(screen.getByText('Motion')).not.toBeNull();
    expect(screen.getByRole('heading', { name: /Pointer/ })).not.toBeNull();
  });

  it('renders the reset-to-defaults button', () => {
    render(<AccessibilityPanel />);
    expect(screen.getByRole('button', { name: /Reset all to defaults/ })).not.toBeNull();
  });
});
