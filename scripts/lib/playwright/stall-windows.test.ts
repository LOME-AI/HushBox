import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SECOND_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import {
  BUSY_RATE_PER_SECOND,
  BUSY_SAMPLE_COMPLETIONS,
  ISOLATE_STALL_MS,
  COMPLETION_GAP_SECONDS,
  detectIsolateStalls,
  readDebugLogEvents,
  scoreTrafficGatedCompletionGaps,
  scoreWranglerDebugLog,
  type DebugLogEvents,
  type HeapProbeRound,
} from './stall-windows.js';

/** One wrangler debug-log block: its `--- <iso> <level>` header, body, and closing rule. */
function block(instantMs: number, level: string, body: string): string {
  return `--- ${isoAt(instantMs)} ${level}\n${body}\n---\n\n`;
}

function completionBlock(instantMs: number, route = '/health'): string {
  return block(
    instantMs,
    'info',
    `{"level":"info","msg":"request completed","route":"${route}","method":"GET","statusCode":200,"latencyMs":4}`
  );
}

/**
 * Completions at a steady rate, starting at `startMs`. Fast enough that a gap
 * beside them is scored: the busy floor is a rate, so the fixture states the
 * rate rather than an interval a reader would have to divide out.
 */
function busyRun(startMs: number, count: number, perSecond = BUSY_RATE_PER_SECOND * 2): number[] {
  const step = SECOND_MS / perSecond;
  return Array.from({ length: count }, (_, index) => startMs + index * step);
}

