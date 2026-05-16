import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { WorkerOutbound } from './tts-worker-protocol';

const { generateMock, fromPretrainedMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  fromPretrainedMock: vi.fn(),
}));

vi.mock('kokoro-js', () => ({
  KokoroTTS: {
    from_pretrained: fromPretrainedMock,
  },
}));

import { createWorkerHandler, type WorkerContext } from './tts.worker';

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

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createWorkerHandler', () => {
  beforeEach(() => {
    fromPretrainedMock.mockReset();
    generateMock.mockReset();
    fromPretrainedMock.mockResolvedValue({ generate: generateMock });
    generateMock.mockResolvedValue({
      audio: new Float32Array(100),
      sampling_rate: 24_000,
    });
  });

  describe('load', () => {
    it('calls KokoroTTS.from_pretrained with the documented model id and dtype', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L1' });
      expect(fromPretrainedMock).toHaveBeenCalledTimes(1);
      const [modelId, options] = fromPretrainedMock.mock.calls[0]!;
      expect(modelId).toBe('onnx-community/Kokoro-82M-v1.0-ONNX');
      expect(options.dtype).toBe('q8');
      expect(['wasm', 'webgpu']).toContain(options.device);
      const types = posts.map((p) => p.msg.type);
      expect(types).toContain('loadDone');
    });

    it('posts loadDone with the matching requestId on success', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L42' });
      const done = posts.find((p) => p.msg.type === 'loadDone');
      expect(done?.msg.requestId).toBe('L42');
    });

    it('forwards kokoro progress events as loadProgress messages', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      let capturedProgressCallback: ((event: { loaded: number; total: number }) => void) | null =
        null;
      fromPretrainedMock.mockImplementationOnce((_id, options) => {
        capturedProgressCallback = options.progress_callback as typeof capturedProgressCallback;
        return Promise.resolve({ generate: generateMock });
      });
      await handler({ type: 'load', requestId: 'P1' });
      expect(capturedProgressCallback).not.toBeNull();
      capturedProgressCallback!({ loaded: 25, total: 100 });
      const progresses = posts.filter((p) => p.msg.type === 'loadProgress');
      expect(progresses).toHaveLength(1);
      const progressMsg = progresses[0]!.msg as Extract<WorkerOutbound, { type: 'loadProgress' }>;
      expect(progressMsg.loaded).toBe(25);
      expect(progressMsg.total).toBe(100);
      expect(progressMsg.requestId).toBe('P1');
    });

    it('ignores progress events without numeric loaded/total fields', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      let capturedProgressCallback: ((event: unknown) => void) | null = null;
      fromPretrainedMock.mockImplementationOnce((_id, options) => {
        capturedProgressCallback = options.progress_callback as typeof capturedProgressCallback;
        return Promise.resolve({ generate: generateMock });
      });
      await handler({ type: 'load', requestId: 'X1' });
      capturedProgressCallback!({ status: 'initiate' });
      capturedProgressCallback!({ status: 'progress', loaded: 10 });
      const progresses = posts.filter((p) => p.msg.type === 'loadProgress');
      expect(progresses).toHaveLength(0);
    });

    it('uses dtype fp32 when device detection picks webgpu (clean audio + 3-5x faster)', async () => {
      type WindowWithCapacitor = Window & {
        Capacitor?: { isNativePlatform?: () => boolean };
      };
      const originalGpu = (navigator as unknown as { gpu?: unknown }).gpu;
      delete (globalThis.window as WindowWithCapacitor).Capacitor;
      (navigator as unknown as { gpu?: unknown }).gpu = {
        requestAdapter: () => Promise.resolve({}),
      };

      const { ctx } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'DTYPE-GPU' });
      expect(fromPretrainedMock).toHaveBeenCalledTimes(1);
      const options = fromPretrainedMock.mock.calls[0]![1];
      expect(options.device).toBe('webgpu');
      expect(options.dtype).toBe('fp32');

      if (originalGpu === undefined) {
        delete (navigator as unknown as { gpu?: unknown }).gpu;
      } else {
        (navigator as unknown as { gpu?: unknown }).gpu = originalGpu;
      }
    });

    it('uses dtype q8 when device detection picks wasm (smaller download, quantized for CPU)', async () => {
      type WindowWithCapacitor = Window & {
        Capacitor?: { isNativePlatform?: () => boolean };
      };
      const originalGpu = (navigator as unknown as { gpu?: unknown }).gpu;
      delete (globalThis.window as WindowWithCapacitor).Capacitor;
      delete (navigator as unknown as { gpu?: unknown }).gpu;

      const { ctx } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'DTYPE-WASM' });
      expect(fromPretrainedMock).toHaveBeenCalledTimes(1);
      const options = fromPretrainedMock.mock.calls[0]![1];
      expect(options.device).toBe('wasm');
      expect(options.dtype).toBe('q8');

      if (originalGpu !== undefined) {
        (navigator as unknown as { gpu?: unknown }).gpu = originalGpu;
      }
    });

    it('webgpu→wasm fallback retains dtype fp32 so the already-downloaded model is reused', async () => {
      type WindowWithCapacitor = Window & {
        Capacitor?: { isNativePlatform?: () => boolean };
      };
      const originalGpu = (navigator as unknown as { gpu?: unknown }).gpu;
      delete (globalThis.window as WindowWithCapacitor).Capacitor;
      (navigator as unknown as { gpu?: unknown }).gpu = {
        requestAdapter: () => Promise.resolve({}),
      };

      let calls = 0;
      fromPretrainedMock.mockImplementation(() => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('GPU device init failed'));
        return Promise.resolve({ generate: generateMock });
      });

      const { ctx } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'DTYPE-FALLBACK' });

      expect(fromPretrainedMock).toHaveBeenCalledTimes(2);
      expect(fromPretrainedMock.mock.calls[0]![1].device).toBe('webgpu');
      expect(fromPretrainedMock.mock.calls[0]![1].dtype).toBe('fp32');
      expect(fromPretrainedMock.mock.calls[1]![1].device).toBe('wasm');
      expect(fromPretrainedMock.mock.calls[1]![1].dtype).toBe('fp32');

      if (originalGpu === undefined) {
        delete (navigator as unknown as { gpu?: unknown }).gpu;
      } else {
        (navigator as unknown as { gpu?: unknown }).gpu = originalGpu;
      }
    });

    it('falls back from webgpu to wasm when the first attempt fails', async () => {
      type WindowWithCapacitor = Window & {
        Capacitor?: { isNativePlatform?: () => boolean };
      };
      const originalGpu = (navigator as unknown as { gpu?: unknown }).gpu;
      delete (globalThis.window as WindowWithCapacitor).Capacitor;
      (navigator as unknown as { gpu?: unknown }).gpu = {
        requestAdapter: () => Promise.resolve({}),
      };

      let calls = 0;
      fromPretrainedMock.mockImplementation(() => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('GPU init failed'));
        return Promise.resolve({ generate: generateMock });
      });

      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'F1' });

      expect(fromPretrainedMock).toHaveBeenCalledTimes(2);
      expect(fromPretrainedMock.mock.calls[0]![1].device).toBe('webgpu');
      expect(fromPretrainedMock.mock.calls[1]![1].device).toBe('wasm');
      expect(posts.some((p) => p.msg.type === 'loadDone')).toBe(true);

      if (originalGpu === undefined) {
        delete (navigator as unknown as { gpu?: unknown }).gpu;
      } else {
        (navigator as unknown as { gpu?: unknown }).gpu = originalGpu;
      }
    });

    it('posts loadError when wasm fallback also fails', async () => {
      type WindowWithCapacitor = Window & {
        Capacitor?: { isNativePlatform?: () => boolean };
      };
      const originalGpu = (navigator as unknown as { gpu?: unknown }).gpu;
      delete (globalThis.window as WindowWithCapacitor).Capacitor;
      delete (navigator as unknown as { gpu?: unknown }).gpu;

      fromPretrainedMock.mockRejectedValueOnce(new Error('network unreachable'));

      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'E1' });

      const errorMsg = posts.find((p) => p.msg.type === 'loadError');
      expect(errorMsg).toBeDefined();
      expect((errorMsg!.msg as Extract<WorkerOutbound, { type: 'loadError' }>).message).toContain(
        'network unreachable'
      );

      if (originalGpu !== undefined) {
        (navigator as unknown as { gpu?: unknown }).gpu = originalGpu;
      }
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
      // Multi-word sentence with mixed punctuation: forces ORT/WebGPU to compile
      // more kernel-shape variants up front so the first real generation
      // doesn't pay a graph/shader-compilation tax.
      expect(typeof warmupText).toBe('string');
      expect((warmupText as string).split(/\s+/).length).toBeGreaterThanOrEqual(5);
      expect(warmupText as string).toMatch(/[,;:]/);
      expect(warmupText as string).toMatch(/[.!?]$/);
      expect(warmupOptions).toEqual({ voice: 'af_heart' });
      const done = posts.find((p) => p.msg.type === 'warmupDone');
      expect(done?.msg.requestId).toBe('W1');
      const ready = posts.find((p) => p.msg.type === 'speakReady');
      expect(ready).toBeUndefined();
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
      const readys = posts.filter((p) => p.msg.type === 'speakReady');
      expect(readys.map((r) => r.msg.requestId)).toEqual(['A', 'B']);
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

      const readys = posts.filter((p) => p.msg.type === 'speakReady');
      const readyIds = readys.map((r) => r.msg.requestId);
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
  });
});
