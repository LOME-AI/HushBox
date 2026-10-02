import { describe, expect, it, vi } from 'vitest';
import { apiWorkerStartInput } from '../../wrangler-dev.js';
import { runApiWorker } from './api-worker-entry.js';
import type { ApiWorker, ApiWorkerStartInput } from '../../wrangler-dev.js';
import type { ApiWorkerRuntime } from './api-worker-entry.js';

const E2E_ENV: NodeJS.ProcessEnv = {
  HB_ENV_MODE: 'e2e',
  HB_API_PORT: '8915',
  HB_API_INSPECTOR_PORT: '8916',
};

const DEVELOPMENT_ENV: NodeJS.ProcessEnv = {
  HB_API_PORT: '8915',
  HB_API_INSPECTOR_PORT: '8916',
};

/** Listeners registered with `once`, run and dropped by `emit`. */
interface FakeEmitter {
  once(event: string, listener: () => void): unknown;
  emit(event: string): void;
}

function fakeEmitter(): FakeEmitter {
  const listeners = new Map<string, (() => void)[]>();
  return {
    once(event, listener): void {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit(event): void {
      const waiting = listeners.get(event) ?? [];
      listeners.delete(event);
      for (const listener of waiting) listener();
    },
  };
}

type StartWorker = (input: ApiWorkerStartInput) => Promise<ApiWorker>;

interface FakeRuntime {
  readonly runtime: ApiWorkerRuntime;
  readonly startWorker: ReturnType<typeof vi.fn<StartWorker>>;
  readonly raw: FakeEmitter;
}

/** A runtime whose Worker starts at once. */
function fakeRuntime(): FakeRuntime {
  const raw = fakeEmitter();
  const worker: ApiWorker = { raw };
  const startWorker = vi.fn<StartWorker>(() => Promise.resolve(worker));
  return { runtime: { startWorker }, startWorker, raw };
}

/** Every callback queued by what has already happened has run. */
async function settled(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('runApiWorker', () => {
  it('starts the Worker with the input built for the stack and ports its env names', async () => {
    const fake = fakeRuntime();

    void runApiWorker(E2E_ENV, fake.runtime);
    await settled();

    expect(fake.startWorker).toHaveBeenCalledWith(
      apiWorkerStartInput('e2e', { port: 8915, inspectorPort: 8916 })
    );
  });

  it('returns non-zero when the Worker fails to start', async () => {
    const fake = fakeRuntime();
    fake.startWorker.mockRejectedValue(new Error('config is invalid'));
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(await runApiWorker(E2E_ENV, fake.runtime)).toBe(1);
    } finally {
      stderr.mockRestore();
    }
  });

  it('reports why the Worker failed to start', async () => {
    const fake = fakeRuntime();
    fake.startWorker.mockRejectedValue(new Error('config is invalid'));
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runApiWorker(E2E_ENV, fake.runtime);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('config is invalid'));
    } finally {
      stderr.mockRestore();
    }
  });

  it('returns non-zero when the E2E Worker’s build fails, since nothing will rebuild it', async () => {
    const fake = fakeRuntime();

    const running = runApiWorker(E2E_ENV, fake.runtime);
    await settled();
    fake.raw.emit('buildFailed');

    expect(await running).toBe(1);
  });

  it('keeps the development Worker running through a build failure, for the next save to fix', async () => {
    const fake = fakeRuntime();
    let finished = false;

    void (async (): Promise<void> => {
      await runApiWorker(DEVELOPMENT_ENV, fake.runtime);
      finished = true;
    })();
    await settled();
    fake.raw.emit('buildFailed');
    await settled();

    expect(finished).toBe(false);
  });
});
