import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DAY_MS, TEST_DAY_START, freezeClock, setClock } from '@hushbox/shared/test-time';
import {
  _resetPredictionSessionForTesting,
  _setPredictionWorkerFactoryForTesting,
  disposePredictionSession,
  predictWithSharedSession,
  predictionSessionOffered,
  subscribePredictionSessionReady,
} from './prediction-session';
import type { PredictionWorkerInbound } from './prediction-worker-protocol';

const { isNativeRef, connectionTypeRef, getStatus } = vi.hoisted(() => ({
  isNativeRef: { current: false },
  connectionTypeRef: { current: 'wifi' },
  getStatus: vi.fn(),
}));

vi.mock('@/capacitor/platform', () => ({
  isNative: (): boolean => isNativeRef.current,
}));

vi.mock('@capacitor/network', () => ({
  Network: { getStatus },
}));

vi.mock('@/lib/api/api', () => ({
  getApiUrl: (): string => 'https://api.test',
}));

interface FakeWorker {
  readonly posted: PredictionWorkerInbound[];
  readonly terminate: ReturnType<typeof vi.fn>;
  emit: (message: unknown) => void;
  emitError: () => void;
  asWorker: () => Worker;
}

function createFakeWorker(): FakeWorker {
  const posted: PredictionWorkerInbound[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const terminate = vi.fn();
  const worker = {
    postMessage: (message: PredictionWorkerInbound): void => {
      posted.push(message);
    },
    terminate,
    addEventListener: (type: string, handler: (event: unknown) => void): void => {
      listeners.set(type, handler);
    },
  };
  return {
    posted,
    terminate,
    emit: (message) => {
      listeners.get('message')?.({ data: message });
    },
    emitError: () => {
      listeners.get('error')?.({});
    },
    asWorker: () => worker as unknown as Worker,
  };
}

/** Lets every already-queued microtask run, so a settled load has landed. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

let fake: FakeWorker;
let built: number;
/**
 * Stands in for the storage the global test setup stubs away. Keyed, so a read
 * and a write that named different entries would not round-trip here either.
 */
let stored: Record<string, string>;

function storedDeadline(): string | undefined {
  return Object.values(stored)[0];
}

function installWorker(): void {
  built = 0;
  _setPredictionWorkerFactoryForTesting(() => {
    built += 1;
    return fake.asWorker();
  });
}

/** Drives a session to the point the worker has answered its load. */
async function loadSession(): Promise<void> {
  await expect(request()).rejects.toThrow();
  await settle();
  fake.emit({ type: 'ready', requestId: lastRequestId() });
  await settle();
}

/** Wedges the live runtime the way a failed `OrtRun` does. */
async function wedgeLoadedSession(): Promise<void> {
  const pending = request(0);
  await settle();
  fake.emit({ type: 'failed', requestId: lastRequestId(), reason: 'test-injected failure' });
  await expect(pending).rejects.toThrow();
}

function request(
  alternativeCount = 0,
  signal = new AbortController().signal,
  onCompletion: (completion: string) => void = () => {}
): Promise<unknown> {
  return predictWithSharedSession('the quick brown fox', alternativeCount, signal, onCompletion);
}

function lastRequestId(): string {
  return fake.posted.at(-1)?.requestId ?? '';
}

interface WithheldConnection {
  /** Answers the nth question asked with a connection type. */
  answer: (index: number, connectionType: string) => void;
  /** Rejects the nth question, the way a bridge torn down mid-call does. */
  refuse: (index: number) => void;
}

/**
 * Holds every connection question open, so a disposal can land inside the wait
 * and several loads can be settled out of the order they asked. Either settling
 * names the nth question asked; a question that was never asked is nothing to
 * settle, which is how a test says a load must not have started.
 */
function withheldConnectionAnswers(): WithheldConnection {
  const questions: {
    resolve: (status: { connected: boolean; connectionType: string }) => void;
    reject: (reason: Error) => void;
  }[] = [];
  getStatus.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        questions.push({ resolve, reject });
      })
  );
  return {
    answer: (index, connectionType) => {
      questions[index]?.resolve({ connected: true, connectionType });
    },
    refuse: (index) => {
      questions[index]?.reject(new Error('the connection bridge is gone'));
    },
  };
}

