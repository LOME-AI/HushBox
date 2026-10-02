import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { speakMock, isLoadedMock, stopMock, ttsEngineMockFactory } = vi.hoisted(() => {
  const speak = vi.fn((_text: string, _voice: string, onAudioStart?: () => void): Promise<void> => {
    onAudioStart?.();
    return Promise.resolve();
  });
  const isLoaded = vi.fn(() => true);
  const stop = vi.fn();
  return {
    speakMock: speak,
    isLoadedMock: isLoaded,
    stopMock: stop,
    // One factory, used by the hoisted mock below and by every restore of it,
    // so a restore cannot drift into a differently-shaped engine.
    ttsEngineMockFactory: () => ({
      getTtsService: () => ({
        load: vi.fn((): Promise<void> => Promise.resolve()),
        isLoaded,
        preloadVoice: vi.fn((): Promise<void> => Promise.resolve()),
        speak,
        stop,
        unlockAudio: vi.fn(),
      }),
    }),
  };
});

// Override the TTS singleton so we can inspect speak() without exercising audio.
// This is also what keeps kokoro-js (and transformers.js / espeak-ng) out of the
// run: the subject reaches the engine only through this module.
vi.mock('@hushbox/ui/accessibility/lib/tts-engine', ttsEngineMockFactory);

import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '@hushbox/shared';
import { expectExposes } from '@hushbox/shared/test-assertions';
import { useA11yStore, useTtsPlaybackStore } from '@hushbox/ui/accessibility/store';
import { startChatTtsStream, stopTtsForMessage } from './chat-tts-stream';

