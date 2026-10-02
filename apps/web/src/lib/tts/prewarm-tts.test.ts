import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '@hushbox/shared';
import { useA11yStore } from '@hushbox/ui/accessibility/store';

// Hoisted mocks so the factory in vi.mock can reach the spy without TDZ issues.
const { loadMock } = vi.hoisted(() => ({
  loadMock: vi.fn((_voice: string): Promise<void> => Promise.resolve()),
}));

vi.mock('@hushbox/ui/accessibility/lib/tts-engine', () => ({
  getTtsService: () => ({
    load: loadMock,
    isLoaded: () => false,
    preloadVoice: vi.fn(),
    speak: vi.fn(),
    stop: vi.fn(),
    unlockAudio: vi.fn(),
  }),
}));

import { prewarmTtsIfEnabled } from './prewarm-tts';

describe('prewarmTtsIfEnabled', () => {
  beforeEach(() => {
    loadMock.mockReset();
    loadMock.mockImplementation(() => Promise.resolve());
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
  });

  it('does NOT call load() when ttsEnabled is false (no opt-in, no bandwidth)', async () => {
    useA11yStore.setState({ ttsEnabled: false, ttsVoice: 'af_heart' });
    await prewarmTtsIfEnabled();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('calls load() with the user-selected voice when ttsEnabled is true', async () => {
    useA11yStore.setState({ ttsEnabled: true, ttsVoice: 'am_michael' });
    await prewarmTtsIfEnabled();
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(loadMock).toHaveBeenCalledWith('am_michael');
  });

  it('swallows load() errors so a model-fetch failure does not crash app boot', async () => {
    useA11yStore.setState({ ttsEnabled: true, ttsVoice: 'af_heart' });
    loadMock.mockImplementationOnce(() => Promise.reject(new Error('network unreachable')));
    // Should not throw.
    await expect(prewarmTtsIfEnabled()).resolves.toBeUndefined();
  });
});
