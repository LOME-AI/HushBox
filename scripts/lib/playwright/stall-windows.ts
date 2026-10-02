/**
 * Two readings of whether the API worker's isolate froze during a run.
 *
 * Isolate stalls, {@link detectIsolateStalls}, are the freezes themselves: the
 * windows in which the isolate answered no heap probe. They are read from the
 * prober's own record, so a run with the probe off has none to report, which
 * is stated as not measured rather than as zero.
 *
 * Traffic-gated completion gaps, {@link scoreTrafficGatedCompletionGaps}, are
 * the reading that works with the probe off, which is what a probe-on/probe-off
 * comparison needs: the probe cannot score its own absence. A gap between two
 * consecutive `request completed` lines is produced by the API regardless of
 * who is watching it, so both arms are scored by the same instrument. It is not
 * a freeze detector. A line's instant is when wrangler received it, which can
 * trail the isolate by many seconds, and a few requests landing inside a freeze
 * split its gap into pieces the traffic gate reads as idle.
 *
 * Idle is not a freeze. A suite between phases, or winding down, completes
 * nothing for seconds at a time without anything being wrong, so a gap counts
 * only when the traffic on both sides of it was above {@link BUSY_RATE_PER_SECOND}
 * — the run was asking for work, and got none.
 *
 * The re-bundle and dropped-request counts ride along because they come from
 * the same file and bear on the same question: each re-bundle replaces the user
 * Worker, which is a window in which a request forward finds nothing to reach,
 * so it is a candidate cause of the drops alongside the stalls.
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/** A gap this long or longer between consecutive completions is a completion-gap window. */
export const COMPLETION_GAP_SECONDS = 4;

/**
 * The completion rate on both sides of a gap that makes it count rather than
 * read as an idle stretch. Ten per second is roughly a tenth of what twelve
 * Playwright workers sustain against a healthy API, so it admits every real
 * phase while excluding the ramp-up, the wind-down and the pauses between
 * phases.
 */
export const BUSY_RATE_PER_SECOND = 10;

/**
 * How many completions on each side the rate is measured over. Small enough
 * that a phase boundary a few requests wide does not veto a genuine window,
 * large enough that one slow request cannot make a phase look idle.
 */
export const BUSY_SAMPLE_COMPLETIONS = 10;

const MS_PER_SECOND = 1000;

/**
 * The `msg` the API's request-log middleware stamps on every per-request line
 * (`apps/api/src/middleware/request-log.ts`). PRODUCER→CONSUMER parse contract,
 * not a second implementation: the middleware is the sole producer, and its
 * `msg` is deliberately an inline literal there because the
 * `redaction/logger-msg-literal` rule requires a syntactic string at the call
 * site — so the producer cannot reference a shared constant and this consumer
 * names its own copy, as `scripts/lib/mobile/extract-mobile-api-log.ts` does.
 */
const REQUEST_LOG_MSG = 'request completed';

/** Wrangler's line for the start of a worker re-bundle. */
const RELOAD_MARKER = '⎔ Reloading local server...';

/**
 * Wrangler's line for a request the dev proxy could not forward — the dev
 * server's own spelling of a dropped request. An earlier
 * `Could not proxy … Network connection lost` spelling belonged to a vendored
 * wrangler patch that no longer exists, so matching on it counts nothing while
 * the event still happens.
 */
const DROPPED_REQUEST_MARKER =
  'Error inside ProxyWorker (the affected request failed; the dev server continues)';

/** Wrangler's block header: `--- <iso instant> <level>`. */
const BLOCK_HEADER = /^--- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \w+$/u;

/** How much of the log one read holds; the file itself runs to hundreds of MB. */
const CHUNK_BYTES = 1 << 20;

interface CompletionGapWindow {
  /** Where the window opens, in seconds from the first completion in the log. */
  startOffsetSeconds: number;
  seconds: number;
}

