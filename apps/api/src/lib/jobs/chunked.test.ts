import { describe, expect, it } from 'vitest';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { chunkedWork } from './chunked.js';
import type { ChunkResult, ChunkedWork, ExecutionBudget } from './chunked.js';

/** A payload of countable units, resumed at an index — the array-cursor shape. */
interface CountingPayload {
  readonly units: readonly string[];
  readonly nextIndex: number;
}

/**
 * A clock the test advances by hand: the loop's only reading of elapsed time,
 * so a budget is spent by the test saying so rather than by real waiting.
 */
function steppableClock(): { now: () => number; advance: (ms: number) => void } {
  let instant = TEST_DAY_START;
  return {
    now: () => instant,
    advance: (ms) => {
      instant += ms;
    },
  };
}

function budgetOf(totalMs: number, now: () => number): ExecutionBudget {
  return { totalMs, now };
}

/** Work whose every chunk advances one unit and spends 3 s of the budget. */
function countingWork(spend: (ms: number) => void): ChunkedWork<CountingPayload> {
  return chunkedWork<CountingPayload, number>({
    readCursor: (payload) => payload.nextIndex,
    withCursor: (payload, nextIndex) => ({ ...payload, nextIndex }),
    runChunk: ({ payload, cursor }): Promise<ChunkResult<CountingPayload, number>> => {
      if (payload.units[cursor] === undefined) return Promise.resolve({ kind: 'ok' });
      spend(3000);
      return Promise.resolve({ kind: 'advance', cursor: cursor + 1 });
    },
  });
}

describe('chunkedWork', () => {
  it('runs consecutive chunks in one execution until the work reports itself done', async () => {
    const clock = steppableClock();
    const seen: string[] = [];
    const work = chunkedWork<CountingPayload, number>({
      readCursor: (payload) => payload.nextIndex,
      withCursor: (payload, nextIndex) => ({ ...payload, nextIndex }),
      runChunk: ({ payload, cursor }): Promise<ChunkResult<CountingPayload, number>> => {
        const unit = payload.units[cursor];
        if (unit === undefined)
          return Promise.resolve({ kind: 'ok', result: { done: seen.length } });
        seen.push(unit);
        return Promise.resolve({ kind: 'advance', cursor: cursor + 1 });
      },
    });

    const outcome = await work.runChunks(
      { units: ['a', 'b', 'c'], nextIndex: 0 },
      budgetOf(10_000, clock.now)
    );

    expect(seen).toEqual(['a', 'b', 'c']);
    expect(outcome).toEqual({ kind: 'ok', result: { done: 3 } });
  });

  it('checkpoints at the cursor the last chunk reached once the soft cutoff is spent', async () => {
    const clock = steppableClock();
    const work = countingWork(clock.advance);

    const outcome = await work.runChunks(
      { units: ['a', 'b', 'c'], nextIndex: 0 },
      // Each chunk spends 3 s of a 10 s budget, so the second lands past the
      // half-budget cutoff and the third never starts.
      budgetOf(10_000, clock.now)
    );

    expect(outcome).toEqual({
      kind: 'yield',
      checkpoint: { units: ['a', 'b', 'c'], nextIndex: 2 },
    });
  });

  it('runs no further chunk after one defers, checkpointing the payload it handed back', async () => {
    const clock = steppableClock();
    let chunks = 0;
    const work = chunkedWork<CountingPayload, number>({
      readCursor: (payload) => payload.nextIndex,
      withCursor: (payload, nextIndex) => ({ ...payload, nextIndex }),
      runChunk: ({ payload }): Promise<ChunkResult<CountingPayload, number>> => {
        chunks += 1;
        return Promise.resolve({ kind: 'defer', payload: { ...payload, nextIndex: 7 } });
      },
    });

    const outcome = await work.runChunks(
      { units: ['a'], nextIndex: 0 },
      budgetOf(10_000, clock.now)
    );

    expect(chunks).toBe(1);
    expect(outcome).toEqual({ kind: 'yield', checkpoint: { units: ['a'], nextIndex: 7 } });
  });

  it('stops the loop at a chunk that failed, carrying its error', async () => {
    const clock = steppableClock();
    let chunks = 0;
    const work = chunkedWork<CountingPayload, number>({
      readCursor: (payload) => payload.nextIndex,
      withCursor: (payload, nextIndex) => ({ ...payload, nextIndex }),
      runChunk: (): Promise<ChunkResult<CountingPayload, number>> => {
        chunks += 1;
        return Promise.resolve({ kind: 'fail', error: 'storage unreachable' });
      },
    });

    const outcome = await work.runChunks(
      { units: ['a', 'b'], nextIndex: 0 },
      budgetOf(10_000, clock.now)
    );

    expect(chunks).toBe(1);
    expect(outcome).toEqual({ kind: 'fail', error: 'storage unreachable' });
  });

  it('stops the loop at a chunk that dead-letters, carrying its error', async () => {
    const clock = steppableClock();
    const work = chunkedWork<CountingPayload, number>({
      readCursor: (payload) => payload.nextIndex,
      withCursor: (payload, nextIndex) => ({ ...payload, nextIndex }),
      runChunk: (): Promise<ChunkResult<CountingPayload, number>> =>
        Promise.resolve({ kind: 'dead', error: 'payload names nothing' }),
    });

    const outcome = await work.runChunks(
      { units: ['a'], nextIndex: 0 },
      budgetOf(10_000, clock.now)
    );

    expect(outcome).toEqual({ kind: 'dead', error: 'payload names nothing' });
  });

  it('defaults a done chunk that reports no result to a null result', async () => {
    const clock = steppableClock();
    const work = chunkedWork<CountingPayload, number>({
      readCursor: (payload) => payload.nextIndex,
      withCursor: (payload, nextIndex) => ({ ...payload, nextIndex }),
      runChunk: (): Promise<ChunkResult<CountingPayload, number>> =>
        Promise.resolve({ kind: 'ok' }),
    });

    const outcome = await work.runChunks({ units: [], nextIndex: 0 }, budgetOf(10_000, clock.now));

    expect(outcome).toEqual({ kind: 'ok', result: null });
  });
});
