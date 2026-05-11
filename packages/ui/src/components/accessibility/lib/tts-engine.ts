// Kokoro TTS engine wrapper. Lazy-loads ~97MB model on first use.
// Same code path on web AND Capacitor — onnxruntime-web in WASM mode.
// WebGPU opportunistic on supported desktop browsers (10x faster).
//
// IMPORTANT: kokoro-js is dynamically imported inside `load()` rather than
// statically at module top. The static import would force kokoro-js +
// phonemizer + the espeak-ng WASM blob to load whenever this module is
// touched (even by transitive type imports), which crashes vitest worker
// threads. Keep the import lazy.

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
  /** Lazy-load the model. Resolves when ready to speak. Idempotent and safe to call concurrently. */
  load(onProgress?: (loaded: number, total: number) => void): Promise<void>;
  /** True after load() resolved successfully. */
  isLoaded(): boolean;
  /** Speak a single utterance. Resolves when audio finishes (or is stopped). */
  speak(text: string, voice: TtsVoice): Promise<void>;
  /** Stop any in-flight audio. */
  stop(): void;
  /**
   * Required: must be called inside a user gesture (click) on iOS to unlock the
   * AudioContext. Subsequent calls are no-ops.
   */
  unlockAudio(): void;
}

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
// q8 is universally supported by onnxruntime-web. `q8f16` (mixed precision 8-bit
// weights + fp16 activations) was removed from the supported dtype list, which
// caused "Invalid dtype" errors at load time.
const MODEL_DTYPE = 'q8';

interface WindowWithCapacitor extends Window {
  Capacitor?: { isNativePlatform?: () => boolean };
}

function detectDevice(): 'webgpu' | 'wasm' {
  if ('window' in globalThis) {
    const cap = (globalThis.window as WindowWithCapacitor).Capacitor;
    if (cap?.isNativePlatform?.() === true) return 'wasm';
  }
  if ('navigator' in globalThis && 'gpu' in globalThis.navigator) return 'webgpu';
  return 'wasm';
}

/** Test-only export; do not consume in production code. */
export const _detectDeviceForTesting = detectDevice;

interface KokoroTtsInstance {
  generate(
    text: string,
    options: { voice: string }
  ): Promise<{
    audio: Float32Array;
    sampling_rate: number;
  }>;
}

interface KokoroProgressEvent {
  status?: string;
  loaded?: number;
  total?: number;
}

class KokoroTtsService implements TtsService {
  private tts: KokoroTtsInstance | null = null;
  private loadPromise: Promise<void> | null = null;
  private audioCtx: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private currentResolve: (() => void) | null = null;

  async load(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.tts !== null) return;
    if (this.loadPromise !== null) return this.loadPromise;

    const promise = (async (): Promise<void> => {
      // Bridge kokoro-js' verbose progress callback shape to a 2-arg numeric one.
      const progressCallback = (event: KokoroProgressEvent): void => {
        if (onProgress === undefined) return;
        if (typeof event.loaded === 'number' && typeof event.total === 'number') {
          onProgress(event.loaded, event.total);
        }
      };
      // Dynamic import keeps kokoro-js (and its phonemizer + espeak-ng WASM)
      // out of the module-init graph. See file header for why this matters.
      const { KokoroTTS } = await import('kokoro-js');
      // Cast: kokoro-js' from_pretrained signature uses HF Transformers types we
      // don't import here; the runtime contract (model id, dtype, device, callback)
      // is what we test against.
      const instance = await (
        KokoroTTS.from_pretrained as unknown as (
          modelId: string,
          options: {
            dtype: string;
            device: 'wasm' | 'webgpu';
            progress_callback: (event: KokoroProgressEvent) => void;
          }
        ) => Promise<KokoroTtsInstance>
      )(MODEL_ID, {
        dtype: MODEL_DTYPE,
        device: detectDevice(),
        progress_callback: progressCallback,
      });
      this.tts = instance;
    })();

    this.loadPromise = promise;
    try {
      await promise;
    } catch (error) {
      // Reset so a subsequent load() can retry.
      this.loadPromise = null;
      throw error;
    }
  }

  isLoaded(): boolean {
    return this.tts !== null;
  }

  unlockAudio(): void {
    if (this.audioCtx !== null) return;
    const ctx = new AudioContext();
    this.audioCtx = ctx;
    // 1-sample silent buffer — the canonical iOS audio-unlock incantation.
    const buffer = ctx.createBuffer(1, 1, 22_050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  }

  async speak(text: string, voice: TtsVoice): Promise<void> {
    if (this.tts === null) {
      throw new Error('TTS engine is not loaded — call load() first');
    }
    // Cancel any in-flight playback first so the resolve channel is free.
    this.stop();

    const tts = this.tts;
    const audio = await tts.generate(text, { voice });

    // unlockAudio() may not have been called (e.g. desktop without iOS gesture
    // requirements). Create the context lazily so callers don't have to.
    this.audioCtx ??= new AudioContext();
    const ctx = this.audioCtx;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    const buffer = ctx.createBuffer(1, audio.audio.length, audio.sampling_rate);
    // copyToChannel typing requires Float32Array<ArrayBuffer>; kokoro returns
    // Float32Array<ArrayBufferLike>. The runtime bytes are the same.
    buffer.copyToChannel(audio.audio as Float32Array<ArrayBuffer>, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    return new Promise<void>((resolve) => {
      this.currentSource = source;
      this.currentResolve = resolve;
      source.addEventListener('ended', () => {
        if (this.currentSource === source) {
          this.currentSource = null;
          this.currentResolve = null;
        }
        resolve();
      });
      source.start(0);
    });
  }

  stop(): void {
    const source = this.currentSource;
    const resolve = this.currentResolve;
    this.currentSource = null;
    this.currentResolve = null;
    if (source !== null) {
      try {
        source.stop();
      } catch {
        // start() may not have been called yet, or stop() may have been called twice.
        // Either way the source is already inert; nothing to do.
      }
    }
    if (resolve !== null) {
      resolve();
    }
  }
}

let singletonService: TtsService | null = null;

export function getTtsService(): TtsService {
  singletonService ??= new KokoroTtsService();
  return singletonService;
}

export function _resetTtsServiceForTesting(): void {
  singletonService = null;
}
