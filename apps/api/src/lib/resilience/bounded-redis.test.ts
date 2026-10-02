import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoundedRedis } from './bounded-redis.js';
import type { PolicyRunner } from './policies.js';
import type { ResultAsync } from '../result/index.js';
import type { DomainError } from '../errors/index.js';

const CREDENTIALS = { url: 'http://localhost:8079', token: 'token' } as const;

/** Well under a test's patience, far enough above a microtask to be a real wait. */
const SHORT_DEADLINE_MS = 40;

/**
 * The endpoint's own shape: the client pipelines, so it posts an array of
 * commands and reads back one base64-encoded result per command. Every stub in
 * this file is annotated as the global it stands in for, so the compiler checks
 * it against that contract rather than a cast asserting it.
 */
function answeringFetch(value: string): {
  readonly fetch: typeof globalThis.fetch;
  readonly bodies: string[];
} {
  const bodies: string[] = [];
  const stub: typeof globalThis.fetch = (_input, init) => {
    const body = init?.body;
    if (typeof body !== 'string') {
      throw new TypeError('the client posts its pipeline as a JSON string');
    }
    bodies.push(body);
    const commands = JSON.parse(body) as unknown[];
    const answers = commands.map(() => ({ result: btoa(value) }));
    return Promise.resolve(Response.json(answers, { status: 200 }));
  };
  return { fetch: stub, bodies };
}

function neverAnsweringFetch(): typeof globalThis.fetch {
  return () => new Promise<Response>(() => {});
}

/** The endpoint answering, and its answer a failure — the client's error arm. */
function refusingFetch(): typeof globalThis.fetch {
  return () => Promise.resolve(Response.json({ error: 'store refused' }, { status: 500 }));
}

/** Long enough that {@link RUNNER_DEFERRAL_MS} is nowhere near it. */
const PATIENT_DEADLINE_MS = 2000;

/** How long the stubbed runner waits before it first reads its task. */
const RUNNER_DEFERRAL_MS = 25;

/**
 * The factory, over a runner that reaches its task a macrotask late — the real
 * one's lazy-import window, held open on purpose. Everything else is the real
 * policy, so what the deadline does and how a failure is classified are
 * unchanged; only the moment the task is first read moves.
 */
async function deferredRunnerFactory(): Promise<typeof createBoundedRedis> {
  vi.resetModules();
  vi.doMock('./policies.js', async () => {
    const actual = await vi.importActual<typeof import('./policies.js')>('./policies.js');
    return {
      ...actual,
      timeoutPolicy: (options: Parameters<typeof actual.timeoutPolicy>[0]): PolicyRunner => {
        const real = actual.timeoutPolicy(options);
        return {
          run: <T>(task: (signal: AbortSignal) => Promise<T>): ResultAsync<T, DomainError> =>
            real.run(async (signal: AbortSignal): Promise<T> => {
              await new Promise<void>((resolve) => setTimeout(resolve, RUNNER_DEFERRAL_MS));
              return await task(signal);
            }),
        };
      },
    };
  });
  const fresh = await import('./bounded-redis.js');
  return fresh.createBoundedRedis;
}

async function caughtError(work: Promise<unknown>): Promise<DomainError> {
  const rejection = await work.then(
    () => undefined,
    (error: unknown) => error as DomainError
  );
  if (rejection === undefined) throw new Error('expected the bounded round trip to reject');
  return rejection;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('./policies.js');
  vi.resetModules();
});

describe('createBoundedRedis', () => {
  it('returns the value of a round trip that answers inside the deadline', async () => {
    vi.stubGlobal('fetch', answeringFetch('stored').fetch);
    const redis = createBoundedRedis(CREDENTIALS, SHORT_DEADLINE_MS);

    await expect(redis.get('key')).resolves.toBe('stored');
  });

  it('rejects with a timeout domain error when a round trip outlives the deadline', async () => {
    vi.stubGlobal('fetch', neverAnsweringFetch());
    const redis = createBoundedRedis(CREDENTIALS, SHORT_DEADLINE_MS);

    const error = await caughtError(redis.get('key'));

    expect(error.code).toBe('timeout');
  });

  it('still batches commands issued together into one round trip', async () => {
    const { fetch, bodies } = answeringFetch('stored');
    vi.stubGlobal('fetch', fetch);
    const redis = createBoundedRedis(CREDENTIALS, SHORT_DEADLINE_MS);

    await Promise.all([redis.get('one'), redis.get('two')]);

    expect(bodies).toEqual([
      JSON.stringify([
        ['get', 'one'],
        ['get', 'two'],
      ]),
    ]);
  });

  it('bounds a round trip a returned script issues', async () => {
    vi.stubGlobal('fetch', neverAnsweringFetch());
    const redis = createBoundedRedis(CREDENTIALS, SHORT_DEADLINE_MS);

    const script = redis.createScript('return 1');
    const error = await caughtError(script.eval([], []));

    expect(error.code).toBe('timeout');
  });

  it('leaves no rejection unobserved while the policy is still reaching the command', async () => {
    // The real runner builds its policy behind a lazy import of cockatiel and
    // only reads its task once that resolves, so a command issued before the
    // call sits unobserved for as long as the import takes. A store that
    // refuses inside that window settles a promise nobody is holding, which the
    // runtime reports as an unhandled rejection: every test green and the run
    // red. The stub here is what makes the window deterministic — the real one
    // is wide only for the first policy a process builds.
    const redis = await deferredRunnerFactory();

    vi.stubGlobal('fetch', refusingFetch());
    const unobserved: unknown[] = [];
    const record = (reason: unknown): void => {
      unobserved.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      const error = await caughtError(redis(CREDENTIALS, PATIENT_DEADLINE_MS).get('key'));
      expect(error.code).toBe('unavailable');
    } finally {
      process.off('unhandledRejection', record);
    }

    expect(unobserved).toEqual([]);
  });

  it('reads a non-callable member off the client unchanged', () => {
    vi.stubGlobal('fetch', neverAnsweringFetch());
    const redis = createBoundedRedis(CREDENTIALS, SHORT_DEADLINE_MS);

    expect(redis.readYourWritesSyncToken).toBe('');
  });

  it('answers a member whose answer is not an object rather than wrapping it', () => {
    // `use` wraps a middleware around the HTTP client and answers with
    // nothing. A member that issues no round trip has no deadline to carry,
    // and a proxy is refused over an answer that is not an object — so this
    // call throwing is what a wrapped answer would look like.
    vi.stubGlobal('fetch', neverAnsweringFetch());
    const redis = createBoundedRedis(CREDENTIALS, SHORT_DEADLINE_MS);

    expect(() => {
      redis.use((request, next) => next(request));
    }).not.toThrow();
  });
});