describe('detectIsolateStalls', () => {
  /** How long a probe the isolate answers straight away waits for its reply. */
  const PROMPT_MS = 5;
  const PROBE_EVERY_MS = 2 * SECOND_MS;
  const COMPLETION_EVERY_MS = SECOND_MS / 20;

  /**
   * The reproduction run, in the run frame. A busy phase of 40 completions at
   * 20/s ends where the freeze opens; for 11.8 s the isolate answers nothing,
   * though 3 completions land 2.5 s in; 30 completions at 20/s follow the
   * release; then a quiet minute holds one `/health` completion every 10 s.
   * The completions are what the traffic-gated score reads and are not this
   * detector's input, so only the instants they fix appear here.
   */
  const BUSY_PHASE_OPENS_MS = SECOND_MS;
  const FREEZE_OPENS_MS = BUSY_PHASE_OPENS_MS + 39 * COMPLETION_EVERY_MS;
  const FREEZE_RELEASES_MS = FREEZE_OPENS_MS + 11_800;
  const QUIET_MINUTE_ENDS_MS = FREEZE_RELEASES_MS + 29 * COMPLETION_EVERY_MS + 60 * SECOND_MS;

  /** A probe every 2 s, answered promptly unless it was sent into the freeze, which answers it at the release. */
  function reproductionRecord(): HeapProbeRound[] {
    const rounds: HeapProbeRound[] = [];
    for (let sentMs = 0; sentMs <= QUIET_MINUTE_ENDS_MS; sentMs += PROBE_EVERY_MS) {
      const frozen = sentMs > FREEZE_OPENS_MS && sentMs < FREEZE_RELEASES_MS;
      rounds.push({
        sentMs,
        endedMs: frozen ? FREEZE_RELEASES_MS : sentMs + PROMPT_MS,
        answered: true,
      });
    }
    return rounds;
  }

  it("names the reproduction run's one freeze, from its onset bracket to its release", () => {
    const lastPromptProbeMs = Math.floor(FREEZE_OPENS_MS / PROBE_EVERY_MS) * PROBE_EVERY_MS;
    const firstLateProbeMs = lastPromptProbeMs + PROBE_EVERY_MS;

    expect(detectIsolateStalls(reproductionRecord())).toEqual([
      {
        onsetAfterMs: lastPromptProbeMs + PROMPT_MS,
        onsetByMs: firstLateProbeMs,
        releaseMs: FREEZE_RELEASES_MS,
        seconds: (FREEZE_RELEASES_MS - firstLateProbeMs) / SECOND_MS,
      },
    ]);
    expect(firstLateProbeMs - FREEZE_OPENS_MS).toBeLessThanOrEqual(PROBE_EVERY_MS);
  });

  it('states a record that holds no probe as not measured', () => {
    expect(detectIsolateStalls([])).toBeNull();
  });

  /** One probe, sent at `sentMs` and waiting `waitMs` for the reply, or for the prober to stop waiting. */
  function probe(sentMs: number, waitMs: number, answered = true): HeapProbeRound {
    return { sentMs, endedMs: sentMs + waitMs, answered };
  }

  it('finds no window when every probe was answered promptly', () => {
    expect(detectIsolateStalls([probe(0, PROMPT_MS), probe(PROBE_EVERY_MS, PROMPT_MS)])).toEqual(
      []
    );
  });

  it('leaves a probe answered just inside the bound out of every window', () => {
    expect(
      detectIsolateStalls([probe(0, PROMPT_MS), probe(PROBE_EVERY_MS, ISOLATE_STALL_MS - 1)])
    ).toEqual([]);
  });

  it('opens a window on a probe outstanding exactly the bound', () => {
    expect(
      detectIsolateStalls([probe(0, PROMPT_MS), probe(PROBE_EVERY_MS, ISOLATE_STALL_MS)])
    ).toEqual([
      {
        onsetAfterMs: PROMPT_MS,
        onsetByMs: PROBE_EVERY_MS,
        releaseMs: PROBE_EVERY_MS + ISOLATE_STALL_MS,
        seconds: ISOLATE_STALL_MS / SECOND_MS,
      },
    ]);
  });

  it('keeps two freezes apart when a prompt reply falls between them', () => {
    const firstReleaseMs = 4 * PROBE_EVERY_MS + PROMPT_MS * 100;
    const secondReleaseMs = 8 * PROBE_EVERY_MS + PROMPT_MS * 100;
    const record = [
      probe(PROBE_EVERY_MS, PROMPT_MS),
      probe(2 * PROBE_EVERY_MS, firstReleaseMs - 2 * PROBE_EVERY_MS),
      probe(3 * PROBE_EVERY_MS, firstReleaseMs - 3 * PROBE_EVERY_MS),
      probe(5 * PROBE_EVERY_MS, PROMPT_MS),
      probe(6 * PROBE_EVERY_MS, secondReleaseMs - 6 * PROBE_EVERY_MS),
      probe(7 * PROBE_EVERY_MS, secondReleaseMs - 7 * PROBE_EVERY_MS),
    ];

    expect(
      detectIsolateStalls(record)?.map(({ onsetAfterMs, onsetByMs, releaseMs }) => ({
        onsetAfterMs,
        onsetByMs,
        releaseMs,
      }))
    ).toEqual([
      {
        onsetAfterMs: PROBE_EVERY_MS + PROMPT_MS,
        onsetByMs: 2 * PROBE_EVERY_MS,
        releaseMs: firstReleaseMs,
      },
      {
        onsetAfterMs: 5 * PROBE_EVERY_MS + PROMPT_MS,
        onsetByMs: 6 * PROBE_EVERY_MS,
        releaseMs: secondReleaseMs,
      },
    ]);
  });

  it('leaves a window no reply ended unreleased, lasting until the prober stopped waiting', () => {
    const stoppedWaitingMs = 5 * PROBE_EVERY_MS;
    const record = [
      probe(0, PROMPT_MS),
      probe(PROBE_EVERY_MS, stoppedWaitingMs - PROBE_EVERY_MS, false),
      probe(2 * PROBE_EVERY_MS, stoppedWaitingMs - 2 * PROBE_EVERY_MS, false),
    ];

    expect(detectIsolateStalls(record)).toEqual([
      {
        onsetAfterMs: PROMPT_MS,
        onsetByMs: PROBE_EVERY_MS,
        releaseMs: null,
        seconds: (stoppedWaitingMs - PROBE_EVERY_MS) / SECOND_MS,
      },
    ]);
  });

  it('leaves the onset unbounded below when no reply preceded the window', () => {
    const [stall] = detectIsolateStalls([probe(0, 3 * SECOND_MS)]) ?? [];

    expect(stall?.onsetAfterMs).toBeNull();
  });

  it('unions the probes whatever order the record holds them in', () => {
    const record = reproductionRecord();

    expect(detectIsolateStalls(record.toReversed())).toEqual(detectIsolateStalls(record));
  });

  it('leaves a probe sent at the instant a reply arrives to wait for its own reply', () => {
    const lateReplyMs = PROMPT_MS + 3 * SECOND_MS;

    expect(detectIsolateStalls([probe(0, PROMPT_MS), probe(PROMPT_MS, 3 * SECOND_MS)])).toEqual([
      {
        onsetAfterMs: PROMPT_MS,
        onsetByMs: PROMPT_MS,
        releaseMs: lateReplyMs,
        seconds: 3,
      },
    ]);
  });

  it('finds no window after a probe answered in the instant it was sent', () => {
    expect(detectIsolateStalls([probe(0, 0), probe(PROBE_EVERY_MS, PROMPT_MS)])).toEqual([]);
  });

  it("keeps a probe its connection's close ended unreleased, though a reply follows the reconnect", () => {
    const lostProbeMs = 5 * PROBE_EVERY_MS;
    const connectionClosesMs = lostProbeMs + 3 * SECOND_MS;
    const reconnectedProbeMs = lostProbeMs + 4 * SECOND_MS;
    const record = [
      probe(4 * PROBE_EVERY_MS, PROMPT_MS),
      probe(lostProbeMs, connectionClosesMs - lostProbeMs, false),
      probe(lostProbeMs + PROBE_EVERY_MS, connectionClosesMs - lostProbeMs - PROBE_EVERY_MS, false),
      probe(reconnectedProbeMs, PROMPT_MS),
    ];

    expect(detectIsolateStalls(record)).toEqual([
      {
        onsetAfterMs: 4 * PROBE_EVERY_MS + PROMPT_MS,
        onsetByMs: lostProbeMs,
        releaseMs: null,
        seconds: (connectionClosesMs - lostProbeMs) / SECOND_MS,
      },
    ]);
  });

  describe('after a probe the runtime lost', () => {
    const LOST_PROBE_MS = 10 * SECOND_MS;
    const LATER_FREEZE_OPENS_MS = 30 * SECOND_MS;
    const LATER_FREEZE_RELEASES_MS = 35 * SECOND_MS;
    const SAMPLING_STOPS_MS = 60 * SECOND_MS;

    /**
     * A probe every 2 s. The one at 10 s went to a runtime that was replaced and is never
     * answered, so it ends unanswered when sampling stops; every other probe is answered in
     * 5 ms, except those sent into the 30–35 s freeze, which are answered at its release.
     */
    function lostProbeRecord(): HeapProbeRound[] {
      const rounds: HeapProbeRound[] = [];
      for (let sentMs = 0; sentMs < SAMPLING_STOPS_MS; sentMs += PROBE_EVERY_MS) {
        const frozen = sentMs >= LATER_FREEZE_OPENS_MS && sentMs < LATER_FREEZE_RELEASES_MS;
        if (sentMs === LOST_PROBE_MS) {
          rounds.push(probe(sentMs, SAMPLING_STOPS_MS - sentMs, false));
        } else {
          rounds.push(probe(sentMs, frozen ? LATER_FREEZE_RELEASES_MS - sentMs : PROMPT_MS));
        }
      }
      return rounds;
    }

    it('extends no window past the first reply received after the lost probe', () => {
      const firstReplyAfterMs = LOST_PROBE_MS + PROBE_EVERY_MS + PROMPT_MS;

      const spanning = (detectIsolateStalls(lostProbeRecord()) ?? []).filter(
        (stall) =>
          stall.onsetByMs <= firstReplyAfterMs &&
          (stall.releaseMs === null || stall.releaseMs > firstReplyAfterMs)
      );

      expect(spanning).toEqual([]);
    });

    it('reports the later freeze as its own window, with its onset bracket and release', () => {
      const stall = detectIsolateStalls(lostProbeRecord())?.find(
        (window) => window.onsetByMs >= LATER_FREEZE_OPENS_MS
      );

      expect(stall).toEqual({
        onsetAfterMs: LATER_FREEZE_OPENS_MS - PROBE_EVERY_MS + PROMPT_MS,
        onsetByMs: LATER_FREEZE_OPENS_MS,
        releaseMs: LATER_FREEZE_RELEASES_MS,
        seconds: (LATER_FREEZE_RELEASES_MS - LATER_FREEZE_OPENS_MS) / SECOND_MS,
      });
    });

    it('ends the lost wait at the same reply whatever order the record holds the probes in', () => {
      const record = lostProbeRecord();

      expect(detectIsolateStalls(record.toReversed())).toEqual(detectIsolateStalls(record));
    });
  });
});

