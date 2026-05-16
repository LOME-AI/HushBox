// Kokoro TTS engine proxy. Spawns a dedicated Web Worker on first use so
// model inference never blocks the main thread. The worker hosts the
// kokoro-js KokoroTTS instance and its ONNX Runtime WASM/WebGPU runtime;
// this module owns AudioContext playback and the playback queue.
//
// Generation and playback are pipelined: speak() enqueues a generate call
// in the worker immediately (returning a promise that resolves whenever
// audio comes back), and a separate `playbackChain` plays audio buffers
// in enqueue order. Sentence N+1's inference therefore runs while
// sentence N is playing, hiding inference latency for all but the first
// sentence in a stream.

import { isWorkerOutbound } from './tts-worker-protocol';
import type { WorkerInbound, WorkerOutbound } from './tts-worker-protocol';

/** Test-only export; do not consume in production code. */
export { detectDevice as _detectDeviceForTesting } from './device-detect';

export type TtsVoice = 'af_heart' | 'am_michael' | 'bf_emma' | 'bm_george' | 'af_nicole';

export interface TtsVoiceMeta {
  readonly id: TtsVoice;
  readonly displayName: string;
  readonly accent: 'American' | 'British';
  readonly gender: 'female' | 'male';
}

export const TTS_VOICES: readonly TtsVoiceMeta[] = [
  { id: 'af_heart', displayName: 'Heart', accent: 'American', gender: 'female' },
  { id: 'am_michael', displayName: 'Michael', accent: 'American', gender: 'male' },
  { id: 'bf_emma', displayName: 'Emma', accent: 'British', gender: 'female' },
  { id: 'bm_george', displayName: 'George', accent: 'British', gender: 'male' },
  { id: 'af_nicole', displayName: 'Nicole', accent: 'American', gender: 'female' },
];

export interface TtsService {
  /**
   * Lazy-load the model. Resolves when ready to speak (after warmup with
   * the supplied voice — preloads that voice's embedding so the first real
   * speak() doesn't pay an extra network fetch). Idempotent and safe to
   * call concurrently.
   */
  load(voice: TtsVoice, onProgress?: (loaded: number, total: number) => void): Promise<void>;
  /** True after load() resolved successfully. */
  isLoaded(): boolean;
  /**
   * Re-warm with a different voice so its embedding is fetched up front.
   * Call after the user changes voices. Rejects if the model is not loaded.
   */
  preloadVoice(voice: TtsVoice): Promise<void>;
  /** Enqueue a sentence. Resolves when audio finishes (or is stopped). Concurrent speak() calls are pipelined. */
  speak(text: string, voice: TtsVoice): Promise<void>;
  /** Stop any in-flight audio and clear the pipeline. */
  stop(): void;
  /**
   * Required: must be called inside a user gesture (click) on iOS to unlock
   * the AudioContext. Subsequent calls are no-ops.
   */
  unlockAudio(): void;
}

