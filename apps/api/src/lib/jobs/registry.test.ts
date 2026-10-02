import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { chunkedWork } from './chunked.js';
import { jobOutcome } from './outcome.js';
import {
  RECLAIM_MARGIN_SECONDS,
  createJobRegistry,
  enqueueOnlyDeps,
  enqueueOnlyRegistry,
  reclaimLeaseSeconds,
} from './registry.js';
import type { ChunkResult, ExecutionBudget } from './chunked.js';
import type {
  ChunkedJobRegistration,
  JobExecution,
  JobRun,
  OneShotJobRegistration,
} from './registry.js';

const payloadSchema = z.object({ userId: z.string() });

function validRegistration(): OneShotJobRegistration<typeof payloadSchema> {
  return {
    kind: 'oneShot',
    type: 'payment.verify.v1',
    schema: payloadSchema,
    maxExecutionSeconds: 870,
    maxFailures: 5,
    idempotency: 'txn',
    handler: () => Promise.resolve(jobOutcome.ok()),
  };
}

const sweepSchema = z.object({ units: z.array(z.string()), nextIndex: z.number().int().min(0) });

/** A chunked registration whose every chunk records one unit and advances. */
function chunkedRegistration(seen: string[]): ChunkedJobRegistration<typeof sweepSchema> {
  return {
    kind: 'chunked',
    type: 'media.sweep.v1',
    schema: sweepSchema,
    maxExecutionSeconds: 60,
    maxFailures: 5,
    idempotency: 'natural',
    chunked: chunkedWork<z.infer<typeof sweepSchema>, number>({
      readCursor: (payload) => payload.nextIndex,
      withCursor: (payload, nextIndex) => ({ ...payload, nextIndex }),
      runChunk: ({
        payload,
        cursor,
      }): Promise<ChunkResult<z.infer<typeof sweepSchema>, number>> => {
        const unit = payload.units[cursor];
        if (unit === undefined) return Promise.resolve({ kind: 'ok', result: { swept: cursor } });
        seen.push(unit);
        return Promise.resolve({ kind: 'advance', cursor: cursor + 1 });
      },
    }),
  };
}

function executionOf(payload: unknown): JobExecution<unknown> {
  return {
    jobId: crypto.randomUUID(),
    payload,
    claims: 1,
    completeWithinTx: () => {
      throw new Error('this execution writes no terminal transition');
    },
  };
}

/** A budget with an unspent clock: whatever reads it, reads a live one. */
function unspentBudget(): ExecutionBudget {
  return { totalMs: 60_000, now: () => TEST_DAY_START };
}

