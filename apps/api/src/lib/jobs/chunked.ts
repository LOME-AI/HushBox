import { jobOutcome } from './outcome.js';
import type { JobOutcome } from './outcome.js';

/**
 * How much of an execution's budget the loop will start another chunk inside.
 * The last chunk starts before the cutoff and finishes after it, so what the
 * cutoff leaves has to cover one whole chunk: a chunk still running when the
 * budget expires is killed and costs the row a failure. Whether a registration
 * is inside that bound is derived from its own declarations — the number of
 * calls one chunk makes to its slowest dependency, which is how many times it
 * invokes that dependency and not how many items it carries, times what one
 * such call costs at worst: that dependency's per-attempt timeout, times its
 * attempts, plus the backoff the retry policy waits between those attempts,
 * which runs on the same budget and is counted — so the bound holds only
 * while those dependencies stay inside the timeouts they declare.
 * The term to go find is that per-attempt timeout: a dependency reached
 * through a shared adapter carries whatever window that adapter resolves for
 * it, so the number this bound turns on can sit in another slice and move
 * without the registration's own file changing.
 */
const CHUNK_SOFT_CUTOFF_FRACTION = 0.5;

/**
 * The execution budget a chunked job's loop runs against, as the dispatcher
 * computed it for the row in hand. Handed to the loop rather than to the work:
 * a chunk supplies one unit and reads no clock, so it cannot compute a deadline
 * of its own and cannot outlive the one the executor set.
 */
export interface ExecutionBudget {
  /** The whole budget this execution may run for. */
  readonly totalMs: number;
  /** The executor's clock — the only clock a chunk loop reads. */
  readonly now: () => number;
}

/**
 * What one chunk reports. It is {@link JobOutcome} less the two the framework
 * owns — `yield`, which only the loop issues, and `completed`, which only a
 * self-completing handler holds — plus the two a loop needs: `advance` (more
 * work, resume here) and `defer` (no work available now).
 */
export type ChunkResult<Payload, Cursor> =
  | { readonly kind: 'advance'; readonly cursor: Cursor }
  | { readonly kind: 'defer'; readonly payload: Payload }
  | { readonly kind: 'ok'; readonly result?: unknown }
  | { readonly kind: 'fail'; readonly error: string }
  | { readonly kind: 'dead'; readonly error: string };

/** Everything a chunked registration supplies: a cursor, and one unit of work. */
interface ChunkedWorkSpec<Payload, Cursor> {
  readonly readCursor: (payload: Payload) => Cursor;
  readonly withCursor: (payload: Payload, cursor: Cursor) => Payload;
  readonly runChunk: (input: {
    readonly payload: Payload;
    readonly cursor: Cursor;
  }) => Promise<ChunkResult<Payload, Cursor>>;
}

/**
 * The mark {@link chunkedWork} puts on the loop it builds, exported nowhere.
 *
 * It blocks minting, not copying, and the difference is the whole of what it
 * buys. An object literal cannot produce a marked value, because naming a
 * symbol is the only way to write its key and this one is unreachable outside
 * this module. A spread copies the key rather than naming it, so a real builder
 * result spread into a literal that overrides `runChunks` carries the mark and
 * compiles with no cast. That leaves a hand-written loop reachable only by
 * copying a builder result and overriding its loop — the spread above is one
 * such copy, and any route that copies own keys carries the mark alike — which
 * reads as the circumvention it is, while the literal anyone would otherwise
 * reach for is refused.
 */
const CHUNK_LOOP: unique symbol = Symbol('chunked work loop');

/**
 * A registration's chunk loop, its cursor type erased. Without the mark this
 * interface is structural, and any object supplying `runChunks` satisfies it —
 * a hand-written loop that takes the budget and reads its clock would be the
 * easy path. The mark refuses that literal; it does not refuse a spread of a
 * builder result, and {@link CHUNK_LOOP} records where the line falls.
 */
export interface ChunkedWork<Payload> {
  readonly [CHUNK_LOOP]: true;
  readonly runChunks: (payload: Payload, budget: ExecutionBudget) => Promise<JobOutcome>;
}

/**
 * The framework's chunk loop: it runs chunks while work remains and the budget
 * is not nearly spent, then checkpoints at the cursor the last chunk reached.
 * Owning the loop here is what keeps unbounded work between checkpoints off the
 * path an author writes — a registration supplies one unit of work and never a
 * loop, a `jobOutcome.yield`, or a clock read. How far the type enforces that,
 * and where it stops: {@link CHUNK_LOOP}.
 */
export function chunkedWork<Payload, Cursor>(
  spec: ChunkedWorkSpec<Payload, Cursor>
): ChunkedWork<Payload> {
  return {
    [CHUNK_LOOP]: true,
    runChunks: async (payload, budget): Promise<JobOutcome> => {
      const startedAt = budget.now();
      const softCutoffMs = budget.totalMs * CHUNK_SOFT_CUTOFF_FRACTION;
      let current = payload;
      for (;;) {
        const result = await spec.runChunk({
          payload: current,
          cursor: spec.readCursor(current),
        });
        switch (result.kind) {
          case 'ok': {
            return jobOutcome.ok(result.result);
          }
          case 'fail': {
            return jobOutcome.fail(result.error);
          }
          case 'dead': {
            return jobOutcome.dead(result.error);
          }
          case 'defer': {
            return jobOutcome.yield(result.payload);
          }
          case 'advance': {
            current = spec.withCursor(current, result.cursor);
            break;
          }
        }
        if (budget.now() - startedAt >= softCutoffMs) return jobOutcome.yield(current);
      }
    },
  };
}
