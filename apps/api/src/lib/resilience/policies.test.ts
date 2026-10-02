import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { neverAbortedSignal } from 'cockatiel/dist/common/abort.js';
import { TEST_DAY_START, freezeClock, setClock } from '@hushbox/shared/test-time';
import { validationError } from '../errors/index.js';
import {
  DeadlineExpired,
  LATE_TIMER_THRESHOLD_MS,
  retryPolicy,
  retryWithTimeoutPolicy,
  timeoutPolicy,
} from './policies.js';
import type { DomainError } from '../errors/index.js';

const FAST_RETRY = { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2 };

/** The deadline a blocked event loop outlives. */
const BLOCKED_DEADLINE_MS = 200;

/** How long the event loop is held, from before the answer lands until past the deadline. */
const BLOCK_MS = 400;

/** How long after this process starts blocking the endpoint answers: well inside the deadline. */
const ANSWER_DELAY_MS = 20;

const ANSWER = 'answer';

/**
 * An HTTP endpoint in its own process, so it can answer while this process's
 * event loop is blocked. It reports a request's arrival over IPC, and answers
 * only once told this process has started blocking, so the answer lands inside
 * the block rather than before it.
 */
const ENDPOINT_SOURCE = `
const http = require('node:http');
let held;
const server = http.createServer((request, response) => {
  held = response;
  process.send('received');
});
process.on('message', (message) => {
  if (message === 'blocking') setTimeout(() => held.end(${JSON.stringify(ANSWER)}), ${String(ANSWER_DELAY_MS)});
});
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
`;

interface BlockingEndpoint {
  readonly url: string;
  /** Settles once the endpoint holds a request. */
  readonly received: Promise<void>;
  /** Tells the endpoint this process is about to block; its answer follows inside the block. */
  readonly announceBlock: () => void;
  readonly stop: () => void;
}

function portIn(message: unknown): number | undefined {
  if (typeof message !== 'object' || message === null || !('port' in message)) return undefined;
  return typeof message.port === 'number' ? message.port : undefined;
}

