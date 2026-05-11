import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useA11yStore } from '@hushbox/ui/accessibility/store';

import { installTtsDomObserver } from './tts-dom-observer';

// Mock the lazy-loaded TTS engine. vi.hoisted() runs before vi.mock factories,
// so the speakMock reference inside the factory is initialized before use.
// (Plain `const speakMock = vi.fn()` would be in TDZ when the hoisted factory
// runs because the factory may resolve mid-import-graph.)
const { speakMock } = vi.hoisted(() => ({
  speakMock: vi.fn<(text: string, voice: string) => Promise<void>>(),
}));
vi.mock('@hushbox/ui/accessibility/lib/tts-engine', () => ({
  getTtsService: () => ({
    isLoaded: () => true,
    speak: speakMock,
    stop: vi.fn(),
    load: vi.fn(),
    unlockAudio: vi.fn(),
  }),
  TTS_VOICES: [],
}));

// Reset store + mocks between tests so state doesn't leak.
beforeEach(async () => {
  speakMock.mockReset();
  speakMock.mockResolvedValue();
  useA11yStore.getState().reset();
  document.body.innerHTML = '';
  // Drain any pending speak promises from a prior test so they can't resolve
  // mid-assertion in the next test and falsely trip `not.toHaveBeenCalled()`.
  for (let index = 0; index < 5; index++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  speakMock.mockReset();
  speakMock.mockResolvedValue();
});

afterEach(() => {
  document.body.innerHTML = '';
});

function enableTts(): void {
  useA11yStore.getState().update({
    ttsEnabled: true,
    streamChatAloud: true,
    muteSounds: false,
    ttsVoice: 'af_heart',
  });
}

// MutationObserver fires async, and the speak path goes through `await import()`
// + `await getOrLoadTtsService()` + an inner `void (async () => ...)`. Vitest's
// dynamic-import resolver also takes a few extra ticks. Drain generously.
const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; index++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};

describe('installTtsDomObserver', () => {
  it('returns a cleanup function', () => {
    const cleanup = installTtsDomObserver();
    expect(typeof cleanup).toBe('function');
    cleanup();
  });

  it('does NOT speak when TTS is disabled', async () => {
    const cleanup = installTtsDomObserver();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    container.append(document.createTextNode('Hello world. This is a test.'));
    await flush();
    expect(speakMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('speaks completed sentences appended to a [data-tts-stream] container after install', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    await flush();
    container.append(document.createTextNode('Hello world. '));
    await flush();
    expect(speakMock).toHaveBeenCalledWith('Hello world.', 'af_heart');
    cleanup();
  });

  it('handles a container that exists BEFORE installation (initial scan)', async () => {
    enableTts();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    const cleanup = installTtsDomObserver();
    container.append(document.createTextNode('First sentence. '));
    await flush();
    expect(speakMock).toHaveBeenCalledWith('First sentence.', 'af_heart');
    cleanup();
  });

  it('chunks streamed text — incremental appends only emit on sentence boundary', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    await flush();
    container.append(document.createTextNode('Hello'));
    await flush();
    container.append(document.createTextNode(' world'));
    await flush();
    expect(speakMock).not.toHaveBeenCalled();
    container.append(document.createTextNode('. Done.'));
    await flush();
    expect(speakMock).toHaveBeenCalledWith('Hello world.', 'af_heart');
    expect(speakMock).toHaveBeenCalledWith('Done.', 'af_heart');
    cleanup();
  });

  it('handles multiple [data-tts-stream] containers independently', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    const a = document.createElement('div');
    a.dataset['ttsStream'] = '';
    const b = document.createElement('div');
    b.dataset['ttsStream'] = '';
    document.body.append(a, b);
    await flush();
    a.append(document.createTextNode('From A. '));
    b.append(document.createTextNode('From B. '));
    await flush();
    expect(speakMock).toHaveBeenCalledWith('From A.', 'af_heart');
    expect(speakMock).toHaveBeenCalledWith('From B.', 'af_heart');
    cleanup();
  });

  it('cleans up tracked containers when they are removed from the DOM', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    try {
      const container = document.createElement('div');
      container.dataset['ttsStream'] = '';
      document.body.append(container);
      await flush();
      container.append(document.createTextNode('First. '));
      await flush();
      expect(speakMock).toHaveBeenCalledTimes(1);

      container.remove();
      await flush();
      speakMock.mockClear();
      // After removal, no sentences emit even if the (detached) node gets text.
      container.append(document.createTextNode('Second. '));
      await flush();
      expect(speakMock).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('respects a runtime store flip — disabling streamChatAloud silences subsequent sentences', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    await flush();
    container.append(document.createTextNode('First. '));
    await flush();
    expect(speakMock).toHaveBeenCalledTimes(1);

    useA11yStore.getState().update({ streamChatAloud: false });
    container.append(document.createTextNode('Second. '));
    await flush();
    // Second sentence is buffered but not spoken because the gate flipped off.
    expect(speakMock).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('cleanup() disconnects the observer — newly added containers are not tracked', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    cleanup();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    await flush();
    container.append(document.createTextNode('Should not speak. '));
    await flush();
    expect(speakMock).not.toHaveBeenCalled();
  });
});
