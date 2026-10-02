import { Redis } from '@upstash/redis';
import { err, ok } from '../result/index.js';
import { timeoutPolicy } from './policies.js';
import type { PolicyRunner } from './policies.js';
import type { Result } from '../result/index.js';
import type { DomainError, DomainErrorCode } from '../errors/index.js';

interface RedisCredentials {
  readonly url: string;
  readonly token: string;
}

/**
 * The policy's failure in a form a promise seam may reject with. Domain errors
 * here are plain `Result` values that nothing throws, and a rejecting seam
 * needs an `Error`; one carrying the same `code` and `message` still satisfies
 * `isDomainError`, so the policy's classification — a deadline as `timeout`,
 * anything else as `unavailable` — survives into every caller that reads it,
 * the rate-limit path's failure arms included.
 *
 * It answers for the wrapper, not for the store: the store's own error reaches
 * a caller as this error's `cause` and never as its message. That is a
 * redaction boundary as much as a taxonomy one — an `UpstashError`'s message
 * carries the request body, which for a script is the script text and its keys
 * (`apps/api/src/lib/rate-limit/consume.ts` records why that must not reach a
 * retained channel) — and it is why nothing the CLIENT does with its own
 * errors may be made to cross it.
 */
export class BoundedRedisFailure extends Error {
  readonly code: DomainErrorCode;

  constructor(failure: DomainError) {
    super(failure.message, { cause: failure.cause });
    this.name = 'BoundedRedisFailure';
    this.code = failure.code;
  }
}

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof (value as { then: unknown }).then === 'function'
  );
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

/**
 * The command's outcome, taken in the tick the command was issued: an async
 * body runs synchronously as far as its first `await`, so the command has a
 * handler before this returns.
 *
 * That timing is the whole of what this is for. The runner does not reach the
 * task it is given until its own lazy import of cockatiel has resolved, and a
 * command promise handed over unobserved has no handler for the whole of that
 * window. A store that answers a failure inside it settles a promise nobody is
 * holding, which the runtime reports as an unhandled rejection — a red run
 * behind green tests, and in a Worker a reported defect for a failure the
 * caller went on to handle.
 */
async function captureOutcome(issued: Promise<unknown>): Promise<Result<unknown, unknown>> {
  try {
    return ok(await issued);
  } catch (error: unknown) {
    return err(error);
  }
}

/**
 * The deadline, laid over one client surface: every command it answers with a
 * promise carries the bound, and every object it answers with is laid over the
 * same way, because such an object issues its round trips later through itself.
 *
 * Each command is applied to the surface itself and never to this proxy, which
 * is what keeps the client's own error handling intact. `Script.exec`
 * recognises an empty script cache by the message on the error its EVALSHA
 * rejected with, and falls back to EVAL — the only command that loads a script.
 * Reached through this proxy its EVALSHA would reject with the wrapper's error
 * instead, that test would never match, and an empty script cache would become
 * a permanent refusal of every scripted path rather than one extra round trip.
 * So the boundary sits where the surfaces meet: inside the client, errors keep
 * their identity; outside it, callers get the policy's taxonomy.
 */
function boundedSurface<T extends object>(surface: T, runner: PolicyRunner): T {
  return new Proxy(surface, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      const command = member as (this: unknown, ...args: unknown[]) => unknown;

      return (...args: unknown[]): unknown => {
        // Invoked before anything is awaited, so commands issued together still
        // join one batch; each of their promises then carries its own deadline.
        const issued: unknown = command.apply(target, args);
        if (!isPromise(issued)) {
          // A member that answers with an object issues its round trips later
          // through that object, so the deadline follows it there. Anything
          // else issued no round trip and can issue none, so it has nothing to
          // bound.
          return isObject(issued) ? boundedSurface(issued, runner) : issued;
        }
        const outcome = captureOutcome(issued);

        return runner
          .run(async (): Promise<unknown> => {
            const settled = await outcome;
            if (settled.isOk()) return settled.value;
            throw settled.error;
          })
          .match(
            (value) => value,
            (error) => {
              throw new BoundedRedisFailure(error);
            }
          );
      };
    },
  });
}

/**
 * A Redis client whose every command carries a deadline: past it the command
 * rejects with a `timeout` domain error, which the callers' existing mappers
 * turn into the unavailability error they already answer for an unreachable
 * store. Without one, a request that never answers is a wait nothing ends.
 *
 * `timeoutMs` is the isolate's bound on one round trip to this store, which
 * the composition root puts in force from the mode's registry entry before it
 * builds a client. It is per-mode data rather than a constant here because
 * what a round trip to this store may legitimately take differs by mode, and
 * the entry that carries the value carries that reasoning with it
 * (`RATE_LIMIT_REDIS_TIMEOUT_MS` in `packages/shared/src/env/env.config.ts`).
 * A second entry for these commands would have to be held equal to that one
 * and nothing would hold it: the counter's round trip and these are the same
 * round trip, over the same transport, to the same endpoint.
 *
 * That shared value is also what settles the two deadlines the counter check
 * runs under — its own, and this client's underneath it. They are one value,
 * and the counter's starts first, so the counter's is always the one that
 * expires first and this client cannot reclassify which failure arm it takes.
 *
 * A measurement of the local store establishes the headroom, never the value:
 * taken 2026-09-19 against the local Serverless-Redis-HTTP emulator on a
 * 24-core host held at full CPU saturation, a round trip reached p99 5.3 ms
 * sequential and 9.0 ms at 120-way concurrency, with a worst single
 * observation of 68.9 ms on a cold first request. No mode's bound is sized to
 * that distribution: outside production these round trips cross an emulating
 * proxy on the host the test run is itself saturating, so a bound cut to fit
 * would be measuring the proxy rather than the endpoint it exists to protect.
 * Re-measure to change what the figures say; the entry is what carries the
 * number.
 *
 * The deadline settles the caller and nothing else — the request in flight is
 * left to finish. That is forced by the client rather than chosen: it
 * auto-pipelines, so commands issued in the same tick travel as one batched
 * HTTP request serving all of them, and cancelling that request to free one
 * caller would strip the answers of every other command riding it. The wait a
 * caller experiences is what is bounded here; the batch is not a per-caller
 * resource to reclaim.
 */
export function createBoundedRedis(credentials: RedisCredentials, timeoutMs: number): Redis {
  return boundedSurface(new Redis({ ...credentials }), timeoutPolicy({ timeoutMs }));
}