beforeEach(() => {
  isNativeRef.current = false;
  connectionTypeRef.current = 'wifi';
  getStatus.mockImplementation(() =>
    Promise.resolve({ connected: true, connectionType: connectionTypeRef.current })
  );
  stored = {};
  vi.mocked(globalThis.localStorage.getItem).mockImplementation((key) => stored[key] ?? null);
  vi.mocked(globalThis.localStorage.setItem).mockImplementation((key, value) => {
    stored[key] = value;
  });
  fake = createFakeWorker();
  installWorker();
  _resetPredictionSessionForTesting();
});

afterEach(() => {
  _setPredictionWorkerFactoryForTesting(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('predictWithSharedSession', () => {
  it('builds nothing until a composer asks for a prediction', () => {
    expect(built).toBe(0);
  });

  it('rejects rather than waiting while the model is still loading', async () => {
    await expect(request()).rejects.toThrow();
    expect(built).toBe(1);
  });

  it('asks the worker for nothing until it reports the model ready', async () => {
    await expect(request()).rejects.toThrow();
    await settle();
    await expect(request()).rejects.toThrow();
    await settle();
    expect(fake.posted.map((message) => message.type)).toEqual(['init']);
  });

  it('loads one session for every surface, whatever each can display', async () => {
    await loadSession();
    const listing = request(3);
    const inlineOnly = request(0);
    await settle();
    expect(built).toBe(1);
    expect(fake.posted.filter((message) => message.type === 'init')).toHaveLength(1);

    disposePredictionSession();
    await expect(listing).rejects.toThrow();
    await expect(inlineOnly).rejects.toThrow();
  });

  it('carries the asking surface alternative count to the worker', async () => {
    await loadSession();
    const listing = request(3);
    await settle();
    expect(fake.posted.at(-1)).toMatchObject({ type: 'predict', alternativeCount: 3 });

    disposePredictionSession();
    await expect(listing).rejects.toThrow();
  });

  it('answers a prediction the worker returns across its two phases', async () => {
    await loadSession();
    const onCompletion = vi.fn();
    const pending = request(1, undefined, onCompletion);
    await settle();
    const requestId = lastRequestId();
    fake.emit({ type: 'completion', requestId, completion: ' jumps over' });
    await settle();
    fake.emit({ type: 'alternatives', requestId, alternatives: [' leaps over'] });
    await expect(pending).resolves.toEqual({
      completion: ' jumps over',
      alternatives: [' leaps over'],
    });
  });

  it('calls onCompletion the moment the completion phase lands, before the promise settles', async () => {
    await loadSession();
    const onCompletion = vi.fn();
    const pending = request(1, undefined, onCompletion);
    await settle();
    const requestId = lastRequestId();
    fake.emit({ type: 'completion', requestId, completion: ' jumps over' });
    await settle();
    expect(onCompletion).toHaveBeenCalledExactlyOnceWith(' jumps over');
    fake.emit({ type: 'alternatives', requestId, alternatives: [] });
    await pending;
  });

  it('rejects when the alternatives phase fails after the completion already landed', async () => {
    await loadSession();
    const onCompletion = vi.fn();
    const pending = request(1, undefined, onCompletion);
    await settle();
    const requestId = lastRequestId();
    fake.emit({ type: 'completion', requestId, completion: ' jumps over' });
    await settle();
    fake.emit({ type: 'failed', requestId, reason: 'batched sampling failed' });
    await expect(pending).rejects.toThrow();
    expect(onCompletion).toHaveBeenCalledExactlyOnceWith(' jumps over');
  });

  it('rejects a request the composer abandoned, and ignores the answers that follow', async () => {
    await loadSession();
    const controller = new AbortController();
    const pending = request(0, controller.signal);
    await settle();
    const requestId = lastRequestId();
    controller.abort();
    await expect(pending).rejects.toThrow();
    fake.emit({ type: 'completion', requestId, completion: ' jumps over' });
    fake.emit({ type: 'alternatives', requestId, alternatives: [] });
    await settle();
    expect(predictionSessionOffered()).toBe(true);
  });

  it('rejects a request whose signal was already aborted', async () => {
    await loadSession();
    const controller = new AbortController();
    controller.abort();
    await expect(request(0, controller.signal)).rejects.toThrow();
    expect(fake.posted.filter((message) => message.type === 'predict')).toHaveLength(0);
  });

  it('ignores an answer to a request nothing is waiting for', async () => {
    await loadSession();
    fake.emit({ type: 'alternatives', requestId: 'unknown', alternatives: [] });
    await settle();
    expect(predictionSessionOffered()).toBe(true);
  });

  it('ignores traffic over the worker boundary that is not one of its answers', async () => {
    await loadSession();
    fake.emit({ nonsense: true });
    await settle();
    expect(predictionSessionOffered()).toBe(true);
  });
});

describe('a load that fails', () => {
  it('throws the worker away and offers nothing more for the rest of the session', async () => {
    await expect(request()).rejects.toThrow();
    await settle();
    fake.emit({ type: 'failed', requestId: lastRequestId(), reason: 'test-injected failure' });
    await settle();
    expect(fake.terminate).toHaveBeenCalledTimes(1);
    expect(predictionSessionOffered()).toBe(false);
    await expect(request()).rejects.toThrow();
    expect(built).toBe(1);
  });

  it('throws the worker away when the worker itself errors', async () => {
    await expect(request()).rejects.toThrow();
    await settle();
    fake.emitError();
    expect(fake.terminate).toHaveBeenCalledTimes(1);
    expect(predictionSessionOffered()).toBe(false);
  });

  it('offers nothing when the worker cannot be constructed at all', async () => {
    _setPredictionWorkerFactoryForTesting(() => {
      throw new Error('no worker here');
    });
    await expect(request()).rejects.toThrow();
    await settle();
    expect(predictionSessionOffered()).toBe(false);
  });

  it('tells the user nothing about any of it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(request()).rejects.toThrow();
    await settle();
    fake.emit({ type: 'failed', requestId: lastRequestId(), reason: 'test-injected failure' });
    await settle();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('a runtime that wedges once the model has loaded', () => {
  it('replaces it, rather than spending the rest of the session without the feature', async () => {
    await loadSession();
    await wedgeLoadedSession();
    expect(fake.terminate).toHaveBeenCalledTimes(1);
    expect(predictionSessionOffered()).toBe(true);
    await expect(request()).rejects.toThrow();
    await settle();
    expect(built).toBe(2);
  });

  it('replaces it when the worker itself errors rather than answering', async () => {
    await loadSession();
    fake.emitError();
    expect(predictionSessionOffered()).toBe(true);
    await expect(request()).rejects.toThrow();
    await settle();
    expect(built).toBe(2);
  });

  it('leaves no cross-reload backoff behind, the weights having never been in doubt', async () => {
    await loadSession();
    await wedgeLoadedSession();
    expect(storedDeadline()).toBeUndefined();
    await loadSession();
    await wedgeLoadedSession();
    expect(storedDeadline()).toBeUndefined();
  });

  it('gives up for the rest of the session once the replacement wedges too', async () => {
    await loadSession();
    await wedgeLoadedSession();
    await loadSession();
    expect(built).toBe(2);
    await wedgeLoadedSession();
    expect(predictionSessionOffered()).toBe(false);
  });
});

describe('the backoff a failed load leaves behind', () => {
  it('survives a reload, so a broken origin is not re-pulled on the next visit', async () => {
    freezeClock(TEST_DAY_START);
    await expect(request()).rejects.toThrow();
    await settle();
    fake.emit({ type: 'failed', requestId: lastRequestId(), reason: 'test-injected failure' });
    await settle();
    expect(storedDeadline()).toBe(String(TEST_DAY_START + DAY_MS));

    _resetPredictionSessionForTesting();
    expect(predictionSessionOffered()).toBe(false);
    await expect(request()).rejects.toThrow();
    await settle();
    expect(built).toBe(1);
  });

  it('lets the feature load again once it has expired', async () => {
    freezeClock(TEST_DAY_START);
    stored = { anything: String(TEST_DAY_START + DAY_MS) };
    vi.mocked(globalThis.localStorage.getItem).mockImplementation(() => storedDeadline() ?? null);
    _resetPredictionSessionForTesting();
    expect(predictionSessionOffered()).toBe(false);

    setClock(TEST_DAY_START + DAY_MS + 1);
    _resetPredictionSessionForTesting();
    expect(predictionSessionOffered()).toBe(true);
    await expect(request()).rejects.toThrow();
    await settle();
    expect(built).toBe(1);
  });

  it('reads a deadline it cannot make sense of as no deadline at all', () => {
    vi.mocked(globalThis.localStorage.getItem).mockReturnValue('not a number');
    _resetPredictionSessionForTesting();
    expect(predictionSessionOffered()).toBe(true);
  });

  it('carries on when storage refuses to answer or to record', async () => {
    vi.mocked(globalThis.localStorage.getItem).mockImplementation(() => {
      throw new Error('storage is off');
    });
    vi.mocked(globalThis.localStorage.setItem).mockImplementation(() => {
      throw new Error('storage is off');
    });
    _resetPredictionSessionForTesting();
    expect(predictionSessionOffered()).toBe(true);
    await expect(request()).rejects.toThrow();
    await settle();
    fake.emit({ type: 'failed', requestId: lastRequestId(), reason: 'test-injected failure' });
    await settle();
    expect(predictionSessionOffered()).toBe(false);
  });
});

describe('the connection the download is allowed over', () => {
  it('asks nothing of the network on the web, where the download is unconditional', async () => {
    await expect(request()).rejects.toThrow();
    await settle();
    expect(getStatus).not.toHaveBeenCalled();
    expect(built).toBe(1);
  });

  it('withholds the download on a metered native connection', async () => {
    isNativeRef.current = true;
    connectionTypeRef.current = 'cellular';
    await expect(request()).rejects.toThrow();
    await settle();
    expect(built).toBe(0);
  });

  it('withholds the download when the native connection type is unknown', async () => {
    isNativeRef.current = true;
    connectionTypeRef.current = 'unknown';
    await expect(request()).rejects.toThrow();
    await settle();
    expect(built).toBe(0);
  });

  it('loads over an unmetered native connection', async () => {
    isNativeRef.current = true;
    connectionTypeRef.current = 'wifi';
    await expect(request()).rejects.toThrow();
    await settle();
    expect(built).toBe(1);
  });

  it('gives up the way a failed load does when the connection question fails outright', async () => {
    isNativeRef.current = true;
    getStatus.mockRejectedValue(new Error('the connection bridge is gone'));
    await expect(request()).rejects.toThrow();
    await settle();
    expect(built).toBe(0);
    expect(predictionSessionOffered()).toBe(false);
    expect(storedDeadline()).toBeDefined();
  });

  it('leaves a metered refusal retryable, so a later unmetered engagement loads', async () => {
    isNativeRef.current = true;
    connectionTypeRef.current = 'cellular';
    await expect(request()).rejects.toThrow();
    await settle();
    connectionTypeRef.current = 'wifi';
    await expect(request()).rejects.toThrow();
    await settle();
    expect(built).toBe(1);
    expect(predictionSessionOffered()).toBe(true);
  });
});

describe('a disposal that lands while the connection is still being asked about', () => {
  it('builds no worker for a session it has already been told to drop', async () => {
    isNativeRef.current = true;
    const connection = withheldConnectionAnswers();
    await expect(request()).rejects.toThrow();
    disposePredictionSession();
    connection.answer(0, 'wifi');
    await settle();
    expect(built).toBe(0);
  });

  it('leaves the next composer engagement free to load', async () => {
    isNativeRef.current = true;
    const connection = withheldConnectionAnswers();
    await expect(request()).rejects.toThrow();
    disposePredictionSession();
    connection.answer(0, 'wifi');
    await settle();
    expect(built).toBe(0);

    getStatus.mockImplementation(() =>
      Promise.resolve({ connected: true, connectionType: 'wifi' })
    );
    await expect(request()).rejects.toThrow();
    await settle();
    expect(built).toBe(1);
  });
});

describe('a dropped load whose metered answer arrives after a newer load has started', () => {
  it('never leaves a worker that no disposal can reach', async () => {
    const workers: FakeWorker[] = [];
    _setPredictionWorkerFactoryForTesting(() => {
      const next = createFakeWorker();
      workers.push(next);
      return next.asWorker();
    });
    isNativeRef.current = true;
    const connection = withheldConnectionAnswers();

    await expect(request()).rejects.toThrow();
    disposePredictionSession();
    await expect(request()).rejects.toThrow();
    connection.answer(0, 'cellular');
    await settle();

    await expect(request()).rejects.toThrow();
    connection.answer(1, 'wifi');
    connection.answer(2, 'wifi');
    await settle();
    expect(workers).toHaveLength(1);

    disposePredictionSession();
    expect(workers.map((each) => each.terminate.mock.calls.length)).toEqual([1]);
  });
});

describe("a dropped worker's late failure after a newer load has begun", () => {
  it('does not latch the feature off or persist a backoff', async () => {
    const workers: FakeWorker[] = [];
    _setPredictionWorkerFactoryForTesting(() => {
      const next = createFakeWorker();
      workers.push(next);
      return next.asWorker();
    });

    await expect(request()).rejects.toThrow();
    await settle();
    workers[0]?.emit({ type: 'ready', requestId: workers[0].posted.at(-1)?.requestId });
    await settle();

    disposePredictionSession();
    await expect(request()).rejects.toThrow();
    await settle();
    expect(workers).toHaveLength(2);

    // The disposed worker's queued failure arrives after the second worker is
    // already live and still loading — a stale event from a generation the
    // session has already moved past.
    workers[0]?.emitError();
    await settle();

    expect(predictionSessionOffered()).toBe(true);
    expect(storedDeadline()).toBeUndefined();
    expect(workers[1]?.terminate).not.toHaveBeenCalled();
  });
});

describe('a dropped load whose connection question then rejects', () => {
  it('leaves alone the live session it no longer belongs to', async () => {
    isNativeRef.current = true;
    const connection = withheldConnectionAnswers();

    await expect(request()).rejects.toThrow();
    disposePredictionSession();
    await expect(request()).rejects.toThrow();
    connection.answer(1, 'wifi');
    await settle();
    expect(built).toBe(1);

    connection.refuse(0);
    await settle();
    expect(fake.terminate).not.toHaveBeenCalled();
    expect(predictionSessionOffered()).toBe(true);
    expect(storedDeadline()).toBeUndefined();
  });
});

describe('disposePredictionSession', () => {
  it('terminates the session so a backgrounded app holds no weights', async () => {
    await loadSession();
    disposePredictionSession();
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it('rebuilds nothing by itself, and everything on the next composer engagement', async () => {
    await loadSession();
    disposePredictionSession();
    expect(built).toBe(1);
    await expect(request()).rejects.toThrow();
    await settle();
    expect(built).toBe(2);
  });

  it('rejects the predictions the disposed session was still holding', async () => {
    await loadSession();
    const pending = request(0);
    await settle();
    disposePredictionSession();
    await expect(pending).rejects.toThrow();
  });

  it('leaves a session that gave up given up', async () => {
    await expect(request()).rejects.toThrow();
    await settle();
    fake.emit({ type: 'failed', requestId: lastRequestId(), reason: 'test-injected failure' });
    await settle();
    disposePredictionSession();
    expect(predictionSessionOffered()).toBe(false);
  });

  it('does nothing at all when no session was ever built', () => {
    disposePredictionSession();
    expect(fake.terminate).not.toHaveBeenCalled();
  });
});

describe('subscribePredictionSessionReady', () => {
  it('notifies a listener once the session becomes ready', async () => {
    const listener = vi.fn();
    subscribePredictionSessionReady(listener);
    await loadSession();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies nothing before the session reaches ready', async () => {
    const listener = vi.fn();
    subscribePredictionSessionReady(listener);
    await expect(request()).rejects.toThrow();
    await settle();
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying a listener that unsubscribed', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribePredictionSessionReady(listener);
    unsubscribe();
    await loadSession();
    expect(listener).not.toHaveBeenCalled();
  });

  it('never notifies a listener for a load that fails', async () => {
    const listener = vi.fn();
    subscribePredictionSessionReady(listener);
    await expect(request()).rejects.toThrow();
    await settle();
    fake.emit({ type: 'failed', requestId: lastRequestId(), reason: 'test-injected failure' });
    await settle();
    expect(listener).not.toHaveBeenCalled();
  });
});
