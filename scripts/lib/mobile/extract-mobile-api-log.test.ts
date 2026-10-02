import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { HOUR_MS, isoAt, MINUTE_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { MARKER_PREFIX, readRunApiSlice } from './extract-mobile-api-log.js';

const RUN_ID = 'abc12345';
const OTHER_RUN_ID = 'def67890';

const RUN_START = TEST_DAY_START + 3 * HOUR_MS;
const RUN_END = RUN_START + 4 * MINUTE_MS;

function startMarker(runId: string, iso = isoAt(RUN_START)): string {
  return `${MARKER_PREFIX} ${runId} START ${iso} =====`;
}

function endMarker(runId: string, iso = isoAt(RUN_END)): string {
  return `${MARKER_PREFIX} ${runId} END ${iso} =====`;
}

// The structured request-log line the API middleware emits through the console
// adapter (one JSON object per stdout line). `route` is the discriminator the
// assertions key on, standing in for the old text line's path token.
function reqLine(route = '/api/auth/login/init', status = 200): string {
  return JSON.stringify({
    level: 'info',
    msg: 'request completed',
    method: 'POST',
    route,
    statusCode: status,
    latencyMs: 117,
  });
}

// Wrangler's debug log is not a stream of bare lines: it frames every message
// as a `--- <iso> <level>` header, the message body, a closing `---` and a
// blank line. These helpers reproduce that framing so the reader is exercised
// against the shape the file it now reads really has.
function debugBlock(body: string, at: number, level = 'debug'): string {
  return `--- ${isoAt(at)} ${level}\n${body}\n---\n\n`;
}

function requestBlock(route: string, at: number): string {
  return debugBlock(reqLine(route), at, 'info');
}

describe('readRunApiSlice', () => {
  let logDir: string;

  beforeEach(() => {
    logDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'mobile-api-log-')));
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  function writeLog(content: string): string {
    const logPath = path.join(logDir, 'wrangler-debug.log');
    writeFileSync(logPath, content);
    return logPath;
  }

  function sliceOf(content: string, runId = RUN_ID): string {
    return readRunApiSlice({ logPath: writeLog(content), logLabel: 'debug.log', runId });
  }

  function headerOf(slice: string): string {
    return slice.split('\n')[0] ?? '';
  }

  it('keeps a request line the log wrote with whitespace around it', () => {
    const slice = sliceOf(
      [
        `${startMarker(RUN_ID)}\n`,
        debugBlock(`  ${reqLine('/padded')}\r`, RUN_START, 'info'),
        `${endMarker(RUN_ID)}\n`,
      ].join('')
    );

    expect(slice).toContain('/padded');
  });

  it('drops structured lines the API logged for something other than a request', () => {
    const slice = sliceOf(
      [
        `${startMarker(RUN_ID)}\n`,
        debugBlock(
          JSON.stringify({ level: 'info', msg: 'metric', metric: 'x', value: 1 }),
          RUN_START,
          'info'
        ),
        debugBlock(
          JSON.stringify({ level: 'error', msg: 'error.captured', errorCode: 'BOOM' }),
          RUN_START,
          'error'
        ),
        `${endMarker(RUN_ID)}\n`,
      ].join('')
    );

    expect(slice).not.toContain('metric');
    expect(slice).not.toContain('error.captured');
  });

  it('drops a line that opens like JSON but does not parse', () => {
    const slice = sliceOf(
      [
        `${startMarker(RUN_ID)}\n`,
        debugBlock('{ not json', RUN_START, 'info'),
        `${endMarker(RUN_ID)}\n`,
      ].join('')
    );

    expect(slice).not.toContain('not json');
  });

  it('keeps the API request lines wrangler framed inside the run window', () => {
    const slice = sliceOf(
      [
        requestBlock('/before', RUN_START - MINUTE_MS),
        `${startMarker(RUN_ID)}\n`,
        debugBlock('[InspectorProxyWorker] SEND TO RUNTIME {"id":1}', RUN_START),
        requestBlock('/during', RUN_START + MINUTE_MS),
        `${endMarker(RUN_ID)}\n`,
        requestBlock('/after', RUN_END + MINUTE_MS),
      ].join('')
    );

    expect(slice).toContain('/during');
    expect(slice).not.toContain('/before');
    expect(slice).not.toContain('/after');
    expect(slice).not.toContain('InspectorProxyWorker');
  });

  it('leads with the request-line and other-line counts inside the window', () => {
    const slice = sliceOf(
      [
        `${startMarker(RUN_ID)}\n`,
        requestBlock('/one', RUN_START),
        requestBlock('/two', RUN_START + MINUTE_MS),
        `${endMarker(RUN_ID)}\n`,
      ].join('')
    );

    // Each framed request contributes one request line and three other lines
    // (the `---` header, the closing `---`, and the trailing blank).
    expect(headerOf(slice)).toBe(
      '===== api log slice: 2 request lines and 6 other lines inside this run window in debug.log ====='
    );
  });

  it('counts zero request lines against a window that still recorded other output', () => {
    const slice = sliceOf(
      [
        `${startMarker(RUN_ID)}\n`,
        debugBlock('[InspectorProxyWorker] SEND TO RUNTIME {"id":1}', RUN_START),
        `${endMarker(RUN_ID)}\n`,
      ].join('')
    );

    expect(headerOf(slice)).toBe(
      '===== api log slice: 0 request lines and 4 other lines inside this run window in debug.log ====='
    );
  });

  it('counts zero of both when the window holds nothing but the run markers', () => {
    const slice = sliceOf([`${startMarker(RUN_ID)}\n`, `${endMarker(RUN_ID)}\n`].join(''));

    expect(headerOf(slice)).toBe(
      '===== api log slice: 0 request lines and 0 other lines inside this run window in debug.log ====='
    );
  });

  it('finds a run window at the end of a log far larger than the byte bound', () => {
    const filler = debugBlock('x'.repeat(200), RUN_START).repeat(40);
    const logPath = writeLog(
      [
        filler,
        `${startMarker(RUN_ID)}\n`,
        requestBlock('/during', RUN_START),
        `${endMarker(RUN_ID)}\n`,
      ].join('')
    );

    const slice = readRunApiSlice({
      logPath,
      logLabel: 'debug.log',
      runId: RUN_ID,
      maxBytes: 1024,
    });

    expect(statSync(logPath).size).toBeGreaterThan(1024);
    expect(slice).toContain('/during');
    expect(headerOf(slice)).toContain('1 request lines');
  });

  it('says the marker is absent when the run window predates the bytes it read', () => {
    const filler = debugBlock('x'.repeat(200), RUN_START).repeat(20);
    const logPath = writeLog([`${startMarker(RUN_ID)}\n`, filler].join(''));

    const slice = readRunApiSlice({
      logPath,
      logLabel: 'debug.log',
      runId: RUN_ID,
      maxBytes: 512,
    });

    expect(slice).toBe(
      '===== api log slice: this run start marker is absent from the last 512 bytes of debug.log ====='
    );
  });

  it('reports the marker absent rather than a fragment when the bound lands mid-line', () => {
    const logPath = writeLog(`${startMarker(RUN_ID)}\n${reqLine('/during')}`);

    const slice = readRunApiSlice({
      logPath,
      logLabel: 'debug.log',
      runId: RUN_ID,
      maxBytes: 20,
    });

    expect(slice).toContain('absent from the last 20 bytes');
    expect(slice).not.toContain('/during');
  });

  it('reports the marker absent when the log holds no start marker for the run', () => {
    const slice = sliceOf([reqLine(), '[wrangler:info] Ready'].join('\n'));

    expect(slice).toContain('this run start marker is absent');
    expect(slice).not.toContain('/api/auth/login/init');
  });

  it('reports the marker absent when the log file is empty', () => {
    expect(sliceOf('')).toContain('this run start marker is absent');
  });

  it('slices from START to END for the matching runId', () => {
    const slice = sliceOf(
      [
        '[wrangler:info] Ready',
        reqLine('/before'),
        startMarker(RUN_ID),
        reqLine('/during'),
        endMarker(RUN_ID),
        reqLine('/after'),
      ].join('\n')
    );

    expect(slice).toContain('/during');
    expect(slice).not.toContain('/before');
    expect(slice).not.toContain('/after');
    expect(slice).toContain(startMarker(RUN_ID));
    expect(slice).toContain(endMarker(RUN_ID));
  });

  it('slices from START to EOF when END marker is missing (crash mid-run)', () => {
    const slice = sliceOf(
      [startMarker(RUN_ID), reqLine('/during'), '[wrangler:error] something blew up'].join('\n')
    );

    expect(slice).toContain('/during');
    // The window still extends to EOF; the request-log line inside it survives.
    expect(slice).toContain(startMarker(RUN_ID));
  });

  it('keeps every request-log line in the window (no per-version filtering)', () => {
    const slice = sliceOf(
      [startMarker(RUN_ID), reqLine('/mine'), reqLine('/also-mine'), endMarker(RUN_ID)].join('\n')
    );

    expect(slice).toContain('/mine');
    expect(slice).toContain('/also-mine');
  });

  it('drops non-request, non-marker noise (wrangler banners, errors, stack traces)', () => {
    const slice = sliceOf(
      [
        startMarker(RUN_ID),
        '[wrangler:info] Ready on http://localhost:8915',
        '[wrangler:error] TypeError: cannot read property of undefined',
        '    at someFunction (file.ts:42:10)',
        JSON.stringify({ level: 'info', msg: 'metric', metric: 'x', value: 1 }),
        reqLine('/mine'),
        endMarker(RUN_ID),
      ].join('\n')
    );

    expect(slice).toContain('/mine');
    expect(slice).not.toContain('[wrangler:info]');
    expect(slice).not.toContain('[wrangler:error]');
    expect(slice).not.toContain('at someFunction');
    expect(slice).not.toContain('"msg":"metric"');
  });

  it('keeps the run START/END markers in the output', () => {
    const slice = sliceOf([startMarker(RUN_ID), reqLine('/mine'), endMarker(RUN_ID)].join('\n'));

    expect(slice).toContain(startMarker(RUN_ID));
    expect(slice).toContain(endMarker(RUN_ID));
  });

  it('ignores markers belonging to a different runId', () => {
    const slice = sliceOf(
      [
        startMarker(OTHER_RUN_ID),
        reqLine('/not-mine'),
        endMarker(OTHER_RUN_ID),
        startMarker(RUN_ID),
        reqLine('/mine'),
        endMarker(RUN_ID),
      ].join('\n')
    );

    expect(slice).toContain('/mine');
    expect(slice).not.toContain('/not-mine');
    expect(slice).not.toContain(startMarker(OTHER_RUN_ID));
  });

  it('uses the latest START when the same runId appears multiple times', () => {
    const earlierStart = TEST_DAY_START + HOUR_MS;
    const slice = sliceOf(
      [
        startMarker(RUN_ID, isoAt(earlierStart)),
        reqLine('/earlier'),
        endMarker(RUN_ID, isoAt(earlierStart + 5 * MINUTE_MS)),
        startMarker(RUN_ID, isoAt(RUN_START)),
        reqLine('/later'),
        endMarker(RUN_ID, isoAt(RUN_START + 5 * MINUTE_MS)),
      ].join('\n')
    );

    expect(slice).toContain('/later');
    expect(slice).not.toContain('/earlier');
  });
});