describe('scoreTrafficGatedCompletionGaps', () => {
  it('scores a gap between two busy phases as one window', () => {
    const before = busyRun(0, BUSY_SAMPLE_COMPLETIONS);
    const gapEndMs = (before.at(-1) ?? 0) + 6 * SECOND_MS;
    const after = busyRun(gapEndMs, BUSY_SAMPLE_COMPLETIONS);

    const score = scoreTrafficGatedCompletionGaps([...before, ...after]);

    expect(score.windowCount).toBe(1);
    expect(score.totalSeconds).toBe(6);
    expect(score.longestSeconds).toBe(6);
    expect(score.windows).toEqual([{ startOffsetSeconds: 0.45, seconds: 6 }]);
  });

  it('leaves a gap shorter than the gap bound unscored', () => {
    const before = busyRun(0, BUSY_SAMPLE_COMPLETIONS);
    const gapEndMs = (before.at(-1) ?? 0) + (COMPLETION_GAP_SECONDS - 1) * SECOND_MS;

    const score = scoreTrafficGatedCompletionGaps([
      ...before,
      ...busyRun(gapEndMs, BUSY_SAMPLE_COMPLETIONS),
    ]);

    expect(score.windowCount).toBe(0);
    expect(score.totalSeconds).toBe(0);
  });

  it('leaves an idle stretch unscored, however long', () => {
    const before = busyRun(0, BUSY_SAMPLE_COMPLETIONS, 1);
    const gapEndMs = (before.at(-1) ?? 0) + 30 * SECOND_MS;

    const score = scoreTrafficGatedCompletionGaps([
      ...before,
      ...busyRun(gapEndMs, BUSY_SAMPLE_COMPLETIONS, 1),
    ]);

    expect(score.windowCount).toBe(0);
  });

  it('leaves a gap unscored when only the phase before it is busy', () => {
    const before = busyRun(0, BUSY_SAMPLE_COMPLETIONS);
    const gapEndMs = (before.at(-1) ?? 0) + 10 * SECOND_MS;

    const score = scoreTrafficGatedCompletionGaps([
      ...before,
      ...busyRun(gapEndMs, BUSY_SAMPLE_COMPLETIONS, 1),
    ]);

    expect(score.windowCount).toBe(0);
  });

  it('leaves a gap at the very start unscored, having no busy phase before it', () => {
    const gapEndMs = 10 * SECOND_MS;

    const score = scoreTrafficGatedCompletionGaps([
      0,
      ...busyRun(gapEndMs, BUSY_SAMPLE_COMPLETIONS),
    ]);

    expect(score.windowCount).toBe(0);
  });

  it('reports the measured span and the fraction of it the windows cover', () => {
    const before = busyRun(0, BUSY_SAMPLE_COMPLETIONS);
    const gapEndMs = (before.at(-1) ?? 0) + 10 * SECOND_MS;
    const after = busyRun(gapEndMs, BUSY_SAMPLE_COMPLETIONS);

    const score = scoreTrafficGatedCompletionGaps([...before, ...after]);

    expect(score.completions).toBe(BUSY_SAMPLE_COMPLETIONS * 2);
    expect(score.measuredSpanSeconds).toBe(10.9);
    expect(score.frozenFraction).toBeCloseTo(10 / 10.9, 6);
  });

  it('reports the longest of several windows', () => {
    const first = busyRun(0, BUSY_SAMPLE_COMPLETIONS);
    const secondStartMs = (first.at(-1) ?? 0) + 5 * SECOND_MS;
    const second = busyRun(secondStartMs, BUSY_SAMPLE_COMPLETIONS);
    const thirdStartMs = (second.at(-1) ?? 0) + 9 * SECOND_MS;
    const third = busyRun(thirdStartMs, BUSY_SAMPLE_COMPLETIONS);

    const score = scoreTrafficGatedCompletionGaps([...first, ...second, ...third]);

    expect(score.windowCount).toBe(2);
    expect(score.totalSeconds).toBe(14);
    expect(score.longestSeconds).toBe(9);
  });

  it('scores a gap whose busy phases arrived inside the same millisecond', () => {
    const before = Array.from({ length: BUSY_SAMPLE_COMPLETIONS }, () => 0);
    const gapEndMs = 9 * SECOND_MS;
    const after = Array.from({ length: BUSY_SAMPLE_COMPLETIONS }, () => gapEndMs);

    const score = scoreTrafficGatedCompletionGaps([...before, ...after]);

    expect(score.windowCount).toBe(1);
    expect(score.longestSeconds).toBe(9);
  });

  it('leaves a gap at the very end unscored, having no busy phase after it', () => {
    const before = busyRun(0, BUSY_SAMPLE_COMPLETIONS);
    const gapEndMs = (before.at(-1) ?? 0) + 10 * SECOND_MS;

    const score = scoreTrafficGatedCompletionGaps([...before, ...busyRun(gapEndMs, 3)]);

    expect(score.windowCount).toBe(0);
  });

  it('scores nothing over an empty series', () => {
    const score = scoreTrafficGatedCompletionGaps([]);

    expect(score).toEqual({
      completions: 0,
      measuredSpanSeconds: 0,
      windowCount: 0,
      totalSeconds: 0,
      longestSeconds: 0,
      frozenFraction: 0,
      windows: [],
    });
  });

  it('scores nothing over a single completion', () => {
    const score = scoreTrafficGatedCompletionGaps([TEST_DAY_START]);

    expect(score.completions).toBe(1);
    expect(score.measuredSpanSeconds).toBe(0);
    expect(score.frozenFraction).toBe(0);
  });
});

