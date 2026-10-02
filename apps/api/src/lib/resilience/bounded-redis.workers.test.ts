/**
 * The bounded Redis client's deadline across a blocked isolate, inside the
 * runtime the Worker runs on. workerd freezes `Date.now()` while JavaScript
 * runs and may run a late timer ahead of the I/O that arrived while the isolate
 * was busy, so whether an answer in hand survives a late deadline — and whether
 * that deadline can tell how late it ran — are questions the node project
 * cannot answer for it.
 *
 * The isolate is blocked by a CPU spin sized against the clock, because
 * nothing else holds a workerd isolate: there is no `Atomics.wait` on its
 * thread, and a spin's length cannot be read while it runs.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { env as workerEnv } from 'cloudflare:workers';
import { createBoundedRedis } from './bounded-redis.js';
import { DeadlineExpired, LATE_TIMER_THRESHOLD_MS } from './policies.js';

const CREDENTIALS = { url: 'http://localhost:8079', token: 'token' } as const;

/** The deadline a blocked isolate outlives. */
const DEADLINE_MS = 200;

/**
 * How long the isolate is held for the answered case. The answer comes from a
 * process on the same host, which a loaded machine can starve for hundreds of
 * milliseconds; the block has to outlast that, or the answer has not arrived
 * when the deadline rules and there is nothing to find.
 */
const BLOCK_MS = 1000;

/**
 * Blocked rounds in the answered case. On release workerd may run the late
 * timer or the answer that landed during the block first, and which is its own
 * choice: a test's first round has been seen to take the answer-first order,
 * which passes with or without the deadline looking before it rules. Later
 * rounds reach the timer-first order this file pins.
 */
const BLOCKED_ROUNDS = 2;

/** A spinning case's own budget: a loaded machine stretches every spin. */
const SPINNING_CASE_TIMEOUT_MS = 20_000;

/** How far past the threshold the late case holds its deadline: room for a spin that runs short. */
const LATE_MARGIN_MS = 500;

/**
 * The most the test's clock reading after a hold may trail the deadline's own:
 * both are read on turns after the hold, and workerd runs those turns in an
 * order it does not fix.
 */
const READING_GAP_MS = 100;

/** How far past its deadline a hold must be seen to run before the late case judges its deadline. */
const HELD_PAST_DEADLINE_MS = LATE_TIMER_THRESHOLD_MS + READING_GAP_MS;

/** Holds the late case may take to see one run past the threshold. */
const LATE_HOLD_ATTEMPTS = 3;

/** A calibration run shorter than this is mostly clock resolution. */
const CALIBRATION_MS = 100;

/** Calibration runs taken; the fastest is kept, so a spin sized from it errs long while the load holds. */
const CALIBRATION_RUNS = 3;

const ANSWER = 'answer';