describe('startChatTtsStream', () => {
  beforeEach(() => {
    speakMock.mockReset();
    speakMock.mockImplementation(
      (_text: string, _voice: string, onAudioStart?: () => void): Promise<void> => {
        onAudioStart?.();
        return Promise.resolve();
      }
    );
    isLoadedMock.mockReset();
    isLoadedMock.mockReturnValue(true);
    stopMock.mockReset();
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
    useTtsPlaybackStore.setState({
      speakingStreamId: null,
      stoppedStreamIds: new Set<string>(),
      audioStartedStreamIds: new Set<string>(),
    });
  });

  afterEach(() => {
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
    useTtsPlaybackStore.setState({
      speakingStreamId: null,
      stoppedStreamIds: new Set<string>(),
      audioStartedStreamIds: new Set<string>(),
    });
  });

  it('returns null when ttsEnabled is false', async () => {
    useA11yStore.setState({ ttsEnabled: false, streamChatAloud: true });
    expect(await startChatTtsStream({ messageId: () => 'm1' })).toBeNull();
  });

  it('returns null when streamChatAloud is false', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: false });
    expect(await startChatTtsStream({ messageId: () => 'm1' })).toBeNull();
  });

  it('returns null when muteSounds is true (audio is muted)', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true, muteSounds: true });
    expect(await startChatTtsStream({ messageId: () => 'm1' })).toBeNull();
  });

  it('returns a feeder when ttsEnabled and streamChatAloud are both true', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
    const feeder = await startChatTtsStream({ messageId: () => 'm1' });
    expect(feeder).not.toBeNull();
    expectExposes(feeder ?? {}, 'feed', 'end');
  });

  it('routes streamed sentences to TTS speak with current voice', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true, ttsVoice: 'bm_george' });
    const feeder = await startChatTtsStream({ messageId: () => 'm1' });
    feeder?.feed('Hello world. ');
    expect(speakMock).toHaveBeenCalledWith('Hello world.', 'bm_george', expect.any(Function));
  });

  it('end() flushes the buffer and speaks the trailing remainder', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true, ttsVoice: 'af_heart' });
    const feeder = await startChatTtsStream({ messageId: () => 'm1' });
    feeder?.feed('No boundary here');
    feeder?.end();
    expect(speakMock).toHaveBeenCalledWith('No boundary here', 'af_heart', expect.any(Function));
  });

  it('reads voice on each speak so toggles mid-stream are honored', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true, ttsVoice: 'af_heart' });
    const feeder = await startChatTtsStream({ messageId: () => 'm1' });
    feeder?.feed('First. ');
    useA11yStore.setState({ ttsVoice: 'bf_emma' });
    feeder?.feed('Second. ');
    expect(speakMock).toHaveBeenNthCalledWith(1, 'First.', 'af_heart', expect.any(Function));
    expect(speakMock).toHaveBeenNthCalledWith(2, 'Second.', 'bf_emma', expect.any(Function));
  });

  it('does not speak when the user disables streamChatAloud mid-stream', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
    const feeder = await startChatTtsStream({ messageId: () => 'm1' });
    feeder?.feed('First. ');
    expect(speakMock).toHaveBeenCalledTimes(1);
    useA11yStore.setState({ streamChatAloud: false });
    feeder?.feed('Second. ');
    expect(speakMock).toHaveBeenCalledTimes(1);
  });

  it('does not speak when mute is toggled on mid-stream', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true, muteSounds: false });
    const feeder = await startChatTtsStream({ messageId: () => 'm1' });
    feeder?.feed('First. ');
    expect(speakMock).toHaveBeenCalledTimes(1);
    useA11yStore.setState({ muteSounds: true });
    feeder?.feed('Second. ');
    expect(speakMock).toHaveBeenCalledTimes(1);
  });

  it('does not speak when TTS engine is not yet loaded', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
    isLoadedMock.mockReturnValue(false);
    const feeder = await startChatTtsStream({ messageId: () => 'm1' });
    feeder?.feed('Hello. ');
    expect(speakMock).not.toHaveBeenCalled();
  });

  describe('playback store integration', () => {
    it('sets speakingStreamId on the first speak', async () => {
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      const feeder = await startChatTtsStream({ messageId: () => 'msg-1' });
      feeder?.feed('Hi. ');
      expect(useTtsPlaybackStore.getState().speakingStreamId).toBe('msg-1');
    });

    it('does not set speakingStreamId before any speak occurs', async () => {
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      await startChatTtsStream({ messageId: () => 'msg-1' });
      expect(useTtsPlaybackStore.getState().speakingStreamId).toBeNull();
    });

    it('clears speakingStreamId after end() once all speaks settle', async () => {
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      const feeder = await startChatTtsStream({ messageId: () => 'msg-1' });
      feeder?.feed('Hi. ');
      feeder?.end();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(useTtsPlaybackStore.getState().speakingStreamId).toBeNull();
    });

    it('does not clobber the slot if a newer stream took it before end()', async () => {
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      const feeder = await startChatTtsStream({ messageId: () => 'msg-1' });
      feeder?.feed('First. ');
      useTtsPlaybackStore.getState().setSpeakingStream('msg-2');
      feeder?.end();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(useTtsPlaybackStore.getState().speakingStreamId).toBe('msg-2');
    });

    it('is not muted (and speaks) while the message id is still null', async () => {
      // isStreamMuted short-circuits on the `id !== null` check when the id has
      // not arrived yet, so a not-yet-identified stream is never treated as
      // stopped and speech proceeds.
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      const feeder = await startChatTtsStream({ messageId: () => null });
      feeder?.feed('Anonymous sentence. ');
      expect(speakMock).toHaveBeenCalledWith(
        'Anonymous sentence.',
        expect.any(String),
        expect.any(Function)
      );
    });

    it('suppresses speech for a stream marked stopped via the playback store', async () => {
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      const feeder = await startChatTtsStream({ messageId: () => 'msg-1' });
      useTtsPlaybackStore.getState().markStreamStopped('msg-1');
      feeder?.feed('Should not be spoken. ');
      expect(speakMock).not.toHaveBeenCalled();
    });

    it('still speaks for a stream that was not stopped', async () => {
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      useTtsPlaybackStore.getState().markStreamStopped('other-msg');
      const feeder = await startChatTtsStream({ messageId: () => 'msg-1' });
      feeder?.feed('Hi. ');
      expect(speakMock).toHaveBeenCalledWith('Hi.', expect.any(String), expect.any(Function));
    });

    it('marks the message id in audioStartedStreamIds once audio actually starts', async () => {
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      const feeder = await startChatTtsStream({ messageId: () => 'msg-1' });
      feeder?.feed('Hi. ');
      expect(useTtsPlaybackStore.getState().audioStartedStreamIds.has('msg-1')).toBe(true);
    });

    it('does not mark audioStartedStreamIds before any speak occurs', async () => {
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      await startChatTtsStream({ messageId: () => 'msg-1' });
      expect(useTtsPlaybackStore.getState().audioStartedStreamIds.size).toBe(0);
    });

    it('does not mark audioStartedStreamIds when the message id is still null', async () => {
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      const feeder = await startChatTtsStream({ messageId: () => null });
      feeder?.feed('Anonymous sentence. ');
      expect(useTtsPlaybackStore.getState().audioStartedStreamIds.size).toBe(0);
    });
  });
});