describe('readDebugLogEvents', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'stall-windows-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  const writeLog = (contents: string): string => {
    const logPath = path.join(temporaryDir, 'debug.log');
    writeFileSync(logPath, contents);
    return logPath;
  };

  const read = (contents: string): DebugLogEvents =>
    readDebugLogEvents(writeLog(contents), { chunkBytes: 64 });

  it('times each completion by the block header that carries it', () => {
    const events = read(
      completionBlock(TEST_DAY_START) + completionBlock(TEST_DAY_START + 3 * SECOND_MS)
    );

    expect(events.completionsMs).toEqual([TEST_DAY_START, TEST_DAY_START + 3 * SECOND_MS]);
  });

  it('counts the inspector echo of a completion as no completion at all', () => {
    const echoed = JSON.stringify({
      method: 'Runtime.consoleAPICalled',
      params: { args: [{ value: '{"level":"info","msg":"request completed","route":"/health"}' }] },
    });

    const events = read(
      completionBlock(TEST_DAY_START) +
        block(TEST_DAY_START, 'debug', `[InspectorProxyWorker] SEND TO DEVTOOLS ${echoed}`)
    );

    expect(events.completionsMs).toEqual([TEST_DAY_START]);
  });

  it('counts a structured line that is not a completion as no completion', () => {
    const events = read(
      completionBlock(TEST_DAY_START) +
        block(TEST_DAY_START, 'info', '{"level":"info","msg":"catalog refreshed"}')
    );

    expect(events.completionsMs).toEqual([TEST_DAY_START]);
  });

  it('counts each worker re-bundle', () => {
    const events = read(
      block(TEST_DAY_START, 'log', '⎔ Reloading local server...') +
        block(TEST_DAY_START + SECOND_MS, 'log', '⎔ Local server updated and ready') +
        block(TEST_DAY_START + 2 * SECOND_MS, 'log', '⎔ Reloading local server...')
    );

    expect(events.reBundles).toBe(2);
  });

  it('counts each request the proxy dropped', () => {
    const dropped =
      '✘ [ERROR] Error inside ProxyWorker (the affected request failed; the dev server continues): OPTIONS http://localhost:10500/announcements/banner (failed after 1 attempt): Network connection lost.';

    const events = read(
      block(TEST_DAY_START, 'error', dropped) + block(TEST_DAY_START + SECOND_MS, 'error', dropped)
    );

    expect(events.droppedRequests).toBe(2);
  });

  it('reads a log whose lines straddle the chunk boundary identically', () => {
    const contents = completionBlock(TEST_DAY_START) + completionBlock(TEST_DAY_START + SECOND_MS);
    const logPath = writeLog(contents);

    expect(readDebugLogEvents(logPath, { chunkBytes: 7 })).toEqual(
      readDebugLogEvents(logPath, { chunkBytes: 1 << 20 })
    );
  });

  it('drops everything the log recorded before the run being scored began', () => {
    const dropped =
      '✘ [ERROR] Error inside ProxyWorker (the affected request failed; the dev server continues): GET http://localhost:1/health (failed after 1 attempt): Network connection lost.';
    const earlier = TEST_DAY_START;
    const runStartMs = TEST_DAY_START + 60 * SECOND_MS;
    const logPath = writeLog(
      completionBlock(earlier) +
        block(earlier, 'log', '⎔ Reloading local server...') +
        block(earlier, 'error', dropped) +
        completionBlock(runStartMs) +
        block(runStartMs, 'log', '⎔ Reloading local server...') +
        block(runStartMs, 'error', dropped)
    );

    expect(readDebugLogEvents(logPath, { sinceMs: runStartMs })).toEqual({
      completionsMs: [runStartMs],
      reBundles: 1,
      droppedRequests: 1,
    });
  });

  it('keeps everything when the caller names no start', () => {
    const logPath = writeLog(
      completionBlock(TEST_DAY_START) + completionBlock(TEST_DAY_START + 60 * SECOND_MS)
    );

    expect(readDebugLogEvents(logPath).completionsMs).toHaveLength(2);
  });

  it('reads a final line that carries no newline', () => {
    const contents = completionBlock(TEST_DAY_START).trimEnd();
    const trimmed = contents.slice(0, contents.lastIndexOf('\n---'));

    expect(readDebugLogEvents(writeLog(trimmed)).completionsMs).toEqual([TEST_DAY_START]);
  });

  it('reads an absent log as an empty series rather than failing', () => {
    expect(readDebugLogEvents(path.join(temporaryDir, 'absent.log'))).toEqual({
      completionsMs: [],
      reBundles: 0,
      droppedRequests: 0,
    });
  });
});

describe('scoreWranglerDebugLog', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'stall-windows-score-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('scores the windows of a log and carries its two counts beside them', () => {
    const before = busyRun(TEST_DAY_START, BUSY_SAMPLE_COMPLETIONS);
    const gapEndMs = (before.at(-1) ?? 0) + 7 * SECOND_MS;
    const after = busyRun(gapEndMs, BUSY_SAMPLE_COMPLETIONS);
    const logPath = path.join(temporaryDir, 'debug.log');
    writeFileSync(
      logPath,
      [...before, ...after].map((instantMs) => completionBlock(instantMs)).join('') +
        block(gapEndMs, 'log', '⎔ Reloading local server...') +
        block(
          gapEndMs,
          'error',
          '✘ [ERROR] Error inside ProxyWorker (the affected request failed; the dev server continues): GET http://localhost:10500/health (failed after 1 attempt): Network connection lost.'
        )
    );

    const score = scoreWranglerDebugLog(logPath);

    expect(score.windowCount).toBe(1);
    expect(score.longestSeconds).toBe(7);
    expect(score.reBundles).toBe(1);
    expect(score.droppedRequests).toBe(1);
  });
});
