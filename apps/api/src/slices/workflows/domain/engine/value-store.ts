import { MediaValue, VALUE_STORE_BYTE_BUDGET_BYTES } from '@hushbox/shared';
import { err, ok } from '../../../../lib/result/index.js';
import type { Result } from '../../../../lib/result/index.js';

/**
 * The in-memory ValueStore seam: mid-flow values live only in DO memory and
 * every store is byte-metered against the run budget. The interface is
 * deliberately preserved even though the in-memory implementation is a
 * passthrough — a future durable executor (R2-ref-based) plugs in here
 * without touching a node OR an interpreter site: every value entering a
 * channel is admitted by `store()` and every value leaving one is fetched by
 * `resolve()`, which the `channel-values-cross-the-value-store` architecture
 * rule holds closed. The rule is what holds it, because {@link ValueStore.resolve}
 * is the identity function here: a read that bypasses the seam has no symptom to
 * betray it until someone swaps the implementation.
 *
 * The metered ceiling ({@link VALUE_STORE_BYTE_BUDGET_BYTES}) assumes a ≥3×
 * real-memory multiplier over these counted bytes (SDK base64
 * dual-materialization, UTF-16 text, the replay buffer) inside the shared
 * ~128 MB isolate.
 */

export interface ValueBudgetExceeded {
  readonly usedBytes: number;
  readonly attemptedBytes: number;
  readonly budgetBytes: number;
}

/**
 * One node's slice of what the run's byte budget has left, held for as long as
 * the node runs. Slices are disjoint, so the download caps outstanding across a
 * level's concurrent siblings sum to at most the free budget instead of each
 * being the whole of it.
 */
export interface ValueReservation {
  readonly allowanceBytes: number;
  release(): void;
}

export interface ValueStore {
  readonly budgetBytes: number;
  /** Meters and admits a value; over-budget rejects without counting it. */
  store<V>(value: V): Result<V, ValueBudgetExceeded>;
  /** Identity in the in-memory implementation; a durable store would fetch refs. */
  resolve<V>(value: V): V;
  usedBytes(): number;
  /**
   * Reserves this node's slice of the free budget, divided by how many more
   * claimants the concurrency ceiling still admits: a node running alone is
   * offered everything left, five siblings a fifth each. The last claimant takes
   * the division's remainder, so no byte is stranded.
   */
  reserve(): ValueReservation;
}

/**
 * The interpreter's own handle on the store. The concurrency ceiling is the
 * width of the level about to run, which only the interpreter knows; a node
 * sees {@link ValueStore} and cannot move it.
 */
export interface RunValueStore extends ValueStore {
  setConcurrencyCeiling(ceiling: number): void;
}

interface ContentValueLike {
  readonly kind?: unknown;
  readonly text?: unknown;
  readonly bytes?: unknown;
  readonly value?: unknown;
}

function measureContentValueLike(value: ContentValueLike): number | undefined {
  if (value.kind === 'text' && typeof value.text === 'string') {
    return value.text.length * 2;
  }
  if (value.kind === 'bytes' && value.bytes instanceof Uint8Array) {
    return value.bytes.byteLength;
  }
  if (value.kind === 'media') {
    const media = MediaValue.safeParse(value.value);
    return media.success ? media.data.byteLength : undefined;
  }
  return undefined;
}

/**
 * Deterministic byte accounting for channel values: UTF-16 for text, real
 * lengths for byte payloads, the declared byteLength for media refs, and
 * serialized size for structured json. Conservative overcounts (a media
 * ref's bytes are not actually resident) are accepted — the budget is
 * hygiene bounding this flow's contribution, never a global OOM guard.
 */
export function measureValueBytes(value?: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'object') return measureObjectBytes(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value).length * 2;
  }
  // Symbols and functions cannot flow through typed channels; nothing to meter.
  return 0;
}

function measureObjectBytes(value: object): number {
  if (value instanceof Uint8Array) return value.byteLength;
  if (Array.isArray(value)) {
    return value.reduce<number>((total, element) => total + measureValueBytes(element), 0);
  }
  const asContent = measureContentValueLike(value as ContentValueLike);
  if (asContent !== undefined) return asContent;
  const asMedia = MediaValue.safeParse(value);
  if (asMedia.success) return asMedia.data.byteLength;
  // Metering a cyclic value would throw here. No shipped node execution can
  // produce one, so a throw is a defect report rather than a byte-budget
  // rejection this is missing.
  return JSON.stringify(value, jsonSafe).length * 2;
}

function jsonSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString(10) : value;
}

export function createValueStore(
  budgetBytes: number = VALUE_STORE_BYTE_BUDGET_BYTES
): RunValueStore {
  let used = 0;
  let ceiling = 1;
  let reserved = 0;
  let outstanding = 0;
  return {
    budgetBytes,
    store: <V>(value: V): Result<V, ValueBudgetExceeded> => {
      const attempted = measureValueBytes(value);
      if (used + attempted > budgetBytes) {
        return err({ usedBytes: used, attemptedBytes: attempted, budgetBytes });
      }
      used += attempted;
      return ok(value);
    },
    resolve: <V>(value: V): V => value,
    usedBytes: (): number => used,
    setConcurrencyCeiling: (next: number): void => {
      ceiling = next;
    },
    reserve: (): ValueReservation => {
      const free = Math.max(0, budgetBytes - used - reserved);
      const allowanceBytes = Math.floor(free / Math.max(1, ceiling - outstanding));
      reserved += allowanceBytes;
      outstanding += 1;
      return {
        allowanceBytes,
        release: (): void => {
          reserved -= allowanceBytes;
          outstanding -= 1;
        },
      };
    },
  };
}