export interface TrafficGatedCompletionGapScore {
  completions: number;
  /** First completion to last, in seconds. */
  measuredSpanSeconds: number;
  windowCount: number;
  totalSeconds: number;
  longestSeconds: number;
  /** {@link TrafficGatedCompletionGapScore.totalSeconds} over {@link TrafficGatedCompletionGapScore.measuredSpanSeconds}. */
  frozenFraction: number;
  windows: CompletionGapWindow[];
}

export interface DebugLogEvents {
  /** Every completed request in the log, in the order it was written. */
  completionsMs: number[];
  reBundles: number;
  droppedRequests: number;
}

export interface LogReadOptions {
  /**
   * Score only what the log recorded at or after this instant.
   *
   * The dev server outlives any one run and truncates its log only when it
   * restarts, so a log read at the end of a run holds every earlier run against
   * the same server too. Without this, a second arm of a comparison would be
   * scored over the first arm as well.
   */
  sinceMs?: number;
  /** Overridable for tests, which prove a line straddling a boundary reads the same. */
  chunkBytes?: number;
}

export type ScoredDebugLog = TrafficGatedCompletionGapScore & Omit<DebugLogEvents, 'completionsMs'>;

/** A heap probe left unanswered this long or longer is the isolate answering nothing. */
export const ISOLATE_STALL_MS = 2000;

/** One heap probe's wait for its reply, in milliseconds of whichever clock recorded it. */
export interface HeapProbeRound {
  sentMs: number;
  /** When the reply arrived; for a probe never answered, when the prober stopped waiting for it. */
  endedMs: number;
  /** False when the connection closed, or sampling stopped, before the reply arrived. */
  answered: boolean;
}

/** A window in which the isolate answered no heap probe, in the frame of the rounds it was derived from. */
export interface IsolateStall {
  /**
   * The isolate stopped answering after this instant: the latest end, at or before the window's
   * opening, of a probe wait a reply ended, each wait ending at the first reply to any probe (see
   * {@link waitsEndedByAnyReply}); null when none had. It can precede the last reply received.
   */
  onsetAfterMs: number | null;
  /** It had stopped by this instant: the first probe the window holds, which is where the window opens. */
  onsetByMs: number;
  /** The reply that ended the window; null when none came before the prober stopped waiting. */
  releaseMs: number | null;
  /** From {@link IsolateStall.onsetByMs} to the window's end, released or not. */
  seconds: number;
}

interface ProbeSpan {
  startMs: number;
  endMs: number;
}

/**
 * Each probe's wait as it bears on a freeze: ended by its own reply, or by the
 * first reply to any probe received after it was sent, whichever came first.
 * The isolate answered at that instant, so no freeze runs past it.
 *
 * Wrangler's inspector proxy keeps the client's socket open when it replaces
 * the runtime behind it, so a probe forwarded to the old runtime is never
 * answered. Measured by its own reply alone, that probe would hold one window
 * open until sampling stopped and swallow every later freeze.
 */
function waitsEndedByAnyReply(rounds: readonly HeapProbeRound[]): HeapProbeRound[] {
  const replies = rounds
    .filter((round) => round.answered)
    .map((round) => round.endedMs)
    .toSorted((a, b) => a - b);
  return rounds.map((round) => {
    const firstReplyMs = replies.find((replyMs) => replyMs > round.sentMs);
    // A reply later than the probe's own end leaves it alone: that is what keeps a 0 ms reply,
    // or a wait its connection's close ended, from being stretched to the next reply.
    if (firstReplyMs === undefined || firstReplyMs > round.endedMs) return round;
    return { sentMs: round.sentMs, endedMs: firstReplyMs, answered: true };
  });
}