async function startEndpoint(): Promise<BlockingEndpoint> {
  const child = spawn(process.execPath, ['-e', ENDPOINT_SOURCE], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const received = new Promise<void>((resolve) => {
    child.on('message', (message) => {
      if (message === 'received') resolve();
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.on('message', (message) => {
      const listening = portIn(message);
      if (listening !== undefined) resolve(listening);
    });
  });
  return {
    url: `http://127.0.0.1:${String(port)}/`,
    received,
    announceBlock: () => {
      child.send('blocking');
    },
    stop: () => {
      child.kill();
    },
  };
}

/** Holds this thread, timers and I/O included, for `ms`. */
function blockEventLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A deadline short enough to be a real timer that is never the thing measured. */
const MEASURED_DEADLINE_MS = 10;

/**
 * The timeout a never-answering task meets when its timer fires `latenessMs`
 * after its scheduled instant. Only `Date` is faked: the timer is real, and
 * the clock moves in the microtask after the task is handed over, by which
 * point the deadline is armed — so the timer's callback reads a clock exactly
 * that late.
 */
async function timeoutFiredLateBy(latenessMs: number): Promise<DomainError> {
  freezeClock(TEST_DAY_START, { toFake: ['Date'] });
  const result = await timeoutPolicy({ timeoutMs: MEASURED_DEADLINE_MS }).run(() => {
    queueMicrotask(() => {
      setClock(TEST_DAY_START + MEASURED_DEADLINE_MS + latenessMs);
    });
    return new Promise<never>(() => {});
  });
  return result._unsafeUnwrapErr();
}

/**
 * Settles `settle` `delayMs` from now on a timer armed in the microtask after
 * the call — after the deadline the policy arms on receiving the task. Due
 * with that deadline, it runs after the deadline's callback and before the
 * turn the deadline yields: an answer that arrived while the loop could not
 * deliver it.
 */
function answerWithTheDeadline(delayMs: number, settle: () => void): void {
  queueMicrotask(() => {
    setTimeout(settle, delayMs);
  });
}

async function textOf(url: string): Promise<string> {
  const response = await fetch(url);
  return await response.text();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('retryPolicy', () => {
  it('resolves ok on first success without retrying', async () => {
    const task = vi.fn().mockResolvedValue('value');

    const result = await retryPolicy(FAST_RETRY).run(task);

    expect(result._unsafeUnwrap()).toBe('value');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('retries until a later attempt succeeds', async () => {
    const task = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom 1'))
      .mockRejectedValueOnce(new Error('boom 2'))
      .mockResolvedValue('finally');

    const result = await retryPolicy(FAST_RETRY).run(task);

    expect(result._unsafeUnwrap()).toBe('finally');
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('runs the task exactly maxRetries + 1 times before giving up', async () => {
    const task = vi.fn().mockRejectedValue(new Error('boom'));

    const result = await retryPolicy(FAST_RETRY).run(task);

    expect(result.isErr()).toBe(true);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('maps an unknown failure to an unavailable error carrying the cause', async () => {
    const failure = new Error('boom');
    const task = vi.fn().mockRejectedValue(failure);

    const result = await retryPolicy(FAST_RETRY).run(task);

    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect(error.cause).toBe(failure);
  });

  it('passes a thrown DomainError through unchanged', async () => {
    const domainFailure = validationError('bad input');
    const task = vi.fn().mockRejectedValue(domainFailure);

    const result = await retryPolicy(FAST_RETRY).run(task);

    expect(result._unsafeUnwrapErr()).toBe(domainFailure);
  });

  it('schedules every backoff delay within [0, maxDelayMs] (jitter is bounded)', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const task = vi.fn().mockRejectedValue(new Error('boom'));

    const pending = retryPolicy({ maxRetries: 3, initialDelayMs: 5, maxDelayMs: 20 }).run(task);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.isErr()).toBe(true);
    const delays = setTimeoutSpy.mock.calls.map(([, delayMs]) => delayMs!);
    expect(delays).toHaveLength(3);
    for (const delayMs of delays) {
      expect(delayMs).toBeGreaterThanOrEqual(0);
      expect(delayMs).toBeLessThanOrEqual(20);
    }
    setTimeoutSpy.mockRestore();
  });
});

describe('timeoutPolicy', () => {
  it('resolves ok when the task finishes within the deadline', async () => {
    const result = await timeoutPolicy({ timeoutMs: 1000 }).run(() => Promise.resolve('quick'));

    expect(result._unsafeUnwrap()).toBe('quick');
  });

  it('maps a task that fails inside the deadline to an unavailable error carrying the cause', async () => {
    const failure = new Error('boom');

    const result = await timeoutPolicy({ timeoutMs: 1000 }).run(() => Promise.reject(failure));

    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect(error.cause).toBe(failure);
  });

  it('yields a timeout error when the task hangs past the deadline', async () => {
    vi.useFakeTimers();
    const pending = timeoutPolicy({ timeoutMs: 50 }).run(() => new Promise<never>(() => {}));

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersToNextTimerAsync();

    const result = await pending;
    expect(result._unsafeUnwrapErr().code).toBe('timeout');
  });

  it('aborts the task signal at the deadline for cooperative cancellation', async () => {
    vi.useFakeTimers();
    let observed: AbortSignal | undefined;
    const pending = timeoutPolicy({ timeoutMs: 50 }).run((signal) => {
      observed = signal;
      return new Promise<never>(() => {});
    });

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersToNextTimerAsync();
    await pending;

    expect(observed?.aborted).toBe(true);
  });

  it("a deadline that expires during a blocked event loop answers the task's value if the answer had already arrived", async () => {
    const endpoint = await startEndpoint();
    try {
      // Issued, and held by the endpoint, before the deadline is armed — the
      // way a bounded Redis command is issued before its policy reads it.
      const answer = textOf(endpoint.url);
      await endpoint.received;

      const result = await timeoutPolicy({ timeoutMs: BLOCKED_DEADLINE_MS }).run(() => {
        // A check-phase block: on release the timers phase runs before the
        // poll phase that would deliver the answer, so the deadline fires first.
        setImmediate(() => {
          endpoint.announceBlock();
          blockEventLoop(BLOCK_MS);
        });
        return answer;
      });

      expect(result.isOk() ? result.value : result.error.code).toBe(ANSWER);
    } finally {
      endpoint.stop();
    }
  });

  it('still fails as a timeout when nothing had answered by the time a blocked event loop released its deadline', async () => {
    const endpoint = await startEndpoint();
    try {
      // The same held request, and no answer ever sent.
      const answer = textOf(endpoint.url);
      await endpoint.received;

      const result = await timeoutPolicy({ timeoutMs: BLOCKED_DEADLINE_MS }).run(() => {
        setImmediate(() => {
          blockEventLoop(BLOCK_MS);
        });
        return answer;
      });

      expect(result.isErr() && result.error.code).toBe('timeout');
    } finally {
      endpoint.stop();
    }
  });

  it("answers the task's failure when that failure was in hand as its deadline fired", async () => {
    vi.useFakeTimers();
    const refusal = new Error('refused by the dependency');
    const pending = timeoutPolicy({ timeoutMs: 50 }).run(
      () =>
        new Promise<never>((_resolve, reject) => {
          answerWithTheDeadline(50, () => {
            reject(refusal);
          });
        })
    );

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersToNextTimerAsync();

    const result = await pending;
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect(error.cause).toBe(refusal);
  });

  it('still fails as a timeout when the task gives up only once its signal aborts', async () => {
    // The shape of every caller that hands its signal to `fetch`: nothing
    // answers, and the task rejects the moment its signal is aborted.
    const result = await timeoutPolicy({ timeoutMs: MEASURED_DEADLINE_MS }).run(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted by the signal'));
          });
        })
    );

    expect(result.isErr() && result.error.code).toBe('timeout');
  });

  it('marks a timeout late when its timer fired more than the threshold after its scheduled instant', async () => {
    const error = await timeoutFiredLateBy(LATE_TIMER_THRESHOLD_MS + 1);

    expect(error.code).toBe('timeout');
    expect(error.cause).toMatchObject({ latenessMs: LATE_TIMER_THRESHOLD_MS + 1, late: true });
    expect(error.cause).toBeInstanceOf(DeadlineExpired);
  });

  it('does not mark a timeout late when its timer fired exactly the threshold after its scheduled instant', async () => {
    const error = await timeoutFiredLateBy(LATE_TIMER_THRESHOLD_MS);

    expect(error.code).toBe('timeout');
    expect(error.cause).toMatchObject({ latenessMs: LATE_TIMER_THRESHOLD_MS, late: false });
    expect(error.cause).toBeInstanceOf(DeadlineExpired);
  });
});

describe('lazy cockatiel loading', () => {
  it('defers cockatiel module evaluation until the first run', async () => {
    vi.resetModules();
    let evaluated = false;
    vi.doMock('cockatiel', async () => {
      evaluated = true;
      return await vi.importActual('cockatiel');
    });

    const { retryPolicy: freshRetryPolicy } = await import('./policies.js');
    const runner = freshRetryPolicy(FAST_RETRY);
    expect(evaluated).toBe(false);

    const result = await runner.run(() => Promise.resolve('ok'));

    expect(result._unsafeUnwrap()).toBe('ok');
    expect(evaluated).toBe(true);
    vi.doUnmock('cockatiel');
    vi.resetModules();
  });

  it('maps a failed cockatiel load to an unavailable error', async () => {
    vi.resetModules();
    vi.doMock('cockatiel', () => {
      throw new Error('module load failed');
    });

    const { retryPolicy: freshRetryPolicy } = await import('./policies.js');
    const result = await freshRetryPolicy(FAST_RETRY).run(() => Promise.resolve('never'));

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    vi.doUnmock('cockatiel');
    vi.resetModules();
  });
});

describe('retryWithTimeoutPolicy', () => {
  it('times out a hung attempt and succeeds on a fast retry', async () => {
    const task = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockImplementationOnce(() => new Promise<never>(() => {}))
      .mockResolvedValue('second try');

    const result = await retryWithTimeoutPolicy({ ...FAST_RETRY, timeoutMs: 30 }).run(task);

    expect(result._unsafeUnwrap()).toBe('second try');
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("answers an attempt's value that was in hand as that attempt's deadline fired, without retrying", async () => {
    vi.useFakeTimers();
    const task = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          answerWithTheDeadline(30, () => {
            resolve('first try');
          });
        })
    );

    const pending = retryWithTimeoutPolicy({ ...FAST_RETRY, timeoutMs: 30 }).run(task);
    await vi.advanceTimersByTimeAsync(30);
    await vi.advanceTimersToNextTimerAsync();

    const result = await pending;
    expect(result._unsafeUnwrap()).toBe('first try');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("carries the last attempt's deadline record on a timeout", async () => {
    const result = await retryWithTimeoutPolicy({ ...FAST_RETRY, timeoutMs: 10 }).run(
      () => new Promise<never>(() => {})
    );

    expect(result._unsafeUnwrapErr().cause).toBeInstanceOf(DeadlineExpired);
  });

  it('yields a timeout error after every attempt hangs', async () => {
    const task = vi.fn(() => new Promise<never>(() => {}));

    const result = await retryWithTimeoutPolicy({ ...FAST_RETRY, timeoutMs: 10 }).run(task);

    expect(result._unsafeUnwrapErr().code).toBe('timeout');
    expect(task).toHaveBeenCalledTimes(3);
  });
});

describe('execution-context signals', () => {
  it('hands the task a signal other than the cockatiel module-scope default', async () => {
    const { handleAll, retry } = await import('cockatiel');
    let cockatielDefault: AbortSignal | undefined;
    await retry(handleAll, { maxAttempts: 0 }).execute(({ signal }) => {
      cockatielDefault = signal;
    });
    // `neverAbortedSignal` comes from cockatiel's internal abort module; pin it
    // to the object cockatiel itself falls back to, or a second resolved copy
    // would satisfy the inequality assertion vacuously.
    expect(cockatielDefault).toBe(neverAbortedSignal);

    let observed: AbortSignal | undefined;
    const result = await retryPolicy(FAST_RETRY).run((signal) => {
      observed = signal;
      return Promise.resolve('ok');
    });

    expect(result._unsafeUnwrap()).toBe('ok');
    expect(observed).not.toBe(neverAbortedSignal);
  });

  it('mints a distinct signal for each run of the same policy', async () => {
    const runner = retryPolicy(FAST_RETRY);
    const observed: AbortSignal[] = [];
    const record = (signal: AbortSignal): Promise<string> => {
      observed.push(signal);
      return Promise.resolve('ok');
    };

    const first = await runner.run(record);
    const second = await runner.run(record);

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(observed[0]).not.toBe(observed[1]);
  });
});
