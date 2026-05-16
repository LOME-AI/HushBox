import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  TTS_VOICES,
  getTtsService,
  _resetTtsServiceForTesting,
  _setWorkerFactoryForTesting,
  _detectDeviceForTesting,
  type TtsVoice,
} from './tts-engine';

import type { WorkerInbound, WorkerOutbound } from './tts-worker-protocol';

class FakeWorker extends EventTarget {
  postMessage = vi.fn<(msg: WorkerInbound, transfer?: Transferable[]) => void>();
  terminate = vi.fn<() => void>();

  send(msg: WorkerOutbound, _transfer: Transferable[] = []): void {
    this.dispatchEvent(new MessageEvent('message', { data: msg }));
  }
}

function lastInboundOfType<T extends WorkerInbound['type']>(
  worker: FakeWorker,
  type: T
): Extract<WorkerInbound, { type: T }> | undefined {
  for (let index = worker.postMessage.mock.calls.length - 1; index >= 0; index--) {
    const [msg] = worker.postMessage.mock.calls[index]!;
    if (msg.type === type) return msg as Extract<WorkerInbound, { type: T }>;
  }
  return undefined;
}

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

  it('returns "wasm" when Capacitor.isNativePlatform() is true', async () => {
    (globalThis.window as WindowWithCapacitor).Capacitor = { isNativePlatform: () => true };
    (navigator as unknown as { gpu?: unknown }).gpu = {
      requestAdapter: () => Promise.resolve({}),
    };
    await expect(_detectDeviceForTesting()).resolves.toBe('wasm');
  });

  it('returns "webgpu" when requestAdapter returns a valid adapter', async () => {
    delete (globalThis.window as WindowWithCapacitor).Capacitor;
    (navigator as unknown as { gpu?: unknown }).gpu = {
      requestAdapter: () => Promise.resolve({}),
    };
    await expect(_detectDeviceForTesting()).resolves.toBe('webgpu');
  });

  it('returns "wasm" when requestAdapter returns null (API present but no adapter)', async () => {
    delete (globalThis.window as WindowWithCapacitor).Capacitor;
    (navigator as unknown as { gpu?: unknown }).gpu = {
      requestAdapter: () => Promise.resolve(null),
    };
    await expect(_detectDeviceForTesting()).resolves.toBe('wasm');
  });

  it('returns "wasm" when requestAdapter throws', async () => {
    delete (globalThis.window as WindowWithCapacitor).Capacitor;
    (navigator as unknown as { gpu?: unknown }).gpu = {
      requestAdapter: () => Promise.reject(new Error('GPU init failed')),
    };
    await expect(_detectDeviceForTesting()).resolves.toBe('wasm');
  });

  it('returns "wasm" when neither Capacitor nor navigator.gpu present', async () => {
    delete (globalThis.window as WindowWithCapacitor).Capacitor;
    delete (navigator as unknown as { gpu?: unknown }).gpu;
    await expect(_detectDeviceForTesting()).resolves.toBe('wasm');
  });
});

