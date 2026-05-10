import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock kokoro-js entirely so the heavy ONNX model never loads in tests.
// vi.hoisted() lets the mock factory reference these vars even after vitest
// hoists vi.mock() above the imports.
const { generateMock, fromPretrainedMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  fromPretrainedMock: vi.fn(),
}));

vi.mock('kokoro-js', () => ({
  KokoroTTS: {
    from_pretrained: fromPretrainedMock,
  },
}));

import {
  TTS_VOICES,
  getTtsService,
  _resetTtsServiceForTesting,
  _detectDeviceForTesting,
  type TtsVoice,
} from './tts-engine';

describe('TTS_VOICES', () => {
  it('contains the five expected voice ids in the documented order', () => {
    const ids = TTS_VOICES.map((v) => v.id);
    expect(ids).toEqual(['af_heart', 'am_michael', 'bf_emma', 'bm_george', 'af_nicole']);
  });

  it('every entry has displayName, accent, and gender', () => {
    for (const voice of TTS_VOICES) {
      expect(voice.displayName).toBeTypeOf('string');
      expect(voice.displayName.length).toBeGreaterThan(0);
      expect(['American', 'British']).toContain(voice.accent);
      expect(['female', 'male']).toContain(voice.gender);
    }
  });

  it('marks af_heart as American female "Heart"', () => {
    const heart = TTS_VOICES.find((v) => v.id === 'af_heart');
    expect(heart).toEqual({
      id: 'af_heart',
      displayName: 'Heart',
      accent: 'American',
      gender: 'female',
    });
  });
});

describe('detectDevice', () => {
  type WindowWithCapacitor = Window & {
    Capacitor?: { isNativePlatform?: () => boolean };
  };
  let originalCapacitor: WindowWithCapacitor['Capacitor'];
  let originalGpu: unknown;

  beforeEach(() => {
    originalCapacitor = (globalThis.window as WindowWithCapacitor).Capacitor;
    originalGpu = (navigator as unknown as { gpu?: unknown }).gpu;
  });

  afterEach(() => {
    if (originalCapacitor === undefined) {
      delete (globalThis.window as WindowWithCapacitor).Capacitor;
    } else {
      (globalThis.window as WindowWithCapacitor).Capacitor = originalCapacitor;
    }
    if (originalGpu === undefined) {
      delete (navigator as unknown as { gpu?: unknown }).gpu;
    } else {
      (navigator as unknown as { gpu?: unknown }).gpu = originalGpu;
    }
  });

  it('returns "wasm" when Capacitor.isNativePlatform() is true', () => {
    (globalThis.window as WindowWithCapacitor).Capacitor = { isNativePlatform: () => true };
    (navigator as unknown as { gpu?: unknown }).gpu = {};
    expect(_detectDeviceForTesting()).toBe('wasm');
  });

  it('returns "webgpu" when navigator.gpu exists and not in Capacitor', () => {
    delete (globalThis.window as WindowWithCapacitor).Capacitor;
    (navigator as unknown as { gpu?: unknown }).gpu = {};
    expect(_detectDeviceForTesting()).toBe('webgpu');
  });

  it('returns "wasm" when neither Capacitor nor navigator.gpu present', () => {
    delete (globalThis.window as WindowWithCapacitor).Capacitor;
    delete (navigator as unknown as { gpu?: unknown }).gpu;
    expect(_detectDeviceForTesting()).toBe('wasm');
  });

  it('returns "wasm" when Capacitor exists but isNativePlatform is undefined', () => {
    (globalThis.window as WindowWithCapacitor).Capacitor = {};
    delete (navigator as unknown as { gpu?: unknown }).gpu;
    expect(_detectDeviceForTesting()).toBe('wasm');
  });

  it('returns "webgpu" when Capacitor.isNativePlatform exists but returns false', () => {
    (globalThis.window as WindowWithCapacitor).Capacitor = { isNativePlatform: () => false };
    (navigator as unknown as { gpu?: unknown }).gpu = {};
    expect(_detectDeviceForTesting()).toBe('webgpu');
  });
});

describe('getTtsService singleton', () => {
  beforeEach(() => {
    _resetTtsServiceForTesting();
    fromPretrainedMock.mockReset();
    generateMock.mockReset();
  });

  it('returns the same instance across multiple calls', () => {
    const a = getTtsService();
    const b = getTtsService();
    expect(a).toBe(b);
  });

  it('_resetTtsServiceForTesting clears the singleton so a fresh instance is returned', () => {
    const a = getTtsService();
    _resetTtsServiceForTesting();
    const b = getTtsService();
    expect(a).not.toBe(b);
  });
});

