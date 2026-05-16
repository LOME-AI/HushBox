import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTtsStreamFeeder } from './tts-stream-feeder';
import type { TtsService, TtsVoice } from './tts-engine';

function makeFakeTts(): { service: TtsService; spoken: { text: string; voice: TtsVoice }[] } {
  const spoken: { text: string; voice: TtsVoice }[] = [];
  const service: TtsService = {
    load: vi.fn(() => Promise.resolve()),
    isLoaded: vi.fn(() => true),
    preloadVoice: vi.fn(() => Promise.resolve()),
    speak: vi.fn((text: string, voice: TtsVoice) => {
      spoken.push({ text, voice });
      return Promise.resolve();
    }),
    stop: vi.fn(),
    unlockAudio: vi.fn(),
  };
  return { service, spoken };
}

describe('createTtsStreamFeeder', () => {
  let isEnabledFlag: boolean;

  beforeEach(() => {
    isEnabledFlag = true;
  });

  it('does not call speak when feeder is disabled', () => {
    const { service, spoken } = makeFakeTts();
    isEnabledFlag = false;
    const feeder = createTtsStreamFeeder({
      tts: service,
      voice: 'af_heart',
      isEnabled: () => isEnabledFlag,
    });
    feeder.feed('Hello world. ');
    expect(spoken).toEqual([]);
  });

  it('does not call speak when tts is not loaded', () => {
    const { service, spoken } = makeFakeTts();
    (service.isLoaded as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const feeder = createTtsStreamFeeder({
      tts: service,
      voice: 'af_heart',
      isEnabled: () => true,
    });
    feeder.feed('Hello world. ');
    expect(spoken).toEqual([]);
  });

  it('calls speak with each completed sentence using the configured voice', () => {
    const { service, spoken } = makeFakeTts();
    const feeder = createTtsStreamFeeder({
      tts: service,
      voice: 'bm_george',
      isEnabled: () => true,
    });
    feeder.feed('First. Second! ');
    expect(spoken).toEqual([
      { text: 'First.', voice: 'bm_george' },
      { text: 'Second!', voice: 'bm_george' },
    ]);
  });

  it('reads voice via callback so updates are picked up between feeds', () => {
    const { service, spoken } = makeFakeTts();
    let voice: TtsVoice = 'af_heart';
    const feeder = createTtsStreamFeeder({
      tts: service,
      voice: () => voice,
      isEnabled: () => true,
    });
    feeder.feed('First. ');
    voice = 'bf_emma';
    feeder.feed('Second. ');
    expect(spoken).toEqual([
      { text: 'First.', voice: 'af_heart' },
      { text: 'Second.', voice: 'bf_emma' },
    ]);
  });

  it('end() flushes the chunker remainder and speaks it', () => {
    const { service, spoken } = makeFakeTts();
    const feeder = createTtsStreamFeeder({
      tts: service,
      voice: 'af_heart',
      isEnabled: () => true,
    });
    feeder.feed('First. Trailing without boundary');
    feeder.end();
    expect(spoken.map((s) => s.text)).toEqual(['First.', 'Trailing without boundary']);
  });

  it('end() with empty buffer is a no-op', () => {
    const { service, spoken } = makeFakeTts();
    const feeder = createTtsStreamFeeder({
      tts: service,
      voice: 'af_heart',
      isEnabled: () => true,
    });
    feeder.end();
    expect(spoken).toEqual([]);
  });

  it('end() does not call speak when disabled', () => {
    const { service, spoken } = makeFakeTts();
    const feeder = createTtsStreamFeeder({
      tts: service,
      voice: 'af_heart',
      isEnabled: () => isEnabledFlag,
    });
    feeder.feed('No boundary');
    isEnabledFlag = false;
    feeder.end();
    expect(spoken).toEqual([]);
  });

  it('feed() swallows speak() rejections so a TTS failure does not break the stream', async () => {
    const { service } = makeFakeTts();
    (service.speak as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('audio failed'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const feeder = createTtsStreamFeeder({
      tts: service,
      voice: 'af_heart',
      isEnabled: () => true,
    });
    expect(() => {
      feeder.feed('boom. ');
    }).not.toThrow();
    // Allow rejection to settle without unhandled-rejection noise
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(consoleSpy).toHaveBeenCalledWith('TTS speak failed:', expect.any(Error));
    consoleSpy.mockRestore();
  });

  describe('isStreamMuted gate', () => {
    it('skips speak when isStreamMuted returns true', () => {
      const { service, spoken } = makeFakeTts();
      const feeder = createTtsStreamFeeder({
        tts: service,
        voice: 'af_heart',
        isEnabled: () => true,
        isStreamMuted: () => true,
      });
      feeder.feed('Hello. ');
      expect(spoken).toEqual([]);
    });

    it('skips speak on end() when isStreamMuted returns true', () => {
      const { service, spoken } = makeFakeTts();
      const feeder = createTtsStreamFeeder({
        tts: service,
        voice: 'af_heart',
        isEnabled: () => true,
        isStreamMuted: () => true,
      });
      feeder.feed('Trailing');
      feeder.end();
      expect(spoken).toEqual([]);
    });

    it('still advances the chunker so already-emitted sentences are not re-spoken later', () => {
      const { service, spoken } = makeFakeTts();
      let muted = false;
      const feeder = createTtsStreamFeeder({
        tts: service,
        voice: 'af_heart',
        isEnabled: () => true,
        isStreamMuted: () => muted,
      });
      muted = true;
      feeder.feed('First. ');
      muted = false;
      feeder.feed('Second. ');
      expect(spoken.map((s) => s.text)).toEqual(['Second.']);
    });

    it('treats omitted isStreamMuted as never-muted', () => {
      const { service, spoken } = makeFakeTts();
      const feeder = createTtsStreamFeeder({
        tts: service,
        voice: 'af_heart',
        isEnabled: () => true,
      });
      feeder.feed('Hi. ');
      expect(spoken).toEqual([{ text: 'Hi.', voice: 'af_heart' }]);
    });
  });

  describe('onStreamStart hook', () => {
    it('fires exactly once across multiple sentences', () => {
      const { service } = makeFakeTts();
      const onStreamStart = vi.fn();
      const feeder = createTtsStreamFeeder({
        tts: service,
        voice: 'af_heart',
        isEnabled: () => true,
        onStreamStart,
      });
      feeder.feed('First. Second. Third. ');
      expect(onStreamStart).toHaveBeenCalledTimes(1);
    });

    it('does not fire when nothing is ever spoken (disabled throughout)', () => {
      const { service } = makeFakeTts();
      const onStreamStart = vi.fn();
      const feeder = createTtsStreamFeeder({
        tts: service,
        voice: 'af_heart',
        isEnabled: () => false,
        onStreamStart,
      });
      feeder.feed('First. ');
      feeder.end();
      expect(onStreamStart).not.toHaveBeenCalled();
    });

    it('does not fire when tts is not loaded', () => {
      const { service } = makeFakeTts();
      (service.isLoaded as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const onStreamStart = vi.fn();
      const feeder = createTtsStreamFeeder({
        tts: service,
        voice: 'af_heart',
        isEnabled: () => true,
        onStreamStart,
      });
      feeder.feed('First. ');
      expect(onStreamStart).not.toHaveBeenCalled();
    });

    it('does not fire when isStreamMuted is true from the start', () => {
      const { service } = makeFakeTts();
      const onStreamStart = vi.fn();
      const feeder = createTtsStreamFeeder({
        tts: service,
        voice: 'af_heart',
        isEnabled: () => true,
        isStreamMuted: () => true,
        onStreamStart,
      });
      feeder.feed('First. Second. ');
      expect(onStreamStart).not.toHaveBeenCalled();
    });

    it('fires once when end() flushes a remainder and no prior sentence was spoken', () => {
      const { service } = makeFakeTts();
      const onStreamStart = vi.fn();
      const feeder = createTtsStreamFeeder({
        tts: service,
        voice: 'af_heart',
        isEnabled: () => true,
        onStreamStart,
      });
      feeder.feed('No boundary');
      feeder.end();
      expect(onStreamStart).toHaveBeenCalledTimes(1);
    });
  });

  describe('onStreamEnd hook', () => {
    it('fires after end() once all speak promises settle', async () => {
      const { service } = makeFakeTts();
      const onStreamEnd = vi.fn();
      const feeder = createTtsStreamFeeder({
        tts: service,
        voice: 'af_heart',
        isEnabled: () => true,
        onStreamEnd,
      });
      feeder.feed('First. ');
      feeder.end();
      expect(onStreamEnd).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onStreamEnd).toHaveBeenCalledTimes(1);
    });

    it('fires synchronously from end() when nothing was ever spoken', () => {
      const { service } = makeFakeTts();
      const onStreamEnd = vi.fn();
      const feeder = createTtsStreamFeeder({
        tts: service,
        voice: 'af_heart',
        isEnabled: () => false,
        onStreamEnd,
      });
      feeder.end();
      expect(onStreamEnd).toHaveBeenCalledTimes(1);
    });

    it('fires after end() even when a speak rejects', async () => {
      const { service } = makeFakeTts();
      (service.speak as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('audio failed'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onStreamEnd = vi.fn();
      const feeder = createTtsStreamFeeder({
        tts: service,
        voice: 'af_heart',
        isEnabled: () => true,
        onStreamEnd,
      });
      feeder.feed('boom. ');
      feeder.end();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onStreamEnd).toHaveBeenCalledTimes(1);
      consoleSpy.mockRestore();
    });

    it('does not fire before end() is called even after all speaks settle', async () => {
      const { service } = makeFakeTts();
      const onStreamEnd = vi.fn();
      const feeder = createTtsStreamFeeder({
        tts: service,
        voice: 'af_heart',
        isEnabled: () => true,
        onStreamEnd,
      });
      feeder.feed('First. ');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onStreamEnd).not.toHaveBeenCalled();
    });
  });
});