const TTS_ENGINE_MODULE = '@hushbox/ui/accessibility/lib/tts-engine';

// A dynamic import of the engine chunk that rejects, which is what a failed chunk
// fetch looks like to the caller, and its restore. vi.doMock registers over an async
// round-trip and a dynamic import here waits on every registration still in flight, so
// two in flight at once take effect in the order they resolve, not the order they were
// called; each helper therefore imports the path before returning, which waits for the
// registration it just queued and leaves none in flight for the next call to race. The
// restore re-applies the mock rather than calling vi.doUnmock, which would leave the
// next import resolving to the real engine — the thing the hoisted mock keeps out.
async function failNextEngineImport(): Promise<void> {
  vi.doMock(TTS_ENGINE_MODULE, () => {
    throw new Error('Failed to fetch dynamically imported module');
  });
  await expect(import(TTS_ENGINE_MODULE)).rejects.toThrow();
}

async function restoreEngineImport(): Promise<void> {
  vi.doMock(TTS_ENGINE_MODULE, ttsEngineMockFactory);
  await import(TTS_ENGINE_MODULE);
}

describe('stopTtsForMessage', () => {
  beforeEach(() => {
    stopMock.mockReset();
    useTtsPlaybackStore.setState({
      speakingStreamId: null,
      stoppedStreamIds: new Set<string>(),
    });
  });

  it('adds the message id to stoppedStreamIds', () => {
    stopTtsForMessage('msg-1');
    expect(useTtsPlaybackStore.getState().stoppedStreamIds.has('msg-1')).toBe(true);
  });

  it('clears the speakingStreamId when it matches the stopped id', () => {
    useTtsPlaybackStore.getState().setSpeakingStream('msg-1');
    stopTtsForMessage('msg-1');
    expect(useTtsPlaybackStore.getState().speakingStreamId).toBeNull();
  });

  it('leaves a non-matching speakingStreamId alone', () => {
    useTtsPlaybackStore.getState().setSpeakingStream('msg-other');
    stopTtsForMessage('msg-1');
    expect(useTtsPlaybackStore.getState().speakingStreamId).toBe('msg-other');
  });

  it('calls the TTS service stop method to flush the audio queue', async () => {
    stopTtsForMessage('msg-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it('raises no unhandled rejection when the engine chunk fails to load', async () => {
    await failNextEngineImport();
    const rejections: unknown[] = [];
    const record = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', record);

    try {
      stopTtsForMessage('msg-1');
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', record);
      await restoreEngineImport();
    }

    expect(stopMock).not.toHaveBeenCalled();
    expect(rejections).toEqual([]);
  });

  it('still suppresses playback when the engine chunk fails to load', async () => {
    await failNextEngineImport();

    try {
      stopTtsForMessage('msg-1');
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      await restoreEngineImport();
    }

    expect(useTtsPlaybackStore.getState().stoppedStreamIds.has('msg-1')).toBe(true);
  });

  it('leaves the engine mocked after a restore, so no later import reaches the real engine', async () => {
    await failNextEngineImport();
    await restoreEngineImport();

    const engine = await import(TTS_ENGINE_MODULE);

    expect(engine.getTtsService().stop).toBe(stopMock);
  });
});
