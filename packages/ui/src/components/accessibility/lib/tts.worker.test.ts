import { describe, it, expect, vi, beforeEach } from 'vitest';

import { TTS_MODEL_DOWNLOAD_BYTES, ORT_WASM_PATH } from '@hushbox/shared';
import {
  MODEL_WEIGHTS_VERSION,
  TTS_MODEL_FILES,
  TTS_MODEL_ID,
  modelWeightsRoutePath,
} from '@hushbox/shared/model-weights';

import { createWorkerHandler, type WorkerContext } from './tts.worker';
import type { PretrainedModelOptions } from '@huggingface/transformers';
import type { WorkerOutbound } from './tts-worker-protocol';

const { generateMock, fromPretrainedMock, tokenizerFromPretrainedMock, mockEnv, mockModelEnv } =
  vi.hoisted(() => ({
    generateMock: vi.fn(),
    fromPretrainedMock: vi.fn(),
    tokenizerFromPretrainedMock: vi.fn(),
    // Mirrors the REAL kokoro-js `env` export: a thin wrapper exposing ONLY a
    // settable `wasmPaths`. It has no `backends` and no `remoteHost`. Grounded
    // against the real module by the "real kokoro-js env API" test below, so a
    // regression to `env.backends.onnx.wasm.wasmPaths` throws here at the
    // worker's import exactly as it does in production.
    mockEnv: { wasmPaths: '' } as { wasmPaths: string },
    // The transformers env carrying the model host settings kokoro-js's own
    // wrapper does not expose.
    mockModelEnv: { remoteHost: '', remotePathTemplate: '' } as {
      remoteHost: string;
      remotePathTemplate: string;
    },
  }));

vi.mock('kokoro-js', () => ({
  // The worker constructs the pair itself rather than calling
  // `KokoroTTS.from_pretrained`, so the export under test is the constructor.
  KokoroTTS: class {
    generate = generateMock;
  },
  env: mockEnv,
}));

vi.mock('@huggingface/transformers', () => ({
  env: mockModelEnv,
  StyleTextToSpeech2Model: { from_pretrained: fromPretrainedMock },
  AutoTokenizer: { from_pretrained: tokenizerFromPretrainedMock },
}));

/** The origin the app was built against, which is where the artifacts are served. */
const API_ORIGIN = import.meta.env['VITE_API_URL'] as string;

interface CapturedPost {
  msg: WorkerOutbound;
  transfer: Transferable[];
}

function captureContext(): { ctx: WorkerContext; posts: CapturedPost[] } {
  const posts: CapturedPost[] = [];
  return {
    posts,
    ctx: {
      postMessage(msg: WorkerOutbound, transfer: Transferable[] = []): void {
        posts.push({ msg, transfer });
      },
    },
  };
}

interface ProgressEventLike {
  status?: string;
  file?: string;
  loaded?: number;
  total?: number;
}

type LoadProgressMsg = Extract<WorkerOutbound, { type: 'loadProgress' }>;