describe('createJobRegistry', () => {
  it('returns a registered type with registry-derived claim budget', () => {
    const registry = createJobRegistry();
    registry.register(validRegistration());
    const registered = registry.get('payment.verify.v1');
    expect(registered).toMatchObject({
      type: 'payment.verify.v1',
      maxExecutionSeconds: 870,
      maxFailures: 5,
      maxClaims: 8,
      idempotency: 'txn',
      shard: 'default',
    });
  });

  it('returns undefined for an unregistered type', () => {
    const registry = createJobRegistry();
    expect(registry.get('missing.v1')).toBeUndefined();
  });

  it('honors an explicit shard declaration', () => {
    const registry = createJobRegistry();
    registry.register({ ...validRegistration(), shard: 'bulk' });
    expect(registry.get('payment.verify.v1')?.shard).toBe('bulk');
  });

  it('lists registered types', () => {
    const registry = createJobRegistry();
    registry.register(validRegistration());
    expect(registry.types()).toEqual(['payment.verify.v1']);
  });

  it('rejects a duplicate type registration', () => {
    const registry = createJobRegistry();
    registry.register(validRegistration());
    expect(() => {
      registry.register(validRegistration());
    }).toThrow('already registered');
  });

  it('rejects an unversioned type name', () => {
    const registry = createJobRegistry();
    expect(() => {
      registry.register({ ...validRegistration(), type: 'payment.verify' });
    }).toThrow('versioned');
  });

  it('rejects a missing payload schema', () => {
    const registry = createJobRegistry();
    const registration = { ...validRegistration(), schema: undefined } as unknown as ReturnType<
      typeof validRegistration
    >;
    expect(() => {
      registry.register(registration);
    }).toThrow('schema');
  });

  it('rejects a non-positive maxExecutionSeconds', () => {
    const registry = createJobRegistry();
    expect(() => {
      registry.register({ ...validRegistration(), maxExecutionSeconds: 0 });
    }).toThrow('maxExecutionSeconds');
  });

  it('rejects a budget the reclaim margin could consume most of', () => {
    const registry = createJobRegistry();
    expect(() => {
      registry.register({ ...validRegistration(), maxExecutionSeconds: 9 });
    }).toThrow(
      'job registry: payment.verify.v1 maxExecutionSeconds must be an integer between 10 and 895'
    );
  });

  it('accepts the smallest budget that still leaves execution time under the floor', () => {
    const registry = createJobRegistry();
    registry.register({ ...validRegistration(), maxExecutionSeconds: 10 });

    // What the smallest legal budget buys a row stamped under the old scheme,
    // where the authored number was the lease: a positive timer, half the budget.
    expect(10 - RECLAIM_MARGIN_SECONDS).toBeGreaterThan(0);
  });

  it('rejects a fractional maxExecutionSeconds', () => {
    const registry = createJobRegistry();
    expect(() => {
      registry.register({ ...validRegistration(), maxExecutionSeconds: 60.5 });
    }).toThrow('maxExecutionSeconds');
  });

  it('rejects a budget whose derived lease would pass the fifteen-minute alarm wall', () => {
    const registry = createJobRegistry();
    expect(() => {
      registry.register({ ...validRegistration(), maxExecutionSeconds: 896 });
    }).toThrow(
      'job registry: payment.verify.v1 maxExecutionSeconds must be an integer between 10 and 895'
    );
  });

  it('accepts the largest budget whose derived lease still fits the alarm wall', () => {
    const registry = createJobRegistry();
    registry.register({ ...validRegistration(), maxExecutionSeconds: 895 });
    expect(reclaimLeaseSeconds(895)).toBe(900);
  });

  it('derives a row lease strictly greater than the execution budget for every registered type', () => {
    const registry = createJobRegistry();
    for (const [index, maxExecutionSeconds] of [10, 30, 120, 300, 895].entries()) {
      registry.register({
        ...validRegistration(),
        type: `budget.spread${String(index)}.v1`,
        maxExecutionSeconds,
      });
    }

    const registered = registry.types().map((type) => registry.get(type));

    expect(registered).toHaveLength(5);
    for (const job of registered) {
      if (job === undefined) throw new Error('a listed type resolved to nothing');
      expect(reclaimLeaseSeconds(job.maxExecutionSeconds)).toBeGreaterThan(job.maxExecutionSeconds);
    }
  });

  it('derives the row lease by adding the reclaim margin to the budget', () => {
    expect(reclaimLeaseSeconds(300)).toBe(300 + RECLAIM_MARGIN_SECONDS);
  });

  it('rejects a fractional maxFailures', () => {
    const registry = createJobRegistry();
    expect(() => {
      registry.register({ ...validRegistration(), maxFailures: 2.5 });
    }).toThrow('maxFailures');
  });

  it('rejects an unknown idempotency class', () => {
    const registry = createJobRegistry();
    const registration = {
      ...validRegistration(),
      idempotency: 'maybe',
    } as unknown as ReturnType<typeof validRegistration>;
    expect(() => {
      registry.register(registration);
    }).toThrow('idempotency');
  });

  it('rejects a missing handler', () => {
    const registry = createJobRegistry();
    const registration = { ...validRegistration(), handler: undefined } as unknown as ReturnType<
      typeof validRegistration
    >;
    expect(() => {
      registry.register(registration);
    }).toThrow('handler');
  });

  it('rejects an unknown shard', () => {
    const registry = createJobRegistry();
    const registration = { ...validRegistration(), shard: 'fast' } as unknown as ReturnType<
      typeof validRegistration
    >;
    expect(() => {
      registry.register(registration);
    }).toThrow('shard');
  });

  it('hands a one-shot handler its execution and no budget it could read', async () => {
    const registry = createJobRegistry();
    let seenExecution: JobExecution<unknown> | undefined;
    registry.register({
      ...validRegistration(),
      handler: (execution) => {
        seenExecution = execution;
        return Promise.resolve(jobOutcome.ok());
      },
    });
    const registered = registry.get('payment.verify.v1');
    if (registered === undefined) throw new Error('the registered type did not resolve');
    const execution = executionOf({ userId: 'someone' });

    const outcome = await registered.run(execution, {
      totalMs: 60_000,
      // A clock that throws is the proof: a one-shot's work is bounded by a
      // constant, so no budget reaches the handler for it to pace itself by.
      now: () => {
        throw new Error('a one-shot handler must not read the execution clock');
      },
    });

    expect(seenExecution).toBe(execution);
    expect(outcome).toEqual({ kind: 'ok', result: null });
  });

  it('runs a chunked registration through the framework loop', async () => {
    const seen: string[] = [];
    const registry = createJobRegistry();
    registry.register(chunkedRegistration(seen));
    const registered = registry.get('media.sweep.v1');
    if (registered === undefined) throw new Error('the registered type did not resolve');

    const outcome = await registered.run(
      executionOf({ units: ['a', 'b'], nextIndex: 0 }),
      unspentBudget()
    );

    expect(seen).toEqual(['a', 'b']);
    expect(outcome).toEqual({ kind: 'ok', result: { swept: 2 } });
  });

  it('rejects a chunked registration that supplies no framework-built work', () => {
    const registry = createJobRegistry();
    // A work member the builder never minted, which the type refuses outright,
    // so only a cast reaches this runtime check — and the cast stands in for
    // the JavaScript caller the type cannot reach.
    const registration = {
      ...chunkedRegistration([]),
      chunked: undefined,
    } as unknown as ReturnType<typeof chunkedRegistration>;
    expect(() => {
      registry.register(registration);
    }).toThrow('chunked work');
  });

  it('rejects chunked work declaring the transactional class', () => {
    const registry = createJobRegistry();
    // The type excludes the combination outright; the cast is what reaches the
    // runtime arm, which is the one a JavaScript caller can still take.
    const registration = {
      ...chunkedRegistration([]),
      idempotency: 'txn',
    } as unknown as ReturnType<typeof chunkedRegistration>;

    expect(() => {
      registry.register(registration);
    }).toThrow('txn');
  });

  it('rejects a registration that declares neither shape', () => {
    const registry = createJobRegistry();
    // Likewise cast: the union admits two spellings and the compiler knows it.
    const registration = { ...validRegistration(), kind: 'whenever' } as unknown as ReturnType<
      typeof validRegistration
    >;
    expect(() => {
      registry.register(registration);
    }).toThrow('kind');
  });
});

