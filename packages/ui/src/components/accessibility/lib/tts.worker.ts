// Dedicated Web Worker that hosts the kokoro-js KokoroTTS instance and its
// underlying @huggingface/transformers + onnxruntime-web runtime. The
// engine in tts-engine.ts (main thread) spawns a pool of these workers and
// dispatches one sentence at a time per worker; each worker emits
// `workerReady` after every speak/warmup completion so the engine can mark
// the slot idle and dispatch the next queued sentence.
//
// The handler logic is exported as `createWorkerHandler(ctx)` so tests can
// drive it without spawning a real worker. The worker globals are wired
// up at module bottom, guarded so the test environment (vitest jsdom) does
// not accidentally register a top-level listener.
//
// kokoro-js is imported statically: this module only loads inside the
// dedicated worker thread (main thread imports nothing from kokoro-js),
// so there's no module-graph pollution concern. Tests mock the import
// via vi.mock(). The worker is built as an ES module, which the repo
// requires rather than avoids (WORKER_BUILD_OPTIONS in the shared build
// config): the classic-worker wrapper corrupts `new.target`, which the
// transformers dependency loaded here needs intact.
//
// This file's path is also named as a dependency-scan entry by both app
// build configs, because the dev scanner cannot see through the worker's
// `new URL` construction and would otherwise discover kokoro-js only on the
// first TTS click.

import { AutoTokenizer, StyleTextToSpeech2Model, env as modelEnv } from '@huggingface/transformers';
import { KokoroTTS, env } from 'kokoro-js';

import { TTS_MODEL_DOWNLOAD_BYTES, ORT_WASM_PATH } from '@hushbox/shared';
import {
  MODEL_WEIGHTS_VERSION,
  TTS_MODEL_ID,
  modelWeightsRoutePath,
} from '@hushbox/shared/model-weights';
import { requireEnv } from '@hushbox/shared/require-env';

import type { TtsVoice } from '@hushbox/shared';
import type { ProgressCallback } from '@huggingface/transformers';
import type { WorkerInbound, WorkerOutbound } from './tts-worker-protocol';

// Pin onnxruntime-web's WASM location so the deployed CSP can enclose every
// fetch the model download makes. Its default is a third-party jsdelivr CDN
// URL; pointing it at a same-origin path (where the build self-hosts the
// matching .wasm/.mjs) keeps the runtime same-origin with no CDN host in the
// policy. kokoro-js re-exports the @huggingface/transformers `env` as a thin
// wrapper exposing ONLY this `wasmPaths` setter, so the wrapper is what this
// line must go through; the host settings below are on the transformers env the
// wrapper writes into, which is the same object only while one copy of
// transformers is in the tree (pinned by a test).
env.wasmPaths = ORT_WASM_PATH;

// The origin serving the model objects: the API, whose own model-weights route
// answers for every weight, tokenizer, config and voice file. Absent, there is
// no address to load from and no default worth falling back to — the Hugging
// Face hub the library would otherwise reach is no longer in the app's CSP.
const apiOrigin = requireEnv('VITE_API_URL', import.meta.env['VITE_API_URL']);

// transformers composes `remoteHost` + `remotePathTemplate` + the file name,
// substituting `{model}` with the id handed to `from_pretrained`. The path
// shape belongs to the serving route, so it comes from the builder that owns
// it; the empty file name leaves the template ending at the directory the
// library then appends each file to.
modelEnv.remoteHost = apiOrigin;
modelEnv.remotePathTemplate = modelWeightsRoutePath('{model}', MODEL_WEIGHTS_VERSION, '');

// kokoro-js hardcodes the hub URL of every voice `.bin` in its compiled dist and
// honours no host setting, so a vendored patch resolves that URL's base from
// this global instead and throws when it is unset. Setting it at module scope
// puts it in place before any handler runs, and so before any voice load.
(globalThis as Record<string, unknown>)['__HUSHBOX_TTS_VOICE_BASE__'] = new URL(
  modelWeightsRoutePath(TTS_MODEL_ID, MODEL_WEIGHTS_VERSION, ''),
  apiOrigin
).href;

// q8 on WASM keeps the download to ~90 MB (vs ~330 MB at fp32). The CPU
// can't take advantage of full-precision math anyway, and the worker pool
// delivers comparable throughput on WASM — fp32/WebGPU support was removed.
const DTYPE = 'q8' as const;
const DEVICE = 'wasm' as const;
// Multi-word sentence with mixed punctuation: makes the first warmup
// generation exercise a wider set of ORT kernel shapes so the user's
// first real sentence doesn't pay graph-compilation cost.
const WARMUP_TEXT = 'Hello, this warms up the speech engine.';

/** kokoro's own voice ids, read off the call it accepts rather than re-listed here. */
type KokoroVoice = NonNullable<NonNullable<Parameters<KokoroTTS['generate']>[1]>['voice']>;

