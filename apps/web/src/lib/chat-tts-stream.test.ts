import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock kokoro-js itself so the model loader (and transformers.js / espeak-ng)
// never run inside vitest. The chunker/feeder are real; only the audio
// engine is faked.
const { speakMock, isLoadedMock } = vi.hoisted(() => ({
  speakMock: vi.fn((): Promise<void> => Promise.resolve()),
  isLoadedMock: vi.fn(() => true),
}));

vi.mock('kokoro-js', () => ({
  KokoroTTS: {
    from_pretrained: vi.fn(() =>
      Promise.resolve({
        generate: vi.fn(() =>
          Promise.resolve({
            audio: new Float32Array(0),
            sampling_rate: 24_000,
          })
        ),
      })
    ),
  },
}));

// Override the TTS singleton so we can inspect speak() without exercising audio.
vi.mock('@hushbox/ui/accessibility/lib/tts-engine', () => ({
  getTtsService: () => ({
    load: vi.fn((): Promise<void> => Promise.resolve()),
    isLoaded: isLoadedMock,
    preloadVoice: vi.fn((): Promise<void> => Promise.resolve()),
    speak: speakMock,
    stop: vi.fn(),
    unlockAudio: vi.fn(),
  }),
}));

import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '@hushbox/shared';
import { useA11yStore } from '@hushbox/ui/accessibility/store';
import { startChatTtsStream } from './chat-tts-stream';

describe('startChatTtsStream', () => {
  beforeEach(() => {
    speakMock.mockReset();
    speakMock.mockImplementation((): Promise<void> => Promise.resolve());
    isLoadedMock.mockReset();
    isLoadedMock.mockReturnValue(true);
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
  });

  afterEach(() => {
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
  });

  it('returns null when ttsEnabled is false', async () => {
    useA11yStore.setState({ ttsEnabled: false, streamChatAloud: true });
    expect(await startChatTtsStream()).toBeNull();
  });

  it('returns null when streamChatAloud is false', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: false });
    expect(await startChatTtsStream()).toBeNull();
  });

  it('returns null when muteSounds is true (audio is muted)', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true, muteSounds: true });
    expect(await startChatTtsStream()).toBeNull();
  });

  it('returns a feeder when ttsEnabled and streamChatAloud are both true', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
    const feeder = await startChatTtsStream();
    expect(feeder).not.toBeNull();
    expect(typeof feeder?.feed).toBe('function');
    expect(typeof feeder?.end).toBe('function');
  });

  it('routes streamed sentences to TTS speak with current voice', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true, ttsVoice: 'bm_george' });
    const feeder = await startChatTtsStream();
    feeder?.feed('Hello world. ');
    expect(speakMock).toHaveBeenCalledWith('Hello world.', 'bm_george');
  });

  it('end() flushes the buffer and speaks the trailing remainder', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true, ttsVoice: 'af_heart' });
    const feeder = await startChatTtsStream();
    feeder?.feed('No boundary here');
    feeder?.end();
    expect(speakMock).toHaveBeenCalledWith('No boundary here', 'af_heart');
  });

  it('reads voice on each speak so toggles mid-stream are honored', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true, ttsVoice: 'af_heart' });
    const feeder = await startChatTtsStream();
    feeder?.feed('First. ');
    useA11yStore.setState({ ttsVoice: 'bf_emma' });
    feeder?.feed('Second. ');
    expect(speakMock).toHaveBeenNthCalledWith(1, 'First.', 'af_heart');
    expect(speakMock).toHaveBeenNthCalledWith(2, 'Second.', 'bf_emma');
  });

  it('does not speak when the user disables streamChatAloud mid-stream', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
    const feeder = await startChatTtsStream();
    feeder?.feed('First. ');
    expect(speakMock).toHaveBeenCalledTimes(1);
    useA11yStore.setState({ streamChatAloud: false });
    feeder?.feed('Second. ');
    expect(speakMock).toHaveBeenCalledTimes(1);
  });

  it('does not speak when mute is toggled on mid-stream', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true, muteSounds: false });
    const feeder = await startChatTtsStream();
    feeder?.feed('First. ');
    expect(speakMock).toHaveBeenCalledTimes(1);
    useA11yStore.setState({ muteSounds: true });
    feeder?.feed('Second. ');
    expect(speakMock).toHaveBeenCalledTimes(1);
  });

  it('does not speak when TTS engine is not yet loaded', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
    isLoadedMock.mockReturnValue(false);
    const feeder = await startChatTtsStream();
    feeder?.feed('Hello. ');
    expect(speakMock).not.toHaveBeenCalled();
  });
});