/**
 * The windows in which the isolate answered no heap probe: every probe
 * outstanding {@link ISOLATE_STALL_MS} or longer, unioned, where a probe stops
 * waiting at the first reply to any probe (see {@link waitsEndedByAnyReply}).
 *
 * Read from the prober's own record rather than from wrangler's debug log. The
 * log's completion lines carry the instant wrangler received them, which can
 * trail the isolate by many seconds, and its probe lines are a vendor's debug
 * spelling, whose change would silently empty a detector that parsed it.
 *
 * A record that holds no probe measured nothing, so it answers null rather
 * than an empty list that would read as a run without a freeze.
 */
export function detectIsolateStalls(record: readonly HeapProbeRound[]): IsolateStall[] | null {
  if (record.length === 0) return null;

  const rounds = waitsEndedByAnyReply(record);
  const late = rounds
    .filter((round) => round.endedMs - round.sentMs >= ISOLATE_STALL_MS)
    .toSorted((a, b) => a.sentMs - b.sentMs);
  const spans: ProbeSpan[] = [];
  for (const round of late) {
    const open = spans.at(-1);
    if (open !== undefined && round.sentMs <= open.endMs) {
      open.endMs = Math.max(open.endMs, round.endedMs);
    } else {
      spans.push({ startMs: round.sentMs, endMs: round.endedMs });
    }
  }

  return spans.map(({ startMs, endMs }) => {
    const repliesBefore = rounds
      .filter((round) => round.answered && round.endedMs <= startMs)
      .map((round) => round.endedMs);
    const released = late.some((round) => round.answered && round.endedMs === endMs);
    return {
      onsetAfterMs: repliesBefore.length === 0 ? null : Math.max(...repliesBefore),
      onsetByMs: startMs,
      releaseMs: released ? endMs : null,
      seconds: roundSeconds((endMs - startMs) / MS_PER_SECOND),
    };
  });
}

function roundSeconds(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * True when `line` is one structured request-log line from the API. Only a
 * line that IS the log line counts: wrangler echoes the same text back inside
 * `[InspectorProxyWorker] SEND TO DEVTOOLS` blocks whenever an inspector client
 * is attached, so a substring match would count every completion twice in the
 * probe-on arm and once in the probe-off arm — which is exactly the comparison
 * this module exists to make honest.
 */
function isCompletionLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed) as { msg?: unknown };
    return parsed.msg === REQUEST_LOG_MSG;
  } catch {
    return false;
  }
}

/**
 * Whether `BUSY_SAMPLE_COMPLETIONS` completions spanning `fromMs`..`toMs` came
 * in at or above the busy floor. An absent end is a phase the log does not
 * hold — the ramp-up before the first completions and the wind-down after the
 * last — and is never busy, because a gap at either edge of the record cannot
 * be told from the record simply ending.
 */
function isBusy(fromMs: number | undefined, toMs: number | undefined): boolean {
  if (fromMs === undefined || toMs === undefined) return false;
  const spanMs = toMs - fromMs;
  if (spanMs <= 0) return true;
  return (BUSY_SAMPLE_COMPLETIONS - 1) * MS_PER_SECOND >= BUSY_RATE_PER_SECOND * spanMs;
}

const EMPTY_SCORE: TrafficGatedCompletionGapScore = {
  completions: 0,
  measuredSpanSeconds: 0,
  windowCount: 0,
  totalSeconds: 0,
  longestSeconds: 0,
  frozenFraction: 0,
  windows: [],
};

