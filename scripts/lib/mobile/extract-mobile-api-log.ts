/**
 * Extracts the slice of wrangler's debug log that belongs to a specific
 * mobile-test run: the API request activity bracketed by the run's START/END
 * markers.
 *
 * The source is wrangler's own per-port debug log rather than the teed
 * stdout/stderr log beside it. The API's request-completed line is emitted at
 * `info`, which the dev stack's `error` log level keeps off wrangler's
 * stdout, while the debug file is written before that level check — so the
 * debug log is the only place the line reliably lands.
 *
 * The API request-log middleware emits one structured JSON line per request
 * (apps/api/src/middleware/request-log.ts) with no app-version field, so the
 * slice cannot be narrowed to a single APK build the way the old `[req]
 * ... v=<version>` text line allowed. The temporal START/END window is the only
 * per-run isolation; within it the slice keeps the request-log lines (the API
 * activity) plus the run's own markers, dropping wrangler's own framing and
 * internal chatter, which stays available verbatim in the debug log itself.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export const MARKER_PREFIX = '===== MOBILE-TEST';

/**
 * The `msg` value the request-log middleware stamps on every per-request line
 * (apps/api/src/middleware/request-log.ts). The middleware logs through the
 * typed SafeLogFields logger, whose console adapter emits one JSON object per
 * line (`{"level":...,"msg":...,...fields}` — see
 * apps/api/src/lib/telemetry/console-adapter.ts), so the stable signal for
 * "a request completed" is this exact `msg`, not a legacy `[req]` text prefix.
 *
 * This is a PRODUCER→CONSUMER parse contract, not two implementations of the
 * same logic that must agree: the middleware is the sole producer of the log
 * line, and this dev-stack tooling is a consumer that parses those emitted
 * lines and keys on its `msg`. The value is duplicated here — not imported
 * from a shared constant — because the producer's `msg` is intentionally an
 * inline literal at its call site (the `redaction/logger-msg-literal` rule
 * requires a syntactic literal so redaction can statically prove no content
 * leaks), so the emitter cannot reference a shared constant. If the producer
 * ever changes this literal it must update this consumer too, or the log slice
 * silently stops recognizing traffic.
 */
const REQUEST_LOG_MSG = 'request completed';

/**
 * True when `line` is one structured request-log line from the API's
 * request-log middleware. Parses the line as JSON (the console adapter's wire
 * shape) and matches the request-completed `msg`; any non-JSON line the debug
 * log carries (wrangler's block framing, banners, stack traces) or JSON line
 * with a different `msg` (metrics, captured errors) is not a request-log line.
 */
function isApiRequestLogLine(line: string): boolean {
  const trimmed = line.trim();
  // A JSON object is the only shape the console adapter emits and the only one
  // whose text starts with `{`, so this guard means a successful parse below is
  // always a non-null object — no further shape check is reachable.
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed) as { msg?: unknown };
    return parsed.msg === REQUEST_LOG_MSG;
  } catch {
    // Not JSON — not a request-log line.
    return false;
  }
}

/**
 * How much of the debug log the reader takes in.
 *
 * A bounded tail, never the whole file: the debug log holds every level for the
 * life of the dev server, and a real one measured tens of megabytes over about a
 * million lines. The run's own window is at the end by construction — the slice
 * is written immediately after the run's END marker — so the tail is where it
 * is, and a window that does not fit this bound is reported rather than
 * silently half-read. The particular size is a ceiling on what one read holds
 * in memory, not a measurement of any run's window and not coupled to any other
 * reader's bound: it trades resident bytes against how far back a window may
 * start, and moves on that alone.
 */
const RUN_WINDOW_TAIL_BYTES = 1_048_576;

interface RunWindowOptions {
  rawLog: string;
  runId: string;
}

interface RunApiSliceOptions {
  /** The debug log to read; `scripts/wrangler-dev.ts` owns where it lives. */
  logPath: string;
  /** How the log is named in the slice's own header — repo-relative, never absolute. */
  logLabel: string;
  runId: string;
  maxBytes?: number;
}