describe('jobOutcome', () => {
  it('builds an ok outcome with a null default result', () => {
    expect(jobOutcome.ok()).toEqual({ kind: 'ok', result: null });
  });

  it('builds an ok outcome carrying its result', () => {
    expect(jobOutcome.ok({ exported: 3 })).toEqual({ kind: 'ok', result: { exported: 3 } });
  });

  it('builds a fail outcome', () => {
    expect(jobOutcome.fail('gateway-5xx')).toEqual({ kind: 'fail', error: 'gateway-5xx' });
  });

  it('builds a yield outcome carrying its checkpoint', () => {
    expect(jobOutcome.yield({ cursor: 'abc' })).toEqual({
      kind: 'yield',
      checkpoint: { cursor: 'abc' },
    });
  });

  it('builds a dead outcome', () => {
    expect(jobOutcome.dead('payload-unparseable')).toEqual({
      kind: 'dead',
      error: 'payload-unparseable',
    });
  });
});

describe('enqueueOnlyDeps', () => {
  it('hands the same eagerly-built dependency set to every resolution', () => {
    const built = { sender: {} };
    const resolve = enqueueOnlyDeps(built);

    expect(resolve()).toBe(built);
    expect(resolve()).toBe(built);
  });
});

describe('enqueueOnlyRegistry', () => {
  it('carries every field the enqueue path reads', () => {
    const registry = createJobRegistry();
    registry.register({ ...validRegistration(), shard: 'bulk' });

    expect(enqueueOnlyRegistry(registry).get('payment.verify.v1')).toEqual({
      type: 'payment.verify.v1',
      schema: payloadSchema,
      maxExecutionSeconds: 870,
      maxFailures: 5,
      maxClaims: 8,
      idempotency: 'txn',
      shard: 'bulk',
    });
  });

  it('returns undefined for an unregistered type', () => {
    expect(enqueueOnlyRegistry(createJobRegistry()).get('missing.v1')).toBeUndefined();
  });

  it('leaves a runner cast nothing to call', () => {
    const registry = createJobRegistry();
    registry.register(validRegistration());

    const escaped = enqueueOnlyRegistry(registry).get('payment.verify.v1') as unknown as {
      run?: JobRun;
    };

    expect(escaped.run).toBeUndefined();
  });
});