// Drives one load whose progress events fire *while* from_pretrained is
// pending, as the real transformers hub does. `duringLoad` is only the
// progress emitted before the download finished, so assertions about the
// in-flight sequence are not perturbed by the completion emission.
async function runLoad(
  requestId: string,
  events: ProgressEventLike[]
): Promise<{ posts: CapturedPost[]; duringLoad: LoadProgressMsg[] }> {
  const { ctx, posts } = captureContext();
  const handler = createWorkerHandler(ctx);
  let postCountWhenDownloadFinished = 0;
  fromPretrainedMock.mockImplementationOnce((_id, options) => {
    const emit = options.progress_callback as (event: ProgressEventLike) => void;
    for (const event of events) emit(event);
    postCountWhenDownloadFinished = posts.length;
    return Promise.resolve({});
  });
  await handler({ type: 'load', requestId });
  const duringLoad = posts
    .slice(0, postCountWhenDownloadFinished)
    .filter((p) => p.msg.type === 'loadProgress')
    .map((p) => p.msg as LoadProgressMsg);
  return { posts, duringLoad };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('model env configuration', () => {
  // The worker configures the kokoro-js env at import time, so this reads the
  // mock env mutated when this file imported ./tts.worker above. Because the
  // mock env has the real single-`wasmPaths` shape, the worker importing
  // without throwing already proves it uses the wrapper setter and not the
  // nonexistent `env.backends.onnx.wasm.wasmPaths` path.
  it('sets env.wasmPaths to the shared same-origin ORT path at import (no throw)', () => {
    expect(mockEnv.wasmPaths).toBe(ORT_WASM_PATH);
  });

  it('points the model host at the API origin', () => {
    expect(mockModelEnv.remoteHost).toBe(API_ORIGIN);
  });

  it('builds the remote path template from the shared artifact contract', () => {
    // transformers substitutes `{model}` with the id it is handed, then appends
    // the file name; the rest of the shape is the serving route's, so it is
    // taken from the builder that owns it rather than spelled out again.
    expect(mockModelEnv.remotePathTemplate).toBe(
      modelWeightsRoutePath('{model}', MODEL_WEIGHTS_VERSION, '')
    );
  });

  it('names the voice base as the API-origin directory the voice objects rest in', () => {
    // The patched kokoro-js reads this global at voice-load time and throws
    // when it is unset, so the worker sets it at import — before any handler
    // can run, let alone reach a voice.
    expect((globalThis as Record<string, unknown>)['__HUSHBOX_TTS_VOICE_BASE__']).toBe(
      new URL(modelWeightsRoutePath(TTS_MODEL_ID, MODEL_WEIGHTS_VERSION, ''), API_ORIGIN).href
    );
  });
});

describe('missing model origin', () => {
  it('refuses to load at all when no API origin names where the model is served', async () => {
    // Fail fast rather than fall back: the only other address the library knows
    // is the Hugging Face hub, which the app's CSP no longer allows, so a
    // fallback would buy a download that is refused in the browser instead of
    // an error the build can see.
    vi.stubEnv('VITE_API_URL', '');
    vi.resetModules();
    try {
      await expect(import('./tts.worker')).rejects.toThrow('VITE_API_URL');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      await import('./tts.worker');
    }
  });
});

describe('real kokoro-js env API', () => {
  // Grounds the mock above in reality: kokoro-js@1.2.x re-exports the
  // @huggingface/transformers env wrapped down to a single `wasmPaths`
  // getter/setter. If a future kokoro-js grows a real `backends` tree this
  // fails, forcing the mock (and any worker code) to be re-checked against the
  // real API rather than a fabricated shape.
  it('exposes only a settable wasmPaths — the shape the worker must target', async () => {
    const actual = await vi.importActual<typeof import('kokoro-js')>('kokoro-js');
    expect(Object.keys(actual.env)).toEqual(Object.keys(mockEnv));
    expect('backends' in actual.env).toBe(false);
    // The path the worker MUST NOT use throws on the real env; this is exactly
    // why the fabricated `backends.onnx.wasm` mock was false-green before.
    expect(
      () => (actual.env as unknown as { backends: { onnx: unknown } }).backends.onnx
    ).toThrow();
  });

  // The worker points the model download at our origin through the
  // `@huggingface/transformers` env, which only works while that env is the
  // very object kokoro-js loads. Two copies of transformers in the tree would
  // leave kokoro reading its defaults and every model fetch going back to the
  // Hugging Face hub, which the app's CSP no longer allows — silently, since a
  // failed model load degrades without a sound. Writing through kokoro's own
  // wrapper and reading the result off the transformers env proves one object.
  it('shares one transformers env with kokoro-js', async () => {
    const kokoro = await vi.importActual<typeof import('kokoro-js')>('kokoro-js');
    const transformers = await vi.importActual<typeof import('@huggingface/transformers')>(
      '@huggingface/transformers'
    );
    const probe = '/single-transformers-instance/';
    const original = kokoro.env.wasmPaths;
    kokoro.env.wasmPaths = probe;
    try {
      expect(
        (transformers.env.backends as { onnx: { wasm: { wasmPaths: string } } }).onnx.wasm.wasmPaths
      ).toBe(probe);
    } finally {
      kokoro.env.wasmPaths = original;
    }
  });
});

describe('the installed library, driven for real', () => {
  /**
   * Every assertion above this point runs against a mocked
   * `@huggingface/transformers`, so what they pin is what the worker *hands*
   * the library — never what the library *does* with it. The library owns the
   * whole address: it joins `remoteHost`, `remotePathTemplate` and the file
   * name, and appends the dtype suffix to the model file name itself. A bump
   * that changes any of that leaves every mocked assertion green while every
   * artifact 404s, and read-aloud then never speaks with nothing reporting why.
   *
   * So this drives the installed library with the settings and options the
   * worker itself just handed the mock, over a stubbed `fetch`, and asserts the
   * addresses it asks for are the ones the shared route-path builder names. The
   * whole set, not a sample: a suffix or subfolder change moves some artifacts
   * and not others. The voice blobs are absent by construction — kokoro-js
   * hardcodes their URL and consults no library setting, which is why a patch
   * redirects them and a separate test pins where.
   */
  interface RealEnv extends Record<string, unknown> {
    remoteHost: string;
    remotePathTemplate: string;
    useCustomCache: boolean;
    customCache: unknown;
  }

  /**
   * An always-empty cache, which the library consults before every other
   * caching backend. vitest runs on Node, where the library's filesystem cache
   * would both hide the request this test exists to observe and write model
   * files into `node_modules`.
   */
  const EMPTY_CACHE = {
    match: (): Promise<void> => Promise.resolve(),
    put: (): Promise<void> => Promise.resolve(),
  };

  /**
   * The one artifact that resolves, and only so the load reaches the weights
   * request behind it — nothing here is model bytes. The length is declared
   * because the library warns when a response withholds it.
   */
  const configResponse = (): Response => {
    const config = { model_type: 'style_text_to_speech_2' };
    return Response.json(config, {
      headers: {
        'content-length': String(new TextEncoder().encode(JSON.stringify(config)).length),
      },
    });
  };

  it('asks the shared route path for every published speech artifact', async () => {
    fromPretrainedMock.mockReset();
    tokenizerFromPretrainedMock.mockReset();
    fromPretrainedMock.mockResolvedValue({});
    tokenizerFromPretrainedMock.mockResolvedValue({});
    const { ctx } = captureContext();
    await createWorkerHandler(ctx)({ type: 'load', requestId: 'REAL' });
    const [modelId, modelOptions] = fromPretrainedMock.mock.calls[0]! as [
      string,
      PretrainedModelOptions,
    ];
    const [tokenizerId, tokenizerOptions] = tokenizerFromPretrainedMock.mock.calls[0]! as [
      string,
      Record<string, unknown>,
    ];

    const real = await vi.importActual<typeof import('@huggingface/transformers')>(
      '@huggingface/transformers'
    );
    const env = real.env as unknown as RealEnv;
    const restore = { ...env };
    const requested: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      requested.push(url);
      // Both loads are expected to fail once their addresses are recorded.
      return Promise.resolve(
        url.endsWith('/config.json') ? configResponse() : new Response('absent', { status: 404 })
      );
    }) as typeof globalThis.fetch;

    try {
      env.remoteHost = mockModelEnv.remoteHost;
      env.remotePathTemplate = mockModelEnv.remotePathTemplate;
      env.useCustomCache = true;
      env.customCache = EMPTY_CACHE;
      try {
        await real.AutoTokenizer.from_pretrained(tokenizerId, tokenizerOptions);
      } catch {
        // Expected: the tokenizer files 404. Both were requested first.
      }
      try {
        // `device` names an execution provider, never an address, and
        // onnxruntime-node publishes no wasm provider — so the drive drops it
        // and lets the library pick the provider its own runtime offers.
        // Everything the address is built from is the worker's own.
        const addressing: PretrainedModelOptions = { ...modelOptions };
        delete addressing.device;
        await real.StyleTextToSpeech2Model.from_pretrained(modelId, addressing);
      } catch {
        // Expected: the weights 404 once their address has been recorded.
      }
    } finally {
      globalThis.fetch = originalFetch;
      Object.assign(env, restore);
    }

    const published = Object.values(TTS_MODEL_FILES).map(
      (file) => `${API_ORIGIN}${modelWeightsRoutePath(TTS_MODEL_ID, MODEL_WEIGHTS_VERSION, file)}`
    );
    const alphabetically = (a: string, b: string): number => a.localeCompare(b);
    expect(requested.toSorted(alphabetically)).toEqual(published.toSorted(alphabetically));
  });
});
describe('createWorkerHandler', () => {
  beforeEach(() => {
    fromPretrainedMock.mockReset();
    tokenizerFromPretrainedMock.mockReset();
    generateMock.mockReset();
    fromPretrainedMock.mockResolvedValue({});
    tokenizerFromPretrainedMock.mockResolvedValue({});
    generateMock.mockResolvedValue({
      audio: new Float32Array(100),
      sampling_rate: 24_000,
    });
  });

  describe('load', () => {
    it('loads the weights with the shared model id, q8 dtype, and wasm device', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L1' });
      expect(fromPretrainedMock).toHaveBeenCalledTimes(1);
      const [modelId, options] = fromPretrainedMock.mock.calls[0]!;
      expect(modelId).toBe(TTS_MODEL_ID);
      expect(options.dtype).toBe('q8');
      expect(options.device).toBe('wasm');
      const types = posts.map((p) => p.msg.type);
      expect(types).toContain('loadDone');
    });

    it('asks for the weights with no subfolder, so the object name stays one segment', async () => {
      const { ctx } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L2' });
      // The Hub nests weights under `onnx/`; the serving route reads `:file` as
      // a single segment and 404s anything nested, so the default has to go.
      const [, options] = fromPretrainedMock.mock.calls[0]!;
      expect(options.subfolder).toBe('');
    });

    it('loads the tokenizer under the same model id as the weights', async () => {
      const { ctx } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L3' });
      expect(tokenizerFromPretrainedMock).toHaveBeenCalledTimes(1);
      expect(tokenizerFromPretrainedMock.mock.calls[0]![0]).toBe(TTS_MODEL_ID);
    });

    it('posts loadDone with the matching requestId on success', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L42' });
      const done = posts.find((p) => p.msg.type === 'loadDone');
      expect(
        (done?.msg as Extract<WorkerOutbound, { type: 'loadDone' }> | undefined)?.requestId
      ).toBe('L42');
    });

    // Amended from a test that pinned verbatim per-file forwarding: the hub
    // reports {loaded,total} per file, so forwarding one file's pair is the
    // bug (a few-KB JSON reads 100% on its own). The download-wide sum is the
    // contract now.
    it('sums progress across files into one download-wide loaded/total pair', async () => {
      const { duringLoad } = await runLoad('P1', [
        { status: 'progress', file: 'config.json', loaded: 1200, total: 1200 },
        {
          status: 'progress',
          file: 'onnx/model_quantized.onnx',
          loaded: 65_536,
          total: 92_361_116,
        },
      ]);
      expect(duringLoad.map((m) => ({ loaded: m.loaded, total: m.total }))).toEqual([
        { loaded: 1200, total: TTS_MODEL_DOWNLOAD_BYTES },
        { loaded: 66_736, total: TTS_MODEL_DOWNLOAD_BYTES },
      ]);
      expect(duringLoad.every((m) => m.requestId === 'P1')).toBe(true);
    });

    it('never reports a near-complete download while the weights are still arriving', async () => {
      const { duringLoad } = await runLoad('P2', [
        { status: 'progress', file: 'config.json', loaded: 1200, total: 1200 },
        {
          status: 'progress',
          file: 'onnx/model_quantized.onnx',
          loaded: 65_536,
          total: 92_361_116,
        },
        {
          status: 'progress',
          file: 'onnx/model_quantized.onnx',
          loaded: 46_000_000,
          total: 92_361_116,
        },
      ]);
      const percentages = duringLoad.map((m) => (m.loaded / m.total) * 100);
      expect(percentages[0]).toBeLessThan(5);
      expect(percentages).toEqual(percentages.toSorted((a, b) => a - b));
    });

    it('reports a complete download before loadDone so no consumer is left below 100%', async () => {
      const { posts } = await runLoad('P3', [
        { status: 'progress', file: 'config.json', loaded: 1200, total: 1200 },
        {
          status: 'progress',
          file: 'onnx/model_quantized.onnx',
          loaded: 65_536,
          total: 92_361_116,
        },
      ]);
      const doneIndex = posts.findIndex((p) => p.msg.type === 'loadDone');
      const beforeDone = posts.slice(0, doneIndex).filter((p) => p.msg.type === 'loadProgress');
      const last = beforeDone.at(-1)!.msg as LoadProgressMsg;
      expect(last.loaded).toBe(TTS_MODEL_DOWNLOAD_BYTES);
      expect(last.total).toBe(TTS_MODEL_DOWNLOAD_BYTES);
    });

    it('counts unnamed progress events as one file rather than accumulating them', async () => {
      const { duringLoad } = await runLoad('P4', [
        { status: 'progress', loaded: 10, total: 100 },
        { status: 'progress', loaded: 50, total: 100 },
      ]);
      expect(duringLoad.map((m) => m.loaded)).toEqual([10, 50]);
    });

    it('ignores progress events without numeric loaded/total fields', async () => {
      const { duringLoad } = await runLoad('X1', [
        { status: 'initiate', file: 'config.json' },
        { status: 'progress', file: 'config.json', loaded: 10 },
      ]);
      expect(duringLoad).toHaveLength(0);
    });

    it('posts loadError when from_pretrained throws', async () => {
      fromPretrainedMock.mockRejectedValueOnce(new Error('network unreachable'));

      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'E1' });

      const errorMsg = posts.find((p) => p.msg.type === 'loadError');
      expect(errorMsg).toBeDefined();
      expect((errorMsg!.msg as Extract<WorkerOutbound, { type: 'loadError' }>).message).toContain(
        'network unreachable'
      );
    });

    it('does NOT post workerReady after loadDone — warmup is auto-issued next, workerReady waits for warmupDone', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L-NOREADY' });
      const loadDoneIndex = posts.findIndex((p) => p.msg.type === 'loadDone');
      const workerReadyAfter = posts
        .slice(loadDoneIndex + 1)
        .find((p) => p.msg.type === 'workerReady');
      expect(workerReadyAfter).toBeUndefined();
    });
  });

  describe('warmup', () => {
    it('calls tts.generate once and posts warmupDone without sending audio back', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockClear();
      await handler({ type: 'warmup', requestId: 'W1', voice: 'af_heart' });
      expect(generateMock).toHaveBeenCalledTimes(1);
      const [warmupText, warmupOptions] = generateMock.mock.calls[0]!;
      // Multi-word sentence with mixed punctuation: forces ORT to compile
      // more kernel-shape variants up front so the first real generation
      // doesn't pay a graph-compilation tax.
      expect(typeof warmupText).toBe('string');
      expect((warmupText as string).split(/\s+/).length).toBeGreaterThanOrEqual(5);
      expect(warmupText as string).toMatch(/[,;:]/);
      expect(warmupText as string).toMatch(/[.!?]$/);
      expect(warmupOptions).toEqual({ voice: 'af_heart' });
      const done = posts.find((p) => p.msg.type === 'warmupDone');
      expect(
        (done?.msg as Extract<WorkerOutbound, { type: 'warmupDone' }> | undefined)?.requestId
      ).toBe('W1');
      const ready = posts.find((p) => p.msg.type === 'speakReady');
      expect(ready).toBeUndefined();
    });

    it('posts workerReady after warmupDone so the engine can mark the slot idle', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      await handler({ type: 'warmup', requestId: 'WR1', voice: 'af_heart' });
      await flush();
      const warmupDoneIndex = posts.findIndex(
        (p) => p.msg.type === 'warmupDone' && p.msg.requestId === 'WR1'
      );
      expect(warmupDoneIndex).toBeGreaterThanOrEqual(0);
      const readyAfter = posts.slice(warmupDoneIndex + 1).find((p) => p.msg.type === 'workerReady');
      expect(readyAfter).toBeDefined();
    });

    it('posts workerReady after warmupError so the engine can mark the slot idle', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockRejectedValueOnce(new Error('warmup boom'));
      await handler({ type: 'warmup', requestId: 'WR-ERR', voice: 'af_heart' });
      await flush();
      const errIndex = posts.findIndex(
        (p) => p.msg.type === 'warmupError' && p.msg.requestId === 'WR-ERR'
      );
      expect(errIndex).toBeGreaterThanOrEqual(0);
      const readyAfter = posts.slice(errIndex + 1).find((p) => p.msg.type === 'workerReady');
      expect(readyAfter).toBeDefined();
    });

    it('uses the voice passed in the warmup message so the user-selected voice embedding is fetched up front', async () => {
      const { ctx } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockClear();
      await handler({ type: 'warmup', requestId: 'W2', voice: 'am_michael' });
      expect(generateMock).toHaveBeenCalledTimes(1);
      const [, warmupOptions] = generateMock.mock.calls[0]!;
      expect(warmupOptions).toEqual({ voice: 'am_michael' });
    });

    it('posts warmupError if generate throws', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockRejectedValueOnce(new Error('oom'));
      await handler({ type: 'warmup', requestId: 'W2', voice: 'af_heart' });
      const err = posts.find((p) => p.msg.type === 'warmupError');
      expect(err).toBeDefined();
      expect((err!.msg as Extract<WorkerOutbound, { type: 'warmupError' }>).message).toContain(
        'oom'
      );
    });
  });

  describe('speak', () => {
    it('calls generate with the requested text and voice', async () => {
      const { ctx } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockClear();
      await handler({ type: 'speak', requestId: 'S1', text: 'hello', voice: 'af_heart' });
      await flush();
      expect(generateMock).toHaveBeenCalledWith('hello', { voice: 'af_heart' });
    });

    it('posts speakReady with the audio buffer as transferable', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      const audio = new Float32Array(64);
      generateMock.mockResolvedValueOnce({ audio, sampling_rate: 24_000 });
      await handler({ type: 'speak', requestId: 'S2', text: 'go', voice: 'af_heart' });
      await flush();
      const ready = posts.find((p) => p.msg.type === 'speakReady');
      expect(ready).toBeDefined();
      const readyMsg = ready!.msg as Extract<WorkerOutbound, { type: 'speakReady' }>;
      expect(readyMsg.requestId).toBe('S2');
      expect(readyMsg.samplingRate).toBe(24_000);
      expect(readyMsg.audio).toBe(audio);
      expect(ready!.transfer).toContain(audio.buffer);
    });

    it('processes speak messages sequentially in enqueue order', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });

      const order: string[] = [];
      generateMock.mockImplementation(async (text: string) => {
        order.push(`start:${text}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end:${text}`);
        return { audio: new Float32Array(10), sampling_rate: 24_000 };
      });

      await handler({ type: 'speak', requestId: 'A', text: 'a', voice: 'af_heart' });
      await handler({ type: 'speak', requestId: 'B', text: 'b', voice: 'af_heart' });
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Sequential: 'a' must finish before 'b' starts.
      expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
      const readys = posts
        .filter((p) => p.msg.type === 'speakReady')
        .map((r) => r.msg as Extract<WorkerOutbound, { type: 'speakReady' }>);
      expect(readys.map((r) => r.requestId)).toEqual(['A', 'B']);
    });

    it('posts speakError when generate throws', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockRejectedValueOnce(new Error('inference died'));
      await handler({ type: 'speak', requestId: 'E', text: 'x', voice: 'af_heart' });
      await flush();
      const err = posts.find((p) => p.msg.type === 'speakError');
      expect(err).toBeDefined();
      const errMsg = err!.msg as Extract<WorkerOutbound, { type: 'speakError' }>;
      expect(errMsg.requestId).toBe('E');
      expect(errMsg.message).toContain('inference died');
    });

    it('posts workerReady after speakReady so the engine can dispatch the next queued sentence', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      await handler({ type: 'speak', requestId: 'SR1', text: 'a', voice: 'af_heart' });
      await flush();
      const readyIndex = posts.findIndex(
        (p) => p.msg.type === 'speakReady' && p.msg.requestId === 'SR1'
      );
      expect(readyIndex).toBeGreaterThanOrEqual(0);
      const workerReadyAfter = posts
        .slice(readyIndex + 1)
        .find((p) => p.msg.type === 'workerReady');
      expect(workerReadyAfter).toBeDefined();
    });

    it('posts workerReady after speakError so the engine still marks the slot idle on failure', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockRejectedValueOnce(new Error('boom'));
      await handler({ type: 'speak', requestId: 'SE1', text: 'x', voice: 'af_heart' });
      await flush();
      const errIndex = posts.findIndex(
        (p) => p.msg.type === 'speakError' && p.msg.requestId === 'SE1'
      );
      expect(errIndex).toBeGreaterThanOrEqual(0);
      const workerReadyAfter = posts.slice(errIndex + 1).find((p) => p.msg.type === 'workerReady');
      expect(workerReadyAfter).toBeDefined();
    });
  });

  describe('cancel', () => {
    it('drops a cancelled request before generation starts', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });

      let blockerResolve: (() => void) | null = null;
      const blocker = new Promise<void>((resolve) => {
        blockerResolve = resolve;
      });
      generateMock.mockImplementationOnce(async () => {
        await blocker;
        return { audio: new Float32Array(10), sampling_rate: 24_000 };
      });
      generateMock.mockResolvedValue({ audio: new Float32Array(10), sampling_rate: 24_000 });

      // First speak starts immediately; second is queued behind it.
      await handler({ type: 'speak', requestId: 'A', text: 'a', voice: 'af_heart' });
      await handler({ type: 'speak', requestId: 'B', text: 'b', voice: 'af_heart' });
      await handler({ type: 'cancel', requestId: 'B' });

      blockerResolve!();
      await flush();
      await flush();

      const readys = posts
        .filter((p) => p.msg.type === 'speakReady')
        .map((r) => r.msg as Extract<WorkerOutbound, { type: 'speakReady' }>);
      const readyIds = readys.map((r) => r.requestId);
      expect(readyIds).toContain('A');
      expect(readyIds).not.toContain('B');
    });

    it('drops the audio result of a cancelled in-flight generation', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });

      let blockerResolve: (() => void) | null = null;
      const blocker = new Promise<void>((resolve) => {
        blockerResolve = resolve;
      });
      generateMock.mockImplementationOnce(async () => {
        await blocker;
        return { audio: new Float32Array(10), sampling_rate: 24_000 };
      });

      await handler({ type: 'speak', requestId: 'C', text: 'c', voice: 'af_heart' });
      await handler({ type: 'cancel', requestId: 'C' });
      blockerResolve!();
      await flush();
      await flush();

      const ready = posts.find((p) => p.msg.type === 'speakReady' && p.msg.requestId === 'C');
      expect(ready).toBeUndefined();
    });

    it('posts workerReady once a cancelled speak finishes draining (no speakReady, still ready signal)', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });

      let blockerResolve: (() => void) | null = null;
      const blocker = new Promise<void>((resolve) => {
        blockerResolve = resolve;
      });
      generateMock.mockImplementationOnce(async () => {
        await blocker;
        return { audio: new Float32Array(10), sampling_rate: 24_000 };
      });

      const readyCountBefore = posts.filter((p) => p.msg.type === 'workerReady').length;
      await handler({ type: 'speak', requestId: 'CWR', text: 'c', voice: 'af_heart' });
      await handler({ type: 'cancel', requestId: 'CWR' });
      blockerResolve!();
      await flush();
      await flush();

      const readyCountAfter = posts.filter((p) => p.msg.type === 'workerReady').length;
      expect(readyCountAfter).toBe(readyCountBefore + 1);
      const speakReady = posts.find(
        (p) => p.msg.type === 'speakReady' && p.msg.requestId === 'CWR'
      );
      expect(speakReady).toBeUndefined();
    });
  });

  describe('before the engine is loaded', () => {
    it('warmup reports the engine is not loaded and signals worker-ready', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'warmup', requestId: 'W0', voice: 'af_heart' });
      await flush();
      const warmupError = posts.find((p) => p.msg.type === 'warmupError');
      expect(warmupError?.msg).toMatchObject({
        requestId: 'W0',
        message: 'TTS engine is not loaded',
      });
      expect(posts.some((p) => p.msg.type === 'workerReady')).toBe(true);
    });

    it('speak reports the engine is not loaded', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      void handler({ type: 'speak', requestId: 'S0', text: 'hi', voice: 'af_heart' });
      await flush();
      const speakError = posts.find((p) => p.msg.type === 'speakError');
      expect(speakError?.msg).toMatchObject({
        requestId: 'S0',
        message: 'TTS engine is not loaded',
      });
    });
  });

  describe('stringifies non-Error rejections', () => {
    it('load reports a stringified non-Error failure', async () => {
      fromPretrainedMock.mockRejectedValueOnce('kaboom');
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L9' });
      const loadError = posts.find((p) => p.msg.type === 'loadError');
      expect(loadError?.msg).toMatchObject({ requestId: 'L9', message: 'kaboom' });
    });

    it('warmup reports a stringified non-Error failure', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockRejectedValueOnce('warm-boom');
      await handler({ type: 'warmup', requestId: 'W9', voice: 'af_heart' });
      const warmupError = posts.find((p) => p.msg.type === 'warmupError');
      expect(warmupError?.msg).toMatchObject({ requestId: 'W9', message: 'warm-boom' });
    });

    it('speak reports a stringified non-Error failure', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockRejectedValueOnce('speak-boom');
      void handler({ type: 'speak', requestId: 'S9', text: 'hi', voice: 'af_heart' });
      await flush();
      const speakError = posts.find((p) => p.msg.type === 'speakError');
      expect(speakError?.msg).toMatchObject({ requestId: 'S9', message: 'speak-boom' });
    });
  });
});