let fallbackCounter = 0;
function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  fallbackCounter += 1;
  return `req-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}

type WorkerFactory = () => Worker;

let workerFactoryOverride: WorkerFactory | null = null;

/** Test-only: override the factory used by new WorkerKokoroTtsService instances. */
export function _setWorkerFactoryForTesting(factory: WorkerFactory | null): void {
  workerFactoryOverride = factory;
}

function defaultWorkerFactory(): Worker {
  // Vite bundles workers referenced via `new URL(..., import.meta.url)` as
  // a separate chunk. `type: 'module'` matches the worker's ES module
  // source — Vite's default `iife` format would break the static imports
  // (kokoro-js, device-detect) at the top of tts.worker.ts.
  return new Worker(new URL('tts.worker.ts', import.meta.url), { type: 'module' });
}

/** Thrown when stop() cancels a pending speak() before audio finishes. */
class CancelledError extends Error {
  constructor() {
    super('TTS speak was cancelled');
    this.name = 'CancelledError';
  }
}

interface PendingLoad {
  resolve: () => void;
  reject: (error: Error) => void;
  onProgress: ((loaded: number, total: number) => void) | undefined;
  loadDone: boolean;
  warmupSettled: boolean;
  loadRequestId: string;
  warmupRequestId: string | null;
  voice: TtsVoice;
}

interface PendingPreload {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingSpeak {
  resolveAudio: (data: { audio: Float32Array; samplingRate: number }) => void;
  rejectAudio: (error: Error) => void;
}

class WorkerKokoroTtsService implements TtsService {
  private worker: Worker | null = null;
  private loaded = false;
  private pendingLoad: PendingLoad | null = null;
  private loadPromise: Promise<void> | null = null;
  private pendingPreloads = new Map<string, PendingPreload>();
  private pendingSpeaks = new Map<string, PendingSpeak>();
  private audioCtx: AudioContext | null = null;
  // Sample-accurate playback scheduling: nextStartTime tracks the absolute
  // AudioContext time at which the *next* buffer should begin, so back-to-
  // back sentences play with zero gap (the 5-30ms `'ended'`-event jitter is
  // eliminated). scheduledSources holds every buffer that has been
  // `start()`ed but not yet `'ended'`; stop() walks the set so pre-scheduled
  // future buffers are cancelled too.
  private nextStartTime = 0;
  private scheduledSources = new Set<AudioBufferSourceNode>();
  private playbackChain: Promise<void> = Promise.resolve();

  constructor(private readonly factory: WorkerFactory = defaultWorkerFactory) {}

  load(voice: TtsVoice, onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loadPromise !== null) return this.loadPromise;

    this.worker ??= this.spawnWorker();
    const loadRequestId = newRequestId();

    this.loadPromise = new Promise<void>((resolve, reject) => {
      this.pendingLoad = {
        resolve,
        reject,
        onProgress,
        loadDone: false,
        warmupSettled: false,
        loadRequestId,
        warmupRequestId: null,
        voice,
      };
    });

    this.postToWorker({ type: 'load', requestId: loadRequestId });
    return this.loadPromise;
  }

  preloadVoice(voice: TtsVoice): Promise<void> {
    if (!this.loaded) {
      return Promise.reject(new Error('TTS engine is not loaded — call load() first'));
    }
    const requestId = newRequestId();
    return new Promise<void>((resolve, reject) => {
      this.pendingPreloads.set(requestId, { resolve, reject });
      this.postToWorker({ type: 'warmup', requestId, voice });
    });
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  unlockAudio(): void {
    if (this.audioCtx !== null) return;
    const ctx = new AudioContext();
    this.audioCtx = ctx;
    const buffer = ctx.createBuffer(1, 1, 22_050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  }

  speak(text: string, voice: TtsVoice): Promise<void> {
    if (!this.loaded) {
      return Promise.reject(new Error('TTS engine is not loaded — call load() first'));
    }
    const requestId = newRequestId();
    const audioPromise = new Promise<{ audio: Float32Array; samplingRate: number }>(
      (resolve, reject) => {
        this.pendingSpeaks.set(requestId, { resolveAudio: resolve, rejectAudio: reject });
      }
    );
    this.postToWorker({ type: 'speak', requestId, text, voice });

    // Two-stage chain: `playbackChain` serializes the *scheduling* step (so
    // nextStartTime is computed in order), and advances as soon as the
    // current sentence's source has been `start()`ed — not after `'ended'`.
    // That lets sentence N+1's source be scheduled at sentence N's end-time
    // while N is still playing, eliminating the inter-buffer gap.
    const prevChain = this.playbackChain;
    let signalScheduled!: () => void;
    const scheduled = new Promise<void>((resolve) => {
      signalScheduled = resolve;
    });
    // eslint-disable-next-line promise/prefer-await-to-then -- chain advances on scheduled regardless of success/failure so a single failed sentence doesn't deadlock subsequent ones
    this.playbackChain = scheduled.then(
      () => {
        // Intentional no-op.
      },
      () => {
        // Intentional no-op.
      }
    );
    return (async () => {
      await prevChain;
      let audio: { audio: Float32Array; samplingRate: number };
      try {
        audio = await audioPromise;
      } catch (error: unknown) {
        signalScheduled();
        throw error;
      }
      let scheduled: { endedPromise: Promise<void> };
      try {
        scheduled = await this.scheduleAudio(audio.audio, audio.samplingRate);
      } catch (error: unknown) {
        signalScheduled();
        throw error;
      }
      signalScheduled();
      await scheduled.endedPromise;
    })();
  }

  stop(): void {
    this.playbackChain = Promise.resolve();
    for (const [requestId, entry] of this.pendingSpeaks) {
      this.postToWorker({ type: 'cancel', requestId });
      entry.rejectAudio(new CancelledError());
    }
    this.pendingSpeaks.clear();
    // Multiple sources may be pre-scheduled at once (sample-accurate
    // pipeline). Stop all of them — the second sentence might already be
    // queued to start at a future AudioContext.currentTime.
    for (const source of this.scheduledSources) {
      try {
        source.stop();
      } catch {
        // Already stopped or never started — inert either way.
      }
    }
    this.scheduledSources.clear();
    this.nextStartTime = 0;
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.loaded = false;
    this.pendingLoad = null;
    this.loadPromise = null;
    this.pendingPreloads.clear();
    this.pendingSpeaks.clear();
  }

  private spawnWorker(): Worker {
    const worker = this.factory();
    worker.addEventListener('message', (event: MessageEvent) => {
      const data = (event as MessageEvent<unknown>).data;
      if (!isWorkerOutbound(data)) return;
      this.handleWorkerMessage(data);
    });
    return worker;
  }

  private postToWorker(msg: WorkerInbound): void {
    this.worker?.postMessage(msg);
  }

  private handleWorkerMessage(msg: WorkerOutbound): void {
    switch (msg.type) {
      case 'loadProgress': {
        this.onLoadProgress(msg.requestId, msg.loaded, msg.total);
        return;
      }
      case 'loadDone': {
        this.onLoadDone(msg.requestId);
        return;
      }
      case 'loadError': {
        this.onLoadError(msg.requestId, msg.message);
        return;
      }
      case 'warmupDone': {
        this.onWarmupSettled(msg.requestId, null);
        return;
      }
      case 'warmupError': {
        this.onWarmupSettled(msg.requestId, msg.message);
        return;
      }
      case 'speakReady': {
        this.onSpeakReady(msg.requestId, msg.audio, msg.samplingRate);
        return;
      }
      case 'speakError': {
        this.onSpeakError(msg.requestId, msg.message);
        return;
      }
    }
  }

  private onLoadProgress(requestId: string, loaded: number, total: number): void {
    const pending = this.pendingLoad;
    if (pending === null) return;
    if (pending.loadRequestId !== requestId) return;
    pending.onProgress?.(loaded, total);
  }

  private onLoadDone(requestId: string): void {
    const pending = this.pendingLoad;
    if (pending === null) return;
    if (pending.loadRequestId !== requestId) return;
    if (pending.loadDone) return;
    pending.loadDone = true;
    const warmupRequestId = newRequestId();
    pending.warmupRequestId = warmupRequestId;
    this.postToWorker({ type: 'warmup', requestId: warmupRequestId, voice: pending.voice });
  }

  private onLoadError(requestId: string, message: string): void {
    const pending = this.pendingLoad;
    if (pending === null) return;
    if (pending.loadRequestId !== requestId) return;
    this.pendingLoad = null;
    this.loadPromise = null;
    pending.reject(new Error(message));
  }

  private onWarmupSettled(requestId: string, errorMessage: string | null): void {
    const preload = this.pendingPreloads.get(requestId);
    if (preload !== undefined) {
      this.pendingPreloads.delete(requestId);
      if (errorMessage === null) {
        preload.resolve();
      } else {
        preload.reject(new Error(errorMessage));
      }
      return;
    }
    const pending = this.pendingLoad;
    if (pending === null) return;
    if (pending.warmupRequestId !== requestId) return;
    pending.warmupSettled = true;
    if (!pending.loadDone) return;
    this.pendingLoad = null;
    this.loaded = true;
    pending.resolve();
  }

  private onSpeakReady(requestId: string, audio: Float32Array, samplingRate: number): void {
    const entry = this.pendingSpeaks.get(requestId);
    if (entry === undefined) return;
    this.pendingSpeaks.delete(requestId);
    entry.resolveAudio({ audio, samplingRate });
  }

  private onSpeakError(requestId: string, message: string): void {
    const entry = this.pendingSpeaks.get(requestId);
    if (entry === undefined) return;
    this.pendingSpeaks.delete(requestId);
    entry.rejectAudio(new Error(message));
  }

  /**
   * Schedule a buffer for playback and return an object holding the `'ended'`
   * promise. The OUTER awaitable resolves once the source has been
   * `.start()`ed — that's the moment the chain can advance. The ended
   * promise is wrapped in an object so async/await's Promise unwrapping
   * doesn't accidentally flatten it into the outer resolution.
   */
  private async scheduleAudio(
    audio: Float32Array,
    samplingRate: number
  ): Promise<{ endedPromise: Promise<void> }> {
    this.audioCtx ??= new AudioContext();
    const ctx = this.audioCtx;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    const buffer = ctx.createBuffer(1, audio.length, samplingRate);
    buffer.copyToChannel(audio as Float32Array<ArrayBuffer>, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    // Schedule at the previous buffer's end, or at the current playback clock
    // if inference has fallen behind playback (gap). Web Audio guarantees
    // sample-accurate playback when start() is called with a future time;
    // passing a past time is also valid — it plays immediately.
    const startTime = Math.max(this.nextStartTime, ctx.currentTime);
    this.nextStartTime = startTime + buffer.duration;
    this.scheduledSources.add(source);

    const endedPromise = new Promise<void>((resolve) => {
      const onEnded = (): void => {
        this.scheduledSources.delete(source);
        source.removeEventListener('ended', onEnded);
        resolve();
      };
      source.addEventListener('ended', onEnded);
      source.start(startTime);
    });
    return { endedPromise };
  }
}

let singletonService: WorkerKokoroTtsService | null = null;

export function getTtsService(): TtsService {
  singletonService ??= new WorkerKokoroTtsService(workerFactoryOverride ?? defaultWorkerFactory);
  return singletonService;
}

export function _resetTtsServiceForTesting(): void {
  singletonService?.terminate();
  singletonService = null;
}