interface KokoroTtsInstance {
  generate(
    text: string,
    options: { voice: KokoroVoice }
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

interface KokoroProgressEvent {
  status?: string;
  file?: string;
  loaded?: number;
  total?: number;
}

export interface WorkerContext {
  postMessage(msg: WorkerOutbound, transfer?: Transferable[]): void;
}

/**
 * Build the pair `KokoroTTS` wraps, rather than calling its own
 * `from_pretrained`: that helper fixes the Hub's `onnx/` subfolder, and the
 * route serving our objects reads the file name as one path segment and answers
 * 404 for anything nested. Everything else here is what kokoro's helper does.
 */
async function loadTts(progress_callback: ProgressCallback): Promise<KokoroTtsInstance> {
  const [model, tokenizer] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(TTS_MODEL_ID, {
      dtype: DTYPE,
      device: DEVICE,
      subfolder: '',
      progress_callback,
    }),
    AutoTokenizer.from_pretrained(TTS_MODEL_ID, { progress_callback }),
  ]);
  return new KokoroTTS(model as ConstructorParameters<typeof KokoroTTS>[0], tokenizer);
}

export function createWorkerHandler(ctx: WorkerContext): (msg: WorkerInbound) => Promise<void> {
  let tts: KokoroTtsInstance | null = null;
  // Serializes generations so the single ONNX session is never invoked
  // concurrently (concurrent generate() calls produce undefined behavior).
  // The engine should only ever dispatch one speak at a time per worker;
  // the chain keeps the worker correct even if a test or a future engine
  // bug double-posts.
  let generationChain: Promise<void> = Promise.resolve();
  const cancelled = new Set<string>();

  function postWorkerReady(): void {
    ctx.postMessage({ type: 'workerReady' });
  }

  async function handleLoad(requestId: string): Promise<void> {
    // transformers reports {loaded,total} PER FILE, and the hub files download
    // concurrently: config/tokenizer JSON (a few KB), the voice embedding, and
    // the q8 weights (99.4% of the bytes). Forwarding one file's pair makes the
    // bar read 100% the instant the first JSON lands, then drop to ~0% when the
    // weights start. The worker is the only layer that still has file identity
    // — the worker protocol carries none — so the download-wide sum is formed
    // here, which also keeps the accessibility widget's byte readout, rate, and
    // ETA counting one download instead of restarting per file.
    const bytesByFile = new Map<string | undefined, { loaded: number; total: number }>();

    function aggregate(): { loaded: number; total: number } {
      let loaded = 0;
      let total = 0;
      for (const file of bytesByFile.values()) {
        loaded += file.loaded;
        total += file.total;
      }
      // Floor the denominator with the known first-listen size so files the hub
      // has not announced yet cannot inflate the percentage.
      return { loaded, total: Math.max(total, TTS_MODEL_DOWNLOAD_BYTES) };
    }

    const onProgress = ((event: KokoroProgressEvent) => {
      if (typeof event.loaded === 'number' && typeof event.total === 'number') {
        bytesByFile.set(event.file, { loaded: event.loaded, total: event.total });
        ctx.postMessage({ type: 'loadProgress', requestId, ...aggregate() });
      }
    }) as ProgressCallback;

    try {
      tts = await loadTts(onProgress);
      // The floored denominator would otherwise leave consumers a few percent
      // short of complete for the whole warmup.
      const { total } = aggregate();
      ctx.postMessage({ type: 'loadProgress', requestId, loaded: total, total });
      ctx.postMessage({ type: 'loadDone', requestId });
    } catch (error) {
      ctx.postMessage({
        type: 'loadError',
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleWarmup(requestId: string, voice: TtsVoice): Promise<void> {
    if (tts === null) {
      ctx.postMessage({
        type: 'warmupError',
        requestId,
        message: 'TTS engine is not loaded',
      });
      postWorkerReady();
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
    postWorkerReady();
  }

  async function runSpeak(requestId: string, text: string, voice: TtsVoice): Promise<void> {
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

  function handleSpeak(requestId: string, text: string, voice: TtsVoice): void {
    // Enqueue is synchronous; execution happens later on the chain so a
    // `cancel` message can still be processed while a generation is running.
    // workerReady fires after every speak attempt — success, failure, or
    // cancelled-before-start — so the engine can decrement the slot's
    // inflight counter without special-casing.
    // eslint-disable-next-line promise/prefer-await-to-then, promise/always-return -- explicit chain: appending preserves enqueue order without awaiting; the async callback's implicit return is a Promise<void>
    generationChain = generationChain.then(async () => {
      await runSpeak(requestId, text, voice);
      postWorkerReady();
    });
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

/**
 * The dedicated-worker global. Its `postMessage` takes a transfer list, which
 * the window one the DOM lib types `globalThis` with does not.
 */
interface TransferringScope {
  postMessage: (message: unknown, transfer: Transferable[]) => void;
}

function isTransferringScope(value: unknown): value is TransferringScope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'postMessage' in value &&
    typeof value.postMessage === 'function'
  );
}

if (inWorker) {
  const scope: unknown = globalThis;
  if (!isTransferringScope(scope)) {
    throw new TypeError('tts worker: the worker global exposes no postMessage to post through');
  }
  const ctx: WorkerContext = {
    postMessage(msg, transfer = []) {
      scope.postMessage(msg, transfer);
    },
  };
  const handler = createWorkerHandler(ctx);
  // eslint-disable-next-line sonarjs/post-message -- dedicated worker only receives messages from its parent window (the same origin); no need to verify origin
  self.addEventListener('message', (event: MessageEvent) => {
    void handler((event as MessageEvent<WorkerInbound>).data);
  });
}