interface RunWindow {
  /** False when the run's START marker is not in the text that was read. */
  found: boolean;
  /** The request-log lines and run markers, in order. */
  keptLines: string[];
  requestLineCount: number;
  /** Lines inside the window that are neither request lines nor run markers. */
  otherLineCount: number;
}

function isStartMarker(line: string, runId: string): boolean {
  return line.startsWith(`${MARKER_PREFIX} ${runId} START `);
}

function isEndMarker(line: string, runId: string): boolean {
  return line.startsWith(`${MARKER_PREFIX} ${runId} END `);
}

/**
 * The index range of the run's window, or null when its START marker is not in
 * `lines`. Latest START wins — defensive against the unlikely case of runId
 * reuse, and aligns with the "most recent run" mental model when reading by
 * hand. A missing END means the run died mid-flight, so the window runs to the
 * end of what was read.
 */
function findWindowBounds(lines: string[], runId: string): { start: number; end: number } | null {
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line !== undefined && isStartMarker(line, runId)) {
      start = index;
      break;
    }
  }
  if (start === -1) return null;

  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line !== undefined && isEndMarker(line, runId)) return { start, end: index };
  }
  return { start, end: lines.length - 1 };
}

function findRunWindow(options: RunWindowOptions): RunWindow {
  const lines = options.rawLog.split('\n');
  const bounds = findWindowBounds(lines, options.runId);
  if (bounds === null) {
    return { found: false, keptLines: [], requestLineCount: 0, otherLineCount: 0 };
  }

  const window: RunWindow = {
    found: true,
    keptLines: [],
    requestLineCount: 0,
    otherLineCount: 0,
  };
  // Kept: the structured request-log lines (the API activity) and the markers
  // delimiting the run. Counted but dropped: everything else in the window —
  // wrangler's `--- <iso> <level>` block framing, its proxy chatter, stack
  // traces — which remains in the unfiltered debug log.
  for (const line of lines.slice(bounds.start, bounds.end + 1)) {
    if (isApiRequestLogLine(line)) {
      window.requestLineCount++;
      window.keptLines.push(line);
    } else if (line.startsWith(MARKER_PREFIX)) {
      window.keptLines.push(line);
    } else {
      window.otherLineCount++;
    }
  }
  return window;
}

/**
 * Reads the last `maxBytes` of `logPath`. The opening partial line is dropped
 * whenever the read started past the beginning: a tail that opens mid-line hands
 * the filter a fragment of a line rather than the line, and a fragment can match
 * neither a marker nor a JSON request line honestly.
 */
function readTail(logPath: string, maxBytes: number): string {
  const handle = openSync(logPath, 'r');
  try {
    const { size } = fstatSync(handle);
    const offset = size <= maxBytes ? 0 : size - maxBytes;
    const buffer = Buffer.alloc(size - offset);
    const bytesRead = readSync(handle, buffer, 0, buffer.length, offset);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset === 0) return text;
    const firstBreak = text.indexOf('\n');
    return firstBreak === -1 ? '' : text.slice(firstBreak + 1);
  } finally {
    closeSync(handle);
  }
}

/**
 * The run's API slice, with a leading header stating what the reader found.
 *
 * The header is the whole point of the artifact being trustworthy: a slice that
 * is merely empty cannot tell its reader whether the API served nothing or
 * whether the file read is not the one the API's traffic went to. The two counts
 * separate those — request lines above zero is captured traffic, zero request
 * lines beside other lines is a log that recorded the run but no requests, and
 * zero of both is a window in a file that recorded nothing while the run was
 * live. A missing marker is its own header, because a window that never appeared
 * in the bytes read is a different fact again.
 */
export function readRunApiSlice(options: RunApiSliceOptions): string {
  const maxBytes = options.maxBytes ?? RUN_WINDOW_TAIL_BYTES;
  const window = findRunWindow({
    rawLog: readTail(options.logPath, maxBytes),
    runId: options.runId,
  });

  if (!window.found) {
    return `===== api log slice: this run start marker is absent from the last ${String(maxBytes)} bytes of ${options.logLabel} =====`;
  }
  const header = `===== api log slice: ${String(window.requestLineCount)} request lines and ${String(window.otherLineCount)} other lines inside this run window in ${options.logLabel} =====`;
  return [header, ...window.keptLines].join('\n');
}