describe('KokoroTtsService', () => {
  // The mock source mimics the bits of AudioBufferSourceNode the engine touches.
  // The engine subscribes to 'ended' via addEventListener; calling onended() here
  // dispatches to those listeners so existing tests can drive completion.
  interface CapturedSource {
    buffer: AudioBuffer | null;
    onended: ((this: AudioBufferSourceNode, event: Event) => unknown) | null;
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  }

  interface CapturedAudioCtx {
    state: AudioContextState;
    createBuffer: ReturnType<typeof vi.fn>;
    createBufferSource: ReturnType<typeof vi.fn>;
    decodeAudioData: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    destination: AudioDestinationNode;
  }

  let createdContexts: CapturedAudioCtx[];
  let createdSources: CapturedSource[];
  const OriginalAudioContext = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;

  function makeAudioContext(): CapturedAudioCtx {
    const ctx: CapturedAudioCtx = {
      state: 'suspended',
      createBuffer: vi.fn((_channels: number, length: number, _sampleRate: number) => {
        return {
          length,
          sampleRate: _sampleRate,
          numberOfChannels: _channels,
          duration: length / _sampleRate,
          copyToChannel: vi.fn(),
          getChannelData: vi.fn(),
          copyFromChannel: vi.fn(),
        } as unknown as AudioBuffer;
      }),
      createBufferSource: vi.fn(() => {
        const endedListeners: ((event: Event) => void)[] = [];
        const source: CapturedSource = {
          buffer: null,
          onended(this: AudioBufferSourceNode, event: Event) {
            for (const listener of endedListeners) listener(event);
          },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          disconnect: vi.fn(),
          addEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
            if (type === 'ended') endedListeners.push(listener);
          }),
          removeEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
            if (type !== 'ended') return;
            const index = endedListeners.indexOf(listener);
            if (index !== -1) endedListeners.splice(index, 1);
          }),
        };
        createdSources.push(source);
        return source as unknown as AudioBufferSourceNode;
      }),
      decodeAudioData: vi.fn(),
      resume: vi.fn(() => {
        ctx.state = 'running';
        return Promise.resolve();
      }),
      close: vi.fn(() => {
        ctx.state = 'closed';
        return Promise.resolve();
      }),
      destination: {} as AudioDestinationNode,
    };
    createdContexts.push(ctx);
    return ctx;
  }

  beforeEach(() => {
    _resetTtsServiceForTesting();
    fromPretrainedMock.mockReset();
    generateMock.mockReset();
    fromPretrainedMock.mockResolvedValue({ generate: generateMock });
    generateMock.mockResolvedValue({
      audio: new Float32Array(100),
      sampling_rate: 24_000,
    });
    createdContexts = [];
    createdSources = [];
    (globalThis as { AudioContext?: unknown }).AudioContext = vi.fn(
      makeAudioContext
    ) as unknown as typeof AudioContext;
  });

  afterEach(() => {
    if (OriginalAudioContext === undefined) {
      delete (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    } else {
      (globalThis as { AudioContext?: typeof AudioContext }).AudioContext = OriginalAudioContext;
    }
  });

  it('isLoaded() returns false before load()', () => {
    const service = getTtsService();
    expect(service.isLoaded()).toBe(false);
  });

  it('load() calls KokoroTTS.from_pretrained with the documented model id, dtype, and device', async () => {
    const service = getTtsService();
    await service.load();
    expect(fromPretrainedMock).toHaveBeenCalledTimes(1);
    const [modelId, options] = fromPretrainedMock.mock.calls[0]!;
    expect(modelId).toBe('onnx-community/Kokoro-82M-v1.0-ONNX');
    expect(options.dtype).toBe('q8f16');
    expect(['wasm', 'webgpu']).toContain(options.device);
    expect(service.isLoaded()).toBe(true);
  });

  it('load() forwards progress_callback so callers can render a progress bar', async () => {
    const onProgress = vi.fn();
    const service = getTtsService();
    await service.load(onProgress);
    const [, options] = fromPretrainedMock.mock.calls[0]!;
    expect(typeof options.progress_callback).toBe('function');
    options.progress_callback({ status: 'progress', loaded: 50, total: 100 });
    expect(onProgress).toHaveBeenCalledWith(50, 100);
  });

  it('load() ignores progress events without numeric loaded/total', async () => {
    const onProgress = vi.fn();
    const service = getTtsService();
    await service.load(onProgress);
    const [, options] = fromPretrainedMock.mock.calls[0]!;
    options.progress_callback({ status: 'initiate' });
    options.progress_callback({ status: 'progress', loaded: 10 });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('load() is idempotent — calling twice triggers from_pretrained only once', async () => {
    const service = getTtsService();
    await service.load();
    await service.load();
    expect(fromPretrainedMock).toHaveBeenCalledTimes(1);
  });

  it('load() concurrent calls share a single in-flight promise', async () => {
    const service = getTtsService();
    const [a, b] = await Promise.all([service.load(), service.load()]);
    expect(fromPretrainedMock).toHaveBeenCalledTimes(1);
    // both resolved with undefined
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
  });

  it('load() rejects propagate to the caller and leave isLoaded false', async () => {
    fromPretrainedMock.mockRejectedValueOnce(new Error('network down'));
    const service = getTtsService();
    await expect(service.load()).rejects.toThrow('network down');
    expect(service.isLoaded()).toBe(false);
  });

  it('unlockAudio() creates an AudioContext and primes it with a 1-sample buffer', () => {
    const service = getTtsService();
    service.unlockAudio();
    expect(createdContexts).toHaveLength(1);
    const ctx = createdContexts[0]!;
    expect(ctx.createBuffer).toHaveBeenCalledWith(1, 1, expect.any(Number));
    expect(createdSources).toHaveLength(1);
    const source = createdSources[0]!;
    expect(source.connect).toHaveBeenCalledWith(ctx.destination);
    expect(source.start).toHaveBeenCalled();
  });

  it('unlockAudio() is idempotent — re-calling does not create a new AudioContext', () => {
    const service = getTtsService();
    service.unlockAudio();
    service.unlockAudio();
    expect(createdContexts).toHaveLength(1);
  });

  it('speak() throws when called before load()', async () => {
    const service = getTtsService();
    await expect(service.speak('hello', 'af_heart')).rejects.toThrow(/not loaded/i);
  });

  it('speak() generates audio via Kokoro and plays it through Web Audio', async () => {
    const service = getTtsService();
    await service.load();
    service.unlockAudio();
    const speakPromise = service.speak('hello world', 'af_heart');
    // Allow the awaited generate() microtask to settle then fire onended.
    await Promise.resolve();
    await Promise.resolve();
    expect(generateMock).toHaveBeenCalledWith('hello world', { voice: 'af_heart' });
    expect(createdSources.length).toBeGreaterThan(0);
    const source = createdSources.at(-1)!;
    const ctx = createdContexts[0]!;
    expect(ctx.createBuffer).toHaveBeenLastCalledWith(1, 100, 24_000);
    expect(source.connect).toHaveBeenCalledWith(ctx.destination);
    expect(source.start).toHaveBeenCalled();
    // Fire onended to resolve the promise.
    source.onended?.call(source as unknown as AudioBufferSourceNode, new Event('ended'));
    await expect(speakPromise).resolves.toBeUndefined();
  });

  it('speak() implicitly creates an AudioContext if unlockAudio() was not called first', async () => {
    const service = getTtsService();
    await service.load();
    const speakPromise = service.speak('hi', 'am_michael');
    await Promise.resolve();
    await Promise.resolve();
    expect(createdContexts.length).toBeGreaterThanOrEqual(1);
    const source = createdSources.at(-1)!;
    source.onended?.call(source as unknown as AudioBufferSourceNode, new Event('ended'));
    await speakPromise;
  });

  it('speak() resumes a suspended AudioContext before scheduling playback', async () => {
    const service = getTtsService();
    await service.load();
    service.unlockAudio();
    const ctx = createdContexts[0]!;
    ctx.state = 'suspended';
    const speakPromise = service.speak('resume me', 'af_heart');
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.resume).toHaveBeenCalled();
    const source = createdSources.at(-1)!;
    source.onended?.call(source as unknown as AudioBufferSourceNode, new Event('ended'));
    await speakPromise;
  });

  it('speak() forwards the correct voice option to Kokoro', async () => {
    const service = getTtsService();
    await service.load();
    const voices: TtsVoice[] = ['af_heart', 'am_michael', 'bf_emma', 'bm_george', 'af_nicole'];
    for (const voice of voices) {
      const promise = service.speak(`speaking with ${voice}`, voice);
      await Promise.resolve();
      await Promise.resolve();
      const source = createdSources.at(-1)!;
      source.onended?.call(source as unknown as AudioBufferSourceNode, new Event('ended'));
      await promise;
    }
    expect(generateMock).toHaveBeenCalledTimes(voices.length);
    for (const [index, voice] of voices.entries()) {
      expect(generateMock).toHaveBeenNthCalledWith(index + 1, expect.any(String), { voice });
    }
  });

  it('stop() cancels the currently-playing source and resolves the in-flight speak()', async () => {
    const service = getTtsService();
    await service.load();
    service.unlockAudio();
    const speakPromise = service.speak('to be stopped', 'af_heart');
    await Promise.resolve();
    await Promise.resolve();
    const source = createdSources.at(-1)!;
    service.stop();
    expect(source.stop).toHaveBeenCalled();
    // stop() should fire onended via a real AudioBufferSourceNode; the mock won't,
    // so the engine must resolve the speak promise itself.
    await expect(speakPromise).resolves.toBeUndefined();
  });

  it('stop() before any speak() is a safe no-op', () => {
    const service = getTtsService();
    expect(() => {
      service.stop();
    }).not.toThrow();
  });

  it('starting a new speak() while one is in flight cancels the previous one', async () => {
    const service = getTtsService();
    await service.load();
    service.unlockAudio();
    const first = service.speak('first', 'af_heart');
    await Promise.resolve();
    await Promise.resolve();
    const firstSource = createdSources.at(-1)!;
    const second = service.speak('second', 'af_heart');
    await Promise.resolve();
    await Promise.resolve();
    expect(firstSource.stop).toHaveBeenCalled();
    await expect(first).resolves.toBeUndefined();
    const secondSource = createdSources.at(-1)!;
    secondSource.onended?.call(
      secondSource as unknown as AudioBufferSourceNode,
      new Event('ended')
    );
    await second;
  });
});