describe('getTtsService singleton', () => {
  beforeEach(() => {
    _resetTtsServiceForTesting();
    _setWorkerFactoryForTesting(() => new FakeWorker() as unknown as Worker);
  });

  afterEach(() => {
    _resetTtsServiceForTesting();
    _setWorkerFactoryForTesting(null);
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

describe('WorkerKokoroTtsService', () => {
  interface CapturedSource {
    buffer: AudioBuffer | null;
    onended: ((this: AudioBufferSourceNode, event: Event) => unknown) | null;
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    triggerEnded(): void;
  }

  interface CapturedAudioCtx {
    state: AudioContextState;
    currentTime: number;
    createBuffer: ReturnType<typeof vi.fn>;
    createBufferSource: ReturnType<typeof vi.fn>;
    decodeAudioData: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    destination: AudioDestinationNode;
  }

  let createdContexts: CapturedAudioCtx[];
  let createdSources: CapturedSource[];
  let createdWorkers: FakeWorker[];
  const OriginalAudioContext = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;

  function makeAudioContext(): CapturedAudioCtx {
    const ctx: CapturedAudioCtx = {
      state: 'suspended',
      currentTime: 0,
      createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => {
        return {
          length,
          sampleRate,
          numberOfChannels: _channels,
          duration: length / sampleRate,
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
          triggerEnded(): void {
            for (const listener of endedListeners) listener(new Event('ended'));
          },
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

  function currentWorker(): FakeWorker {
    return createdWorkers.at(-1)!;
  }

  async function completeLoad(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const loadMsg = lastInboundOfType(worker, 'load');
    if (loadMsg) worker.send({ type: 'loadDone', requestId: loadMsg.requestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const warmupMsg = lastInboundOfType(worker, 'warmup');
    if (warmupMsg) worker.send({ type: 'warmupDone', requestId: warmupMsg.requestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    _resetTtsServiceForTesting();
    createdContexts = [];
    createdSources = [];
    createdWorkers = [];
    _setWorkerFactoryForTesting(() => {
      const w = new FakeWorker();
      createdWorkers.push(w);
      return w as unknown as Worker;
    });
    (globalThis as { AudioContext?: unknown }).AudioContext = vi.fn(
      makeAudioContext
    ) as unknown as typeof AudioContext;
  });

  afterEach(() => {
    _resetTtsServiceForTesting();
    _setWorkerFactoryForTesting(null);
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

  it('load() spawns a worker and posts a load message', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createdWorkers).toHaveLength(1);
    const worker = currentWorker();
    expect(worker.postMessage).toHaveBeenCalled();
    const sent = worker.postMessage.mock.calls[0]![0];
    expect(sent.type).toBe('load');
    expect(typeof (sent as { requestId: string }).requestId).toBe('string');
    worker.send({ type: 'loadDone', requestId: (sent as { requestId: string }).requestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const warmupMsg = lastInboundOfType(worker, 'warmup')!;
    worker.send({ type: 'warmupDone', requestId: warmupMsg.requestId });
    await loadPromise;
    expect(service.isLoaded()).toBe(true);
  });

  it('load() resolves only after both loadDone and warmupDone arrive', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    let resolved = false;

    /* eslint-disable promise/prefer-await-to-then, promise/always-return -- observe resolution without awaiting */
    loadPromise
      .then(() => {
        resolved = true;
      })
      .catch(() => {});
    /* eslint-enable promise/prefer-await-to-then, promise/always-return */
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const loadMsg = lastInboundOfType(worker, 'load')!;
    worker.send({ type: 'loadDone', requestId: loadMsg.requestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);
    const warmupMsg = lastInboundOfType(worker, 'warmup')!;
    worker.send({ type: 'warmupDone', requestId: warmupMsg.requestId });
    await loadPromise;
    expect(resolved).toBe(true);
  });

  it('load() forwards loadProgress events to the onProgress callback', async () => {
    const onProgress = vi.fn();
    const service = getTtsService();
    const loadPromise = service.load('af_heart', onProgress);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const loadMsg = lastInboundOfType(worker, 'load')!;
    worker.send({
      type: 'loadProgress',
      requestId: loadMsg.requestId,
      loaded: 50,
      total: 100,
    });
    expect(onProgress).toHaveBeenCalledWith(50, 100);
    worker.send({ type: 'loadDone', requestId: loadMsg.requestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const warmupMsg = lastInboundOfType(worker, 'warmup')!;
    worker.send({ type: 'warmupDone', requestId: warmupMsg.requestId });
    await loadPromise;
  });

  it('load() rejects on loadError and leaves isLoaded false', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const loadMsg = lastInboundOfType(worker, 'load')!;
    worker.send({ type: 'loadError', requestId: loadMsg.requestId, message: 'network down' });
    await expect(loadPromise).rejects.toThrow('network down');
    expect(service.isLoaded()).toBe(false);
  });

  it('load() concurrent calls share the same in-flight promise', async () => {
    const service = getTtsService();
    const promiseA = service.load('af_heart');
    const promiseB = service.load('af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createdWorkers).toHaveLength(1);
    const worker = currentWorker();
    const loadCount = worker.postMessage.mock.calls.filter(([m]) => m.type === 'load').length;
    expect(loadCount).toBe(1);
    await completeLoad();
    await Promise.all([promiseA, promiseB]);
  });

  it('load() is idempotent — calling twice after success does not spawn another worker', async () => {
    const service = getTtsService();
    const p1 = service.load('af_heart');
    await completeLoad();
    await p1;
    await service.load('af_heart');
    expect(createdWorkers).toHaveLength(1);
  });

  it('warmupError still resolves load() successfully (best-effort)', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const loadMsg = lastInboundOfType(worker, 'load')!;
    worker.send({ type: 'loadDone', requestId: loadMsg.requestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const warmupMsg = lastInboundOfType(worker, 'warmup')!;
    worker.send({ type: 'warmupError', requestId: warmupMsg.requestId, message: 'oom' });
    await expect(loadPromise).resolves.toBeUndefined();
    expect(service.isLoaded()).toBe(true);
  });

  it('ignores a loadDone with a requestId that does not match the in-flight load', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    let resolved = false;
    /* eslint-disable promise/prefer-await-to-then, promise/always-return -- observe resolution without awaiting */
    loadPromise
      .then(() => {
        resolved = true;
      })
      .catch(() => {});
    /* eslint-enable promise/prefer-await-to-then, promise/always-return */
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    worker.send({ type: 'loadDone', requestId: 'stale-id-from-a-prior-load' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);
    expect(service.isLoaded()).toBe(false);
    // Now send the real loadDone — load should still complete.
    const loadMsg = lastInboundOfType(worker, 'load')!;
    worker.send({ type: 'loadDone', requestId: loadMsg.requestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const warmupMsg = lastInboundOfType(worker, 'warmup')!;
    worker.send({ type: 'warmupDone', requestId: warmupMsg.requestId });
    await loadPromise;
    expect(service.isLoaded()).toBe(true);
  });

  it('ignores a loadError with a stale requestId', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    worker.send({
      type: 'loadError',
      requestId: 'stale-id',
      message: 'should be ignored',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Real load completes normally.
    const loadMsg = lastInboundOfType(worker, 'load')!;
    worker.send({ type: 'loadDone', requestId: loadMsg.requestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const warmupMsg = lastInboundOfType(worker, 'warmup')!;
    worker.send({ type: 'warmupDone', requestId: warmupMsg.requestId });
    await loadPromise;
    expect(service.isLoaded()).toBe(true);
  });

  it('ignores a warmupDone with a stale requestId', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const loadMsg = lastInboundOfType(worker, 'load')!;
    worker.send({ type: 'loadDone', requestId: loadMsg.requestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.send({ type: 'warmupDone', requestId: 'stale-warmup-id' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.isLoaded()).toBe(false);
    const warmupMsg = lastInboundOfType(worker, 'warmup')!;
    worker.send({ type: 'warmupDone', requestId: warmupMsg.requestId });
    await loadPromise;
    expect(service.isLoaded()).toBe(true);
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

  it('speak() posts a speak message to the worker with the text and voice', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    void service.speak('hello world', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const speakMsg = lastInboundOfType(worker, 'speak')!;
    expect(speakMsg.text).toBe('hello world');
    expect(speakMsg.voice).toBe('af_heart');
    expect(typeof speakMsg.requestId).toBe('string');
  });

  it('speak() plays the audio buffer returned by the worker and resolves on ended', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    service.unlockAudio();
    const speakPromise = service.speak('hi', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const speakMsg = lastInboundOfType(worker, 'speak')!;
    const audio = new Float32Array(100);
    worker.send({
      type: 'speakReady',
      requestId: speakMsg.requestId,
      audio,
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ctx = createdContexts[0]!;
    expect(ctx.createBuffer).toHaveBeenLastCalledWith(1, 100, 24_000);
    const source = createdSources.at(-1)!;
    expect(source.connect).toHaveBeenCalledWith(ctx.destination);
    expect(source.start).toHaveBeenCalled();
    source.triggerEnded();
    await expect(speakPromise).resolves.toBeUndefined();
  });

  it('speak() rejects on speakError', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    const speakPromise = service.speak('boom', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const speakMsg = lastInboundOfType(worker, 'speak')!;
    worker.send({
      type: 'speakError',
      requestId: speakMsg.requestId,
      message: 'generation failed',
    });
    await expect(speakPromise).rejects.toThrow('generation failed');
  });

  it('two speak() calls in a row both post messages BEFORE either plays (pipelining)', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    void service.speak('first', 'af_heart');
    void service.speak('second', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const speaks = worker.postMessage.mock.calls.filter(([m]) => m.type === 'speak');
    expect(speaks).toHaveLength(2);
    expect((speaks[0]![0] as { text: string }).text).toBe('first');
    expect((speaks[1]![0] as { text: string }).text).toBe('second');
    expect(createdSources.filter((s) => s.start.mock.calls.length > 0)).toHaveLength(0);
  });

  it('audio for the SECOND speak() arriving first still plays the FIRST sentence first', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    const sourcesBefore = createdSources.length;
    const firstPromise = service.speak('first', 'af_heart');
    const secondPromise = service.speak('second', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const speaks = worker.postMessage.mock.calls.filter(([m]) => m.type === 'speak');
    const firstId = (speaks[0]![0] as { requestId: string }).requestId;
    const secondId = (speaks[1]![0] as { requestId: string }).requestId;
    // Out-of-order audio arrival: second arrives first.
    worker.send({
      type: 'speakReady',
      requestId: secondId,
      audio: new Float32Array(50),
      samplingRate: 24_000,
    });
    worker.send({
      type: 'speakReady',
      requestId: firstId,
      audio: new Float32Array(100),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // With sample-accurate scheduling, both sources get scheduled before either
    // ends. The chain still serializes scheduling order: the FIRST sentence
    // must be scheduled first (length 100), the SECOND after (length 50).
    const speakSources = createdSources.slice(sourcesBefore);
    expect(speakSources.length).toBe(2);
    const firstScheduled = speakSources[0]!;
    const secondScheduled = speakSources[1]!;
    expect(firstScheduled.buffer?.length).toBe(100);
    expect(secondScheduled.buffer?.length).toBe(50);
    const firstStart = (firstScheduled.start.mock.calls[0] as [number])[0];
    const secondStart = (secondScheduled.start.mock.calls[0] as [number])[0];
    expect(secondStart).toBeGreaterThanOrEqual(firstStart);
    firstScheduled.triggerEnded();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await firstPromise;
    secondScheduled.triggerEnded();
    await secondPromise;
  });

  it('stop() stops the currently playing source', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    const speakPromise = service.speak('to stop', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const speakMsg = lastInboundOfType(worker, 'speak')!;
    worker.send({
      type: 'speakReady',
      requestId: speakMsg.requestId,
      audio: new Float32Array(100),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const source = createdSources.at(-1)!;
    service.stop();
    expect(source.stop).toHaveBeenCalled();
    source.triggerEnded();
    await speakPromise;
  });

  it('stop() posts a cancel message for an in-flight generation that has not yet returned audio', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    // eslint-disable-next-line promise/prefer-await-to-then -- fire and forget so we can call stop() while generation is still pending
    service.speak('still generating', 'af_heart').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const speakMsg = lastInboundOfType(worker, 'speak')!;
    service.stop();
    const cancelMsgs = worker.postMessage.mock.calls.filter(([m]) => m.type === 'cancel');
    expect(cancelMsgs).toHaveLength(1);
    expect((cancelMsgs[0]![0] as { requestId: string }).requestId).toBe(speakMsg.requestId);
  });

  it('stop() before any speak() is a safe no-op', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    expect(() => {
      service.stop();
    }).not.toThrow();
  });

  it('stop() rejects a pending speak() promise with a cancellation error', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    const pending = service.speak('still generating', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.stop();
    await expect(pending).rejects.toThrow(/cancell?ed/i);
  });

  it('stop() between two queued speaks prevents the second from playing', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    const firstPromise = service.speak('first', 'af_heart');
    // eslint-disable-next-line promise/prefer-await-to-then -- queue a second speak, then stop() it before it plays
    service.speak('second', 'af_heart').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const speaks = worker.postMessage.mock.calls.filter(([m]) => m.type === 'speak');
    worker.send({
      type: 'speakReady',
      requestId: (speaks[0]![0] as { requestId: string }).requestId,
      audio: new Float32Array(100),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstSource = createdSources.at(-1)!;
    service.stop();
    firstSource.triggerEnded();
    await firstPromise;
    // After stop, even if second audio arrives it should not play.
    const sourceCountBefore = createdSources.length;
    worker.send({
      type: 'speakReady',
      requestId: (speaks[1]![0] as { requestId: string }).requestId,
      audio: new Float32Array(50),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createdSources.length).toBe(sourceCountBefore);
  });

  it('load() sends the supplied voice in the warmup message so its embedding is preloaded', async () => {
    const service = getTtsService();
    const loadPromise = service.load('am_michael');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const loadMsg = lastInboundOfType(worker, 'load')!;
    worker.send({ type: 'loadDone', requestId: loadMsg.requestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const warmupMsg = lastInboundOfType(worker, 'warmup')!;
    expect(warmupMsg.voice).toBe('am_michael');
    worker.send({ type: 'warmupDone', requestId: warmupMsg.requestId });
    await loadPromise;
  });

  it('preloadVoice() sends a warmup message with the new voice so the embedding is fetched up front', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    const worker = currentWorker();
    const beforeCount = worker.postMessage.mock.calls.filter(([m]) => m.type === 'warmup').length;
    const preload = service.preloadVoice('bm_george');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const warmupCalls = worker.postMessage.mock.calls.filter(([m]) => m.type === 'warmup');
    expect(warmupCalls.length).toBe(beforeCount + 1);
    const lastWarmup = warmupCalls.at(-1)![0] as Extract<WorkerInbound, { type: 'warmup' }>;
    expect(lastWarmup.voice).toBe('bm_george');
    worker.send({ type: 'warmupDone', requestId: lastWarmup.requestId });
    await expect(preload).resolves.toBeUndefined();
  });

  it('preloadVoice() rejects when called before load() resolves', async () => {
    const service = getTtsService();
    await expect(service.preloadVoice('bm_george')).rejects.toThrow(/not loaded/i);
  });

  it('schedules consecutive sentences sample-accurately: source N+1 starts at source N start + duration', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    service.unlockAudio();
    const ctx = createdContexts[0]!;
    // Pretend playback clock is past unlockAudio's primer.
    ctx.currentTime = 5;
    const sourcesBefore = createdSources.length;

    const firstPromise = service.speak('first', 'af_heart');
    const secondPromise = service.speak('second', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const speaks = worker.postMessage.mock.calls.filter(([m]) => m.type === 'speak');
    const firstId = (speaks[0]![0] as { requestId: string }).requestId;
    const secondId = (speaks[1]![0] as { requestId: string }).requestId;
    // 2400 samples @ 24kHz = 0.1s duration; 4800 = 0.2s.
    worker.send({
      type: 'speakReady',
      requestId: firstId,
      audio: new Float32Array(2400),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.send({
      type: 'speakReady',
      requestId: secondId,
      audio: new Float32Array(4800),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Sources created after the unlockAudio primer are the real playback sources.
    const speakSources = createdSources.slice(sourcesBefore);
    expect(speakSources.length).toBe(2);
    const firstStart = (speakSources[0]!.start.mock.calls[0] as [number])[0];
    const secondStart = (speakSources[1]!.start.mock.calls[0] as [number])[0];
    // First source plays at currentTime (5); second at 5 + 0.1 = 5.1.
    expect(firstStart).toBeCloseTo(5, 5);
    expect(secondStart).toBeCloseTo(5.1, 5);

    speakSources[0]!.triggerEnded();
    speakSources[1]!.triggerEnded();
    await firstPromise;
    await secondPromise;
  });

  it('schedules immediately when nextStartTime lags behind currentTime (inference slower than playback)', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    service.unlockAudio();
    const ctx = createdContexts[0]!;
    ctx.currentTime = 10;

    const firstPromise = service.speak('first', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const firstSpeakMsg = lastInboundOfType(worker, 'speak')!;
    worker.send({
      type: 'speakReady',
      requestId: firstSpeakMsg.requestId,
      audio: new Float32Array(2400),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    createdSources.at(-1)!.triggerEnded();
    await firstPromise;

    // Advance clock past nextStartTime (10.1) to simulate a gap before next inference.
    ctx.currentTime = 30;
    const secondPromise = service.speak('second', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondSpeakMsg = lastInboundOfType(worker, 'speak')!;
    worker.send({
      type: 'speakReady',
      requestId: secondSpeakMsg.requestId,
      audio: new Float32Array(2400),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const startedSources = createdSources.filter((s) => s.start.mock.calls.length > 0);
    const secondStart = (startedSources.at(-1)!.start.mock.calls[0] as [number])[0];
    // Second sentence should start at 30 (currentTime), NOT 10.1 (stale nextStartTime).
    expect(secondStart).toBeCloseTo(30, 5);
    createdSources.at(-1)!.triggerEnded();
    await secondPromise;
  });

  it('stop() stops every scheduled source, not just the first one', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    service.unlockAudio();
    const ctx = createdContexts[0]!;
    ctx.currentTime = 0;
    const sourcesBefore = createdSources.length;

    const firstPromise = service.speak('first', 'af_heart').catch(() => {});
    const secondPromise = service.speak('second', 'af_heart').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = currentWorker();
    const speaks = worker.postMessage.mock.calls.filter(([m]) => m.type === 'speak');
    worker.send({
      type: 'speakReady',
      requestId: (speaks[0]![0] as { requestId: string }).requestId,
      audio: new Float32Array(24_000),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.send({
      type: 'speakReady',
      requestId: (speaks[1]![0] as { requestId: string }).requestId,
      audio: new Float32Array(24_000),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Both speak sources are pre-scheduled (second starts at 1.0s, in the future).
    const speakSources = createdSources.slice(sourcesBefore);
    expect(speakSources.length).toBe(2);

    service.stop();

    // Both must be stopped — not just the first one.
    for (const source of speakSources) {
      expect(source.stop).toHaveBeenCalled();
    }
    for (const source of speakSources) source.triggerEnded();
    await firstPromise;
    await secondPromise;
  });

  it('speak() forwards each voice in TTS_VOICES correctly', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    const voices: TtsVoice[] = ['af_heart', 'am_michael', 'bf_emma', 'bm_george', 'af_nicole'];
    const worker = currentWorker();
    for (const voice of voices) {
      const promise = service.speak(`x ${voice}`, voice);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const speakMsg = lastInboundOfType(worker, 'speak')!;
      expect(speakMsg.voice).toBe(voice);
      worker.send({
        type: 'speakReady',
        requestId: speakMsg.requestId,
        audio: new Float32Array(10),
        samplingRate: 24_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const source = createdSources.at(-1)!;
      source.triggerEnded();
      await promise;
    }
  });

  it('_resetTtsServiceForTesting terminates the worker', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    await completeLoad();
    await loadPromise;
    const worker = currentWorker();
    _resetTtsServiceForTesting();
    expect(worker.terminate).toHaveBeenCalled();
  });
});