export function scoreTrafficGatedCompletionGaps(
  completionsMs: readonly number[]
): TrafficGatedCompletionGapScore {
  const first = completionsMs[0];
  if (first === undefined) return { ...EMPTY_SCORE };

  const windows: CompletionGapWindow[] = [];
  let totalSeconds = 0;
  let longestSeconds = 0;
  let previousMs = first;
  for (const [index, completedAt] of completionsMs.entries()) {
    const openedAt = previousMs;
    previousMs = completedAt;
    const gapSeconds = (completedAt - openedAt) / MS_PER_SECOND;
    if (gapSeconds < COMPLETION_GAP_SECONDS) continue;
    if (!isBusy(completionsMs[index - BUSY_SAMPLE_COMPLETIONS], completionsMs[index - 1])) continue;
    if (!isBusy(completionsMs[index], completionsMs[index + BUSY_SAMPLE_COMPLETIONS - 1])) continue;
    const seconds = roundSeconds(gapSeconds);
    totalSeconds = roundSeconds(totalSeconds + seconds);
    longestSeconds = Math.max(longestSeconds, seconds);
    windows.push({ startOffsetSeconds: roundSeconds((openedAt - first) / MS_PER_SECOND), seconds });
  }

  const measuredSpanSeconds = roundSeconds((previousMs - first) / MS_PER_SECOND);
  return {
    completions: completionsMs.length,
    measuredSpanSeconds,
    windowCount: windows.length,
    totalSeconds,
    longestSeconds,
    frozenFraction: measuredSpanSeconds === 0 ? 0 : totalSeconds / measuredSpanSeconds,
    windows,
  };
}

/**
 * Reads the whole log a line at a time, holding one chunk rather than the file.
 * Synchronous because the reporter's only caller is its flush, which a signal
 * handler reaches and which therefore cannot await.
 *
 * An absent log reads as an empty series: a run that named no API port, or one
 * whose dev server wrote nothing, is a run with nothing to score rather than a
 * failure — the report itself must still land.
 */
export function readDebugLogEvents(logPath: string, options: LogReadOptions = {}): DebugLogEvents {
  const events: DebugLogEvents = { completionsMs: [], reBundles: 0, droppedRequests: 0 };
  if (!existsSync(logPath)) return events;

  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
  const sinceMs = options.sinceMs ?? Number.NEGATIVE_INFINITY;
  const handle = openSync(logPath, 'r');
  // A completion with no header above it has no instant to carry, which the
  // log's own framing makes unreachable; scoring it at zero would invent one,
  // and a run window could not exclude it.
  let blockMs: number | null = null;

  const takeLine = (line: string): void => {
    const instant = BLOCK_HEADER.exec(line)?.[1];
    if (instant !== undefined) {
      blockMs = Date.parse(instant);
      return;
    }
    if (blockMs === null || blockMs < sinceMs) return;
    if (line.includes(RELOAD_MARKER)) events.reBundles++;
    if (line.includes(DROPPED_REQUEST_MARKER)) events.droppedRequests++;
    if (isCompletionLine(line)) events.completionsMs.push(blockMs);
  };

  try {
    const buffer = Buffer.alloc(chunkBytes);
    // A chunk boundary can fall inside a multi-byte character as easily as
    // inside a line; the decoder holds the partial character exactly as `carry`
    // holds the partial line.
    const decoder = new StringDecoder('utf8');
    let carry = '';
    let read = readSync(handle, buffer, 0, chunkBytes, null);
    while (read > 0) {
      const text = carry + decoder.write(buffer.subarray(0, read));
      const lastBreak = text.lastIndexOf('\n');
      carry = text.slice(lastBreak + 1);
      if (lastBreak >= 0) for (const line of text.slice(0, lastBreak).split('\n')) takeLine(line);
      read = readSync(handle, buffer, 0, chunkBytes, null);
    }
    // A file whose last line carries no newline still ends on a line.
    carry += decoder.end();
    if (carry !== '') takeLine(carry);
  } finally {
    closeSync(handle);
  }
  return events;
}

/** The traffic-gated completion-gap score of one wrangler debug log, with its two counts beside it. */
export function scoreWranglerDebugLog(
  logPath: string,
  options: LogReadOptions = {}
): ScoredDebugLog {
  const events = readDebugLogEvents(logPath, options);
  return {
    ...scoreTrafficGatedCompletionGaps(events.completionsMs),
    reBundles: events.reBundles,
    droppedRequests: events.droppedRequests,
  };
}
