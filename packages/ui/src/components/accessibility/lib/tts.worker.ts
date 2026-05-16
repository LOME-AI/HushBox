// Dedicated Web Worker that hosts the kokoro-js KokoroTTS instance and its
// underlying @huggingface/transformers + onnxruntime-web runtime. The proxy
// in tts-engine.ts (main thread) communicates over postMessage. Audio
// buffers are sent back as Transferable so the thread boundary is zero-copy.
//
// The handler logic is exported as `createWorkerHandler(ctx)` so tests can
// drive it without spawning a real worker. The worker globals are wired
// up at module bottom, guarded so the test environment (vitest jsdom) does
// not accidentally register a top-level listener.
//
// kokoro-js is imported statically: this module only loads inside the
// dedicated worker thread (main thread imports nothing from kokoro-js),
// so there's no module-graph pollution concern. Tests mock the import
// via vi.mock(). Static import also lets Vite bundle the worker as a
// single IIFE chunk — dynamic imports inside a worker would require
// `worker.format: 'es'` config, which we're avoiding.

import { KokoroTTS } from 'kokoro-js';

import { detectDevice } from './device-detect';
import type { WorkerInbound, WorkerOutbound } from './tts-worker-protocol';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
// WebGPU requires fp32: q8/fp16/q4f16 produce distorted or NaN audio on the
// WebGPU EP (kokoro-js issues #98 and #68; ORT issue #26732). Plain fp32 is
// also the dtype the canonical webml-community/kokoro-webgpu demo ships.
// q8 on WASM keeps the download small (~92 MB vs ~326 MB) where the CPU
// can't take advantage of full-precision math anyway.
const DTYPE_WEBGPU = 'fp32';
const DTYPE_WASM = 'q8';
// Multi-word sentence with mixed punctuation: makes the first warmup
// generation exercise a wider set of ORT kernel/WebGPU shader shapes so
// the user's first real sentence doesn't pay graph/shader compilation cost.
const WARMUP_TEXT = 'Hello, this warms up the speech engine.';

interface KokoroTtsInstance {
  generate(
    text: string,
    options: { voice: string }
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

interface KokoroProgressEvent {
  status?: string;
  loaded?: number;
  total?: number;
}

export interface WorkerContext {
  postMessage(msg: WorkerOutbound, transfer?: Transferable[]): void;
}

export function createWorkerHandler(ctx: WorkerContext): (msg: WorkerInbound) => Promise<void> {
  let tts: KokoroTtsInstance | null = null;
  let generationChain: Promise<void> = Promise.resolve();
  const cancelled = new Set<string>();

  async function handleLoad(requestId: string): Promise<void> {
    try {
      const preferred = await detectDevice();
      // dtype is pinned by the *detected* device, not by the device we end
      // up running on. WebGPU→WASM fallback keeps fp32 so the cached fp32
      // download is reused rather than triggering a second q8 download.
      const dtype = preferred === 'webgpu' ? DTYPE_WEBGPU : DTYPE_WASM;
      const tryLoad = (device: 'wasm' | 'webgpu'): Promise<KokoroTtsInstance> =>
        (
          KokoroTTS.from_pretrained as unknown as (
            modelId: string,
            options: {
              dtype: string;
              device: 'wasm' | 'webgpu';
              progress_callback: (event: KokoroProgressEvent) => void;
            }
          ) => Promise<KokoroTtsInstance>
        )(MODEL_ID, {
          dtype,
          device,
          progress_callback: (event) => {
            if (typeof event.loaded === 'number' && typeof event.total === 'number') {
              ctx.postMessage({
                type: 'loadProgress',
                requestId,
                loaded: event.loaded,
                total: event.total,
              });
            }
          },
        });

      try {
        tts = await tryLoad(preferred);
      } catch (error) {
        // WebGPU can advertise an adapter but still fail at load time (driver,
        // browser flag, runtime backend). Fall back to WASM. Re-throw if we
        // were already on WASM — nothing else to try.
        if (preferred !== 'webgpu') throw error;
        tts = await tryLoad('wasm');
      }

      ctx.postMessage({ type: 'loadDone', requestId });
    } catch (error) {
      ctx.postMessage({
        type: 'loadError',
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleWarmup(requestId: string, voice: string): Promise<void> {
    if (tts === null) {
      ctx.postMessage({
        type: 'warmupError',
        requestId,
        message: 'TTS engine is not loaded',
      });
      return;
    }
    try {
      await tts.generate(WARMUP_TEXT, { voice });
      ctx.postMessage({ type: 'warmupDone', requestId });
    } catch (error) {
      ctx.postMessage({
        type: 'warmupError',
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function runSpeak(requestId: string, text: string, voice: string): Promise<void> {
    if (cancelled.has(requestId)) {
      cancelled.delete(requestId);
      return;
    }
    if (tts === null) {
      ctx.postMessage({
        type: 'speakError',
        requestId,
        message: 'TTS engine is not loaded',
      });
      return;
    }
    try {
      const result = await tts.generate(text, { voice });
      if (cancelled.has(requestId)) {
        cancelled.delete(requestId);
        return;
      }
      ctx.postMessage(
        {
          type: 'speakReady',
          requestId,
          audio: result.audio,
          samplingRate: result.sampling_rate,
        },
        [result.audio.buffer]
      );
    } catch (error) {
      ctx.postMessage({
        type: 'speakError',
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function handleSpeak(requestId: string, text: string, voice: string): void {
    // Chain generations so they execute one at a time inside the worker —
    // the underlying ONNX session is a single instance and can't be invoked
    // concurrently. Each `then()` step waits for the previous to finish.
    // Returns void: enqueue is synchronous, execution happens later on the
    // chain. Callers must not await this — that would block waiting for
    // every prior generation to finish before the next message can be
    // processed (e.g., a `cancel` message couldn't get through).
    // eslint-disable-next-line promise/prefer-await-to-then -- explicit chain: appending preserves enqueue order without awaiting
    generationChain = generationChain.then(() => runSpeak(requestId, text, voice));
  }

  function handleCancel(requestId: string): void {
    cancelled.add(requestId);
  }

  return async function handleMessage(msg: WorkerInbound): Promise<void> {
    switch (msg.type) {
      case 'load': {
        await handleLoad(msg.requestId);
        return;
      }
      case 'warmup': {
        await handleWarmup(msg.requestId, msg.voice);
        return;
      }
      case 'speak': {
        handleSpeak(msg.requestId, msg.text, msg.voice);
        return;
      }
      case 'cancel': {
        handleCancel(msg.requestId);
        return;
      }
    }
  };
}

// Auto-register the listener when running inside a real DedicatedWorker.
// `importScripts` is worker-only and is undefined in vitest's environment,
// so this guard keeps tests from accidentally setting up a global handler.
declare const importScripts: unknown;
const inWorker = typeof importScripts === 'function';
if (inWorker) {
  const ctx: WorkerContext = {
    postMessage(msg, transfer = []) {
      (
        globalThis as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }
      ).postMessage(msg, transfer);
    },
  };
  const handler = createWorkerHandler(ctx);
  // eslint-disable-next-line sonarjs/post-message -- dedicated worker only receives messages from its parent window (the same origin); no need to verify origin
  self.addEventListener('message', (event: MessageEvent) => {
    void handler((event as MessageEvent<WorkerInbound>).data);
  });
}
