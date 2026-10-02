import { serializeFrame } from './protocol.js';
import type { FlowStreamEvent } from '@hushbox/shared';

/**
 * Memory-only, current-run-only replay buffer (the resumable-stream
 * mechanism). Cursor contract:
 *
 * - Cursors are per-stream, strictly increasing integers starting at 1; the
 *   executor allocates them, the buffer enforces them (violation = defect).
 * - A live stream retains its complete event history, so any
 *   `0 ≤ lastEventId ≤ lastCursor` resumes without a gap.
 * - Overflowing `maxStreamBytes` drops that stream's replay permanently for
 *   the run: resume answers `gone` — the explicit signal, never a silent
 *   gap — and the client falls back to fetch-after-settlement. Live
 *   delivery is unaffected (buffering serves replay only).
 * - `maxRunBytes` bounds the total the buffer retains across every stream of
 *   the run. Crossing it evicts whole streams to the same `gone` signal:
 *   the stream that finished longest ago first, and the largest stream that
 *   has not finished only once no finished stream is left. A finished
 *   stream's frames are the ones settlement can hand back, so a stream still
 *   producing — including one that dies without a terminal event — is
 *   sacrificed last.
 * - `lastEventId > lastCursor` claims events the room never produced:
 *   also `gone` (the client's state is unrecoverable from here).
 * - The buffer lives for exactly one run: the room constructs a fresh
 *   instance at run start and drops its reference at run end — post-run
 *   replay is the normal message fetch.
 */

interface ReplayBufferOptions {
  /** Per-stream byte budget, metered on the serialized stream frame. */
  readonly maxStreamBytes: number;
  /** Run-total byte budget across every stream; unset leaves the total unbounded. */
  readonly maxRunBytes?: number | undefined;
}

type AppendOutcome = 'buffered' | 'dropped';

type ResumeResult =
  | { readonly kind: 'replay'; readonly events: readonly FlowStreamEvent[] }
  | { readonly kind: 'gone' };

interface StreamState {
  events: FlowStreamEvent[];
  bytes: number;
  lastCursor: number;
  gone: boolean;
  /** Rank of this stream's terminal event among the run's finishes; absent while it is live. */
  finishOrder?: number;
}

const utf8 = new TextEncoder();

export class ReplayBuffer {
  private readonly streams = new Map<string, StreamState>();
  private readonly maxStreamBytes: number;
  private readonly maxRunBytes: number;
  private runBytes = 0;
  private finishes = 0;

  constructor(options: ReplayBufferOptions) {
    this.maxStreamBytes = options.maxStreamBytes;
    this.maxRunBytes = options.maxRunBytes ?? Number.POSITIVE_INFINITY;
  }

  append(event: FlowStreamEvent): AppendOutcome {
    const state = this.streams.get(event.streamId) ?? {
      events: [],
      bytes: 0,
      lastCursor: 0,
      gone: false,
    };
    if (event.cursor <= state.lastCursor) {
      throw new Error(
        `replay-buffer: stream cursor must increase strictly (got ${String(event.cursor)} after ${String(state.lastCursor)})`
      );
    }
    state.lastCursor = event.cursor;
    this.streams.set(event.streamId, state);
    if (state.gone) {
      return 'dropped';
    }
    const bytes = utf8.encode(
      serializeFrame({
        type: 'stream',
        streamId: event.streamId,
        cursor: event.cursor,
        event: event.event,
      })
    ).length;
    state.bytes += bytes;
    this.runBytes += bytes;
    if (state.bytes > this.maxStreamBytes) {
      this.drop(state);
      return 'dropped';
    }
    state.events.push(event);
    if (event.event.kind === 'finish') {
      this.finishes += 1;
      state.finishOrder = this.finishes;
    }
    let evictedSelf = false;
    for (
      let victim = this.overBudgetVictim();
      victim !== undefined;
      victim = this.overBudgetVictim()
    ) {
      evictedSelf ||= victim === state;
      this.drop(victim);
    }
    return evictedSelf ? 'dropped' : 'buffered';
  }

  resume(streamId: string, lastEventId: number): ResumeResult {
    const state = this.streams.get(streamId);
    if (!state || state.gone || lastEventId > state.lastCursor) {
      return { kind: 'gone' };
    }
    return { kind: 'replay', events: state.events.filter((event) => event.cursor > lastEventId) };
  }

  private drop(state: StreamState): void {
    state.events = [];
    state.gone = true;
    this.runBytes -= state.bytes;
    state.bytes = 0;
  }

  private overBudgetVictim(): StreamState | undefined {
    if (this.runBytes <= this.maxRunBytes) {
      return undefined;
    }
    let finished: StreamState | undefined;
    let finishedOrder = Number.POSITIVE_INFINITY;
    let live: StreamState | undefined;
    let liveBytes = -1;
    for (const state of this.streams.values()) {
      if (state.gone) {
        continue;
      }
      if (state.finishOrder === undefined) {
        if (state.bytes > liveBytes) {
          live = state;
          liveBytes = state.bytes;
        }
      } else if (state.finishOrder < finishedOrder) {
        finished = state;
        finishedOrder = state.finishOrder;
      }
    }
    return finished ?? live;
  }
}