describe('worker auto-registration', () => {
  it('registers a message listener and wires postMessage when running inside a worker', async () => {
    const listeners: ((event: MessageEvent) => void)[] = [];
    const originalImportScripts = (globalThis as { importScripts?: unknown }).importScripts;
    const originalPostMessage = globalThis.postMessage;
    const originalAdd = self.addEventListener;
    const posted: unknown[] = [];
    (globalThis as { importScripts?: unknown }).importScripts = (): void => {};
    globalThis.postMessage = ((msg: unknown): void => {
      posted.push(msg);
    }) as typeof globalThis.postMessage;
    self.addEventListener = ((type: string, listener: (event: MessageEvent) => void): void => {
      if (type === 'message') listeners.push(listener);
    }) as typeof globalThis.addEventListener;
    fromPretrainedMock.mockResolvedValue({});
    tokenizerFromPretrainedMock.mockResolvedValue({});
    try {
      vi.resetModules();
      await import('./tts.worker');
      expect(listeners.length).toBe(1);
      // Drive a message through the registered listener; the worker context's
      // postMessage forwards to the global postMessage.
      listeners[0]!({ data: { type: 'load', requestId: 'AR' } } as MessageEvent);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(posted.length).toBeGreaterThan(0);
    } finally {
      if (originalImportScripts === undefined) {
        Reflect.deleteProperty(globalThis as object, 'importScripts');
      } else {
        (globalThis as { importScripts?: unknown }).importScripts = originalImportScripts;
      }
      globalThis.postMessage = originalPostMessage;
      self.addEventListener = originalAdd;
    }
  });

  it('refuses to register when the worker global exposes no postMessage', async () => {
    const originalImportScripts = (globalThis as { importScripts?: unknown }).importScripts;
    const originalPostMessage = Object.getOwnPropertyDescriptor(globalThis, 'postMessage');
    (globalThis as { importScripts?: unknown }).importScripts = (): void => {};
    Reflect.deleteProperty(globalThis as object, 'postMessage');
    try {
      vi.resetModules();
      await expect(import('./tts.worker')).rejects.toThrow(/postMessage/);
    } finally {
      if (originalImportScripts === undefined) {
        Reflect.deleteProperty(globalThis as object, 'importScripts');
      } else {
        (globalThis as { importScripts?: unknown }).importScripts = originalImportScripts;
      }
      if (originalPostMessage)
        Object.defineProperty(globalThis, 'postMessage', originalPostMessage);
    }
  });
});