/** Work the optimizer cannot discard, because its result is returned. */
function spin(iterations: number): number {
  let accumulator = 0;
  for (let index = 0; index < iterations; index += 1) {
    accumulator = (accumulator + index) % 1_000_003;
  }
  return accumulator;
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Spin iterations per millisecond. The clock is read on either side of a turn
 * of the event loop, because a clock read inside the same turn as the spin
 * returns the instant the turn began.
 */
async function measureSpinRate(): Promise<number> {
  let fastest = 0;
  for (let run = 0; run < CALIBRATION_RUNS; run += 1) {
    let iterations = 1_000_000;
    let elapsed = 0;
    while (elapsed < CALIBRATION_MS) {
      iterations *= 2;
      const before = Date.now();
      spin(iterations);
      await nextTurn();
      elapsed = Date.now() - before;
    }
    fastest = Math.max(fastest, iterations / elapsed);
  }
  return fastest;
}

/** Blocks the isolate for about `ms`, starting in the next turn of its event loop. */
function blockNextTurn(spinRate: number, ms: number): void {
  setTimeout(() => {
    spin(Math.ceil(spinRate * ms));
  }, 0);
}

/** A hold as it ran: when the isolate was next free, and the spin rate it held at. */
interface Hold {
  readonly endedAt: number;
  readonly spinRate: number;
}

/**
 * Blocks the isolate for about `ms`, starting in the next turn of its event
 * loop, and reports the hold from the clock read on the turn the spin runs in
 * and on the first turn after it.
 */
function holdNextTurn(spinRate: number, ms: number): Promise<Hold> {
  const iterations = Math.ceil(spinRate * ms);
  return new Promise((resolve) => {
    setTimeout(() => {
      const startedAt = Date.now();
      spin(iterations);
      setTimeout(() => {
        const endedAt = Date.now();
        resolve({ endedAt, spinRate: iterations / Math.max(endedAt - startedAt, 1) });
      }, 0);
    }, 0);
  });
}

interface Responder {
  fetch(input: Request): Promise<Response>;
}

function isResponder(binding: unknown): binding is Responder {
  return (
    typeof binding === 'object' &&
    binding !== null &&
    'fetch' in binding &&
    typeof binding.fetch === 'function'
  );
}

/** The far side of a real service boundary, in another process; see the workers vitest config. */
function crossBoundaryResponder(): Responder {
  const binding: unknown = Reflect.get(workerEnv, 'CROSS_BOUNDARY_RESPONDER');
  if (!isResponder(binding)) throw new Error('the workers config binds CROSS_BOUNDARY_RESPONDER');
  return binding;
}

/**
 * The store's pipeline answer, reached by a round trip to another process: the
 * answer is on its way back while this isolate is blocked. The client posts an
 * array of commands and reads one base64-encoded result per command.
 */
function answeringAcrossBoundary(value: string): typeof globalThis.fetch {
  const responder = crossBoundaryResponder();
  return async (_input, init) => {
    const body = init?.body;
    if (typeof body !== 'string') {
      throw new TypeError('the client posts its pipeline as a JSON string');
    }
    const commands = JSON.parse(body) as unknown[];
    await responder.fetch(new Request('https://responder.invalid/answer'));
    return Response.json(commands.map(() => ({ result: btoa(value) })));
  };
}

function answeringAtOnce(value: string): typeof globalThis.fetch {
  return (_input, init) => {
    const body = init?.body;
    if (typeof body !== 'string') {
      throw new TypeError('the client posts its pipeline as a JSON string');
    }
    const commands = JSON.parse(body) as unknown[];
    return Promise.resolve(Response.json(commands.map(() => ({ result: btoa(value) }))));
  };
}

function neverAnswering(): typeof globalThis.fetch {
  return () => new Promise<Response>(() => {});
}

async function caughtDeadline(work: Promise<unknown>): Promise<DeadlineExpired> {
  const rejection: unknown = await work.then(
    () => undefined,
    (error: unknown) => error
  );
  expect(rejection).toMatchObject({ code: 'timeout' });
  const cause: unknown = rejection instanceof Error ? rejection.cause : undefined;
  if (!(cause instanceof DeadlineExpired)) {
    throw new TypeError('expected the timeout to carry its deadline record');
  }
  return cause;
}

/** A command's deadline, with how far past it the isolate was seen held. */
interface HeldDeadline {
  readonly deadline: DeadlineExpired;
  readonly heldPastDeadlineMs: number;
}

/**
 * Holds the isolate across a command nothing answers until a hold is seen to
 * run past the threshold, or the attempts run out. A spin sized from a rate
 * measured under heavier load runs short once the load eases, so each further
 * hold is sized from the rate the one before it held at.
 */
async function deadlineHeldPastThreshold(
  rate: number,
  attemptsLeft: number
): Promise<HeldDeadline> {
  // The clock stands still within a turn, so this is the instant the deadline arms.
  const issuedAt = Date.now();
  const reply = createBoundedRedis(CREDENTIALS, DEADLINE_MS).get('key');
  const hold = holdNextTurn(rate, DEADLINE_MS + LATE_TIMER_THRESHOLD_MS + LATE_MARGIN_MS);

  const deadline = await caughtDeadline(reply);
  const { endedAt, spinRate: heldRate } = await hold;
  const heldPastDeadlineMs = endedAt - issuedAt - DEADLINE_MS;

  if (heldPastDeadlineMs > HELD_PAST_DEADLINE_MS || attemptsLeft <= 1) {
    return { deadline, heldPastDeadlineMs };
  }
  return deadlineHeldPastThreshold(heldRate, attemptsLeft - 1);
}

let spinRate = 0;

beforeAll(async () => {
  spinRate = await measureSpinRate();
  // The policy loads cockatiel on its first run. Paid here, so the deadline
  // in each case is armed in the same turn its command is issued.
  vi.stubGlobal('fetch', answeringAtOnce(ANSWER));
  await createBoundedRedis(CREDENTIALS, DEADLINE_MS).get('warm');
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the bounded Redis deadline across a blocked isolate, under workerd', () => {
  it('runs on workerd, not on the node test runtime', () => {
    // Guards the guard: under node the frozen clock and the timer ordering
    // this file exists to pin are not the ones in force.
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
  });

  it(
    'answers every command whose answer arrived while a blocked isolate outlived its deadline',
    { timeout: SPINNING_CASE_TIMEOUT_MS },
    async () => {
      vi.stubGlobal('fetch', answeringAcrossBoundary(ANSWER));
      const replies: unknown[] = [];

      for (let round = 0; round < BLOCKED_ROUNDS; round += 1) {
        const reply = createBoundedRedis(CREDENTIALS, DEADLINE_MS).get('key');
        blockNextTurn(spinRate, BLOCK_MS);
        replies.push(await reply.catch((error: unknown) => error));
      }

      expect(replies).toEqual(Array.from({ length: BLOCKED_ROUNDS }, () => ANSWER));
    }
  );

  it(
    'rejects a command nothing answered as a late timeout when a blocked isolate held its deadline past the threshold',
    { timeout: SPINNING_CASE_TIMEOUT_MS },
    async () => {
      vi.stubGlobal('fetch', neverAnswering());

      const { deadline, heldPastDeadlineMs } = await deadlineHeldPastThreshold(
        spinRate,
        LATE_HOLD_ATTEMPTS
      );

      expect(heldPastDeadlineMs, 'no hold ran past the threshold').toBeGreaterThan(
        HELD_PAST_DEADLINE_MS
      );
      expect(deadline.latenessMs).toBeGreaterThan(LATE_TIMER_THRESHOLD_MS);
      expect(deadline.late).toBe(true);
    }
  );

  it('rejects a command nothing answered as a timeout not marked late when the isolate was free', async () => {
    vi.stubGlobal('fetch', neverAnswering());
    const redis = createBoundedRedis(CREDENTIALS, DEADLINE_MS);

    const deadline = await caughtDeadline(redis.get('key'));

    expect(deadline.late).toBe(false);
  });
});
