/**
 * Resource sampler.
 *
 * Samples system CPU / memory / load on an interval using only Node built-ins
 * (`os.*`), so those series run identically on Linux (CI/container), macOS, and
 * Windows. On Linux it also reads disk load and blocked threads from the
 * kernel's `/proc` and `/sys`, and walks the E2E RAM root; elsewhere those
 * series are not measured. Paired with the log-based
 * {@link ResourceScan}, the summary turns "tests crashed" into an actionable
 * verdict: e.g. CPU idle + process/thread-limit errors ⇒ raise the container's
 * process limit, not the worker count.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  detectIsolateStalls,
  type HeapProbeRound,
  type IsolateStall,
} from './lib/playwright/stall-windows.js';
import { e2eRamPaths, ramRootUsedBytes } from './lib/stack/ram-root.js';
import { wranglerDebugLogPath } from './wrangler-dev.js';
import type { Socket } from 'node:net';
import type { ResourceScan } from './resource-scan.js';

export interface ResourceSample {
  /** Milliseconds since sampling started. */
  t: number;
  /** System-wide CPU busy percentage [0,100] over the preceding interval. */
  cpuPct: number;
  /** Used memory percentage [0,100]. */
  memPct: number;
  /** 1-minute load average (0 on platforms that don't report it, e.g. Windows). */
  load1: number;
  /**
   * The API worker isolate's used JS heap, in MB. Absent whenever the reading
   * was unavailable — no inspector port, a refused connection, a dropped
   * socket — which is a normal state for a best-effort reading and never an
   * error.
   */
  heapMb?: number;
  /** Each block device's load over the interval before this sample, partitions included; null off Linux. */
  disks: DiskLoad[] | null;
  /** Each mounted btrfs's transaction commits over the interval before this sample; null off Linux. */
  btrfs: BtrfsCommits[] | null;
  /**
   * The threads in uninterruptible sleep (state `D`) at this sample, counted by
   * the kernel function each waits in (its `wchan`), across every process this
   * one can see. Nothing names a process. Null off Linux.
   */
  dState: Record<string, number> | null;
  /**
   * The bytes this checkout's E2E RAM root occupies, from a walk begun with this
   * sample. Null where there is no root, or where no walk of it finished for
   * this sample: one was still running from an earlier sample, the walk
   * failed, or sampling stopped first.
   */
  ramRootBytes: number | null;
}

/** One mounted btrfs's transaction commits over one sampling interval, from its `commit_stats`. */
interface BtrfsCommits {
  /**
   * The block devices the filesystem spans, each named as its own row of the
   * disk series, a partition member included. Its id is not recorded: that
   * names the machine.
   */
  devices: string[];
  commits: number;
  /** Milliseconds those commits took, together. */
  commitMs: number;
}

/** One block device's load over one sampling interval, from `/proc/diskstats`. */
interface DiskLoad {
  device: string;
  /** Share of the interval the device had a request in flight, [0,100]. */
  utilisationPct: number;
  /** Requests in flight, averaged over the interval: what `iostat` calls the queue size. */
  inFlight: number;
}

export interface ResourceSummary {
  durationMs: number;
  sampleCount: number;
  cores: number;
  totalMemBytes: number;
  cpu: { peak: number; avg: number };
  mem: { peak: number; avg: number };
  load: { peak: number };
  /** Over the samples that carry a heap reading; absent when none did. */
  heap?: { peak: number; avg: number };
  /**
   * V8 heap-out-of-memory aborts the API worker logged inside the window.
   * Absent when the run named no worker log to read.
   */
  heapOomAborts?: number;
  /**
   * The windows in which the API worker's isolate answered no heap probe, in
   * milliseconds from the start of sampling — the frame of every sample's `t`.
   * Null when no probe was sent, so nothing was measured: the probe was off, or
   * never connected.
   */
  isolateStalls: IsolateStall[] | null;
  /** Each block device's peak utilisation, busiest first; null when no sample measured one. */
  diskPeaks: DiskPeak[] | null;
  /** The waits threads were most often seen blocked in, most frequent first; null when not measured. */
  dStateWaits: DStateWait[] | null;
  /** The most the E2E RAM root occupied in any sample; null when no sample measured it. */
  ramRootPeakBytes: number | null;
}

interface DiskPeak {
  device: string;
  peakUtilisationPct: number;
}

interface DStateWait {
  wchan: string;
  /** Threads seen waiting in it, summed over the samples. */
  seen: number;
}

export interface ResourceReport {
  summary: ResourceSummary;
  samples: ResourceSample[];
  scan: ResourceScan;
  /** The run's configured Playwright worker count, which sizes its RAM root; absent for a run that never began. */
  workers?: number;
}

/**
 * A live reading of the API worker isolate's used JS heap, in bytes.
 *
 * Best-effort by contract: every failure mode — no inspector, a refused
 * connection, a dropped socket — answers `undefined`, because this series is
 * reporting only and must never be able to fail a run.
 */
export interface HeapProbe {
  read: () => number | undefined;
  /** Hangs up, and hands back every probe it sent, timed on the wall clock. */
  stop: () => HeapProbeRound[];
}

export interface ResourceSamplerOptions {
  /** Overridable for tests; the default reads this run's API inspector. */
  openHeapProbe?: () => HeapProbe | null;
  /**
   * Overridable for tests; `null` reads no log at all. The default is wrangler's
   * debug log for this run's API port, which is where a V8 abort lands.
   */
  oomLogPath?: string | null;
  /** Overridable for tests; the default is this machine, its kernel read at the filesystem root. */
  host?: SampledHost;
  /** Overridable for tests; null walks none. The default is this checkout's E2E RAM root. */
  ramRoot?: string | null;
  /** Overridable for tests; the default walks the root. */
  measureRamRoot?: (root: string) => Promise<number>;
}

/** The platform a sampler runs on, and the directory its `/proc` and `/sys` are read under. */
interface SampledHost {
  platform: NodeJS.Platform;
  root: string;
}

export interface ResourceSampler {
  start: () => void;
  /** Stops sampling and returns the collected series + summary. Safe to call
   *  without a prior {@link ResourceSampler.start} (returns an empty series). */
  stop: () => { summary: ResourceSummary; samples: ResourceSample[] };
}

type CpuTimes = ReturnType<typeof os.cpus>;

const DEFAULT_INTERVAL_MS = 2000;

/** Sum idle + total CPU jiffies across all cores in a snapshot. */
function aggregate(cpus: CpuTimes): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** Aggregate busy% across all cores between two `os.cpus()` snapshots. */
export function computeCpuPercent(previous: CpuTimes, current: CpuTimes): number {
  const a = aggregate(previous);
  const b = aggregate(current);
  const totalDelta = b.total - a.total;
  if (totalDelta <= 0) return 0;
  const busy = (1 - (b.idle - a.idle) / totalDelta) * 100;
  return Math.max(0, Math.min(100, Math.round(busy)));
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** How many of the most frequent D-state waits a summary names. */
const SUMMARIZED_WAITS = 5;

function summarizeDisks(samples: readonly ResourceSample[]): DiskPeak[] | null {
  const readings = samples.flatMap((sample) => (sample.disks === null ? [] : [sample.disks]));
  if (readings.length === 0) return null;
  const peaks = new Map<string, number>();
  for (const { device, utilisationPct } of readings.flat()) {
    peaks.set(device, Math.max(peaks.get(device) ?? 0, utilisationPct));
  }
  return [...peaks]
    .map(([device, peakUtilisationPct]) => ({ device, peakUtilisationPct }))
    .toSorted((a, b) => b.peakUtilisationPct - a.peakUtilisationPct);
}

function summarizeDState(samples: readonly ResourceSample[]): DStateWait[] | null {
  const tallies = samples.flatMap((sample) => (sample.dState === null ? [] : [sample.dState]));
  if (tallies.length === 0) return null;
  const seen = new Map<string, number>();
  for (const [wchan, threads] of tallies.flatMap((tally) => Object.entries(tally))) {
    seen.set(wchan, (seen.get(wchan) ?? 0) + threads);
  }
  return [...seen]
    .map(([wchan, count]) => ({ wchan, seen: count }))
    .toSorted((a, b) => b.seen - a.seen || a.wchan.localeCompare(b.wchan))
    .slice(0, SUMMARIZED_WAITS);
}

function summarizeRamRoot(samples: readonly ResourceSample[]): number | null {
  const readings = samples.flatMap((sample) =>
    sample.ramRootBytes === null ? [] : [sample.ramRootBytes]
  );
  return readings.length === 0 ? null : Math.max(...readings);
}

export function summarizeSamples(
  samples: readonly ResourceSample[],
  durationMs: number,
  heapOomAborts?: number
): Omit<ResourceSummary, 'isolateStalls'> {
  const cores = os.cpus().length;
  const totalMemBytes = os.totalmem();
  const base: Omit<ResourceSummary, 'isolateStalls'> = {
    durationMs,
    sampleCount: samples.length,
    cores,
    totalMemBytes,
    cpu: { peak: 0, avg: 0 },
    mem: { peak: 0, avg: 0 },
    load: { peak: 0 },
    ...(heapOomAborts === undefined ? {} : { heapOomAborts }),
    diskPeaks: summarizeDisks(samples),
    dStateWaits: summarizeDState(samples),
    ramRootPeakBytes: summarizeRamRoot(samples),
  };
  if (samples.length === 0) return base;

  const sum = { cpu: 0, mem: 0, heap: 0 };
  let heapPeak = 0;
  let heapCount = 0;
  for (const s of samples) {
    base.cpu.peak = Math.max(base.cpu.peak, s.cpuPct);
    base.mem.peak = Math.max(base.mem.peak, s.memPct);
    base.load.peak = Math.max(base.load.peak, s.load1);
    sum.cpu += s.cpuPct;
    sum.mem += s.memPct;
    if (s.heapMb !== undefined) {
      heapPeak = Math.max(heapPeak, s.heapMb);
      sum.heap += s.heapMb;
      heapCount += 1;
    }
  }
  base.cpu.avg = round(sum.cpu / samples.length);
  base.mem.avg = round(sum.mem / samples.length);
  base.cpu.peak = round(base.cpu.peak);
  base.mem.peak = round(base.mem.peak);
  base.load.peak = round(base.load.peak);
  // Averaged over the readings themselves, not the whole window: the inspector
  // connects after sampling starts and can drop mid-run, and counting those
  // gaps as zero would understate the heap.
  if (heapCount > 0) base.heap = { peak: round(heapPeak), avg: round(sum.heap / heapCount) };
  return base;
}

/** One-line-per-metric block for the end-of-run stdout. */
export function formatResourceStdout(report: ResourceReport): string {
  const { summary, scan } = report;
  const lines = [
    `\nResources over ${formatMs(summary.durationMs)} (peak / avg, system-wide):`,
    `  CPU     ${pct(summary.cpu.peak)} / ${pct(summary.cpu.avg)}`,
    `  memory  ${pct(summary.mem.peak)} / ${pct(summary.mem.avg)}  (of ${gib(summary.totalMemBytes)})`,
    `  load    ${String(summary.load.peak)}  (${String(summary.cores)} cores)`,
  ];
  if (summary.heap) {
    lines.push(`  API heap  ${mib(summary.heap.peak)} / ${mib(summary.heap.avg)}`);
  }
  if (summary.heapOomAborts !== undefined) {
    lines.push(`  heap-OOM aborts: ${String(summary.heapOomAborts)}`);
  }
  if (scan.totalHits > 0) {
    const breakdown = scan.categories.map((c) => `${c.name}×${String(c.count)}`).join(', ');
    lines.push(`  resource-limit errors: ${String(scan.totalHits)} (${breakdown})`);
  }
  return lines.join('\n');
}

function pct(n: number): string {
  return `${String(n)}%`;
}

function mib(megabytes: number): string {
  return `${String(megabytes)}M`;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}

function formatMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${String(minutes)}m${String(seconds)}s` : `${String(seconds)}s`;
}

function takeSample(
  previous: CpuTimes,
  startMs: number,
  heapBytes: number | undefined
): { sample: Omit<ResourceSample, keyof KernelSeries | 'ramRootBytes'>; cpus: CpuTimes } {
  const cpus = os.cpus();
  const total = os.totalmem();
  const used = total - os.freemem();
  return {
    sample: {
      t: Date.now() - startMs,
      cpuPct: computeCpuPercent(previous, cpus),
      ...(heapBytes === undefined ? {} : { heapMb: round(heapBytes / 1024 ** 2) }),
      /* v8 ignore start -- os.totalmem() is always positive and os.loadavg() always returns a 3-element array on a real host */
      memPct: total > 0 ? Math.round((used / total) * 100) : 0,
      load1: round(os.loadavg()[0] ?? 0),
      /* v8 ignore stop */
    },
    cpus,
  };
}

/** What the probe needs of a live inspector connection. */
export interface InspectorConnection {
  send: (payload: string) => void;
  close: () => void;
}

/** What the probe wants told about a connection's life. */
export interface InspectorHandlers {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClosed: () => void;
}

export type InspectorConnect = (url: string, handlers: InspectorHandlers) => InspectorConnection;

const HEAP_USAGE_REPLY = z.object({ result: z.object({ usedSize: z.number() }) });

const REPLY_ID = z.object({ id: z.number() });

/** An inspector frame's message, or nothing when the frame is not JSON. */
function parseFrame(frame: string): unknown {
  try {
    return JSON.parse(frame);
  } catch {
    // A frame that is not JSON carries no reading and answers no request, which
    // is the same outcome as an event nobody asked for: this one is skipped.
    return undefined;
  }
}

/** The used-heap figure in an inspector message, or nothing if it carries none. */
function readHeapUsage(message: unknown): number | undefined {
  const reply = HEAP_USAGE_REPLY.safeParse(message);
  return reply.success ? reply.data.result.usedSize : undefined;
}

/** The id of the request an inspector message answers, or nothing for an event. */
function readReplyId(message: unknown): number | undefined {
  const reply = REPLY_ID.safeParse(message);
  return reply.success ? reply.data.id : undefined;
}

const WS_TEXT_FRAME = 0x1;
const WS_CLOSE_FRAME = 0x8;
const WS_OPCODE_MASK = 0x0f;
const WS_LENGTH_MASK = 0x7f;
const WS_FINAL_TEXT = 0x81;
const WS_MASKED = 0x80;
const WS_LENGTH_16 = 126;
const WS_LENGTH_64 = 127;

/**
 * One masked text frame. Short-form length only, which every command this
 * module sends fits inside — they are all one fixed request with a counter.
 */
function encodeCommand(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const mask = randomBytes(4);
  for (const [index, byte] of payload.entries()) payload[index] = byte ^ mask.readUInt8(index % 4);
  return Buffer.concat([Buffer.from([WS_FINAL_TEXT, WS_MASKED | payload.length]), mask, payload]);
}

interface FrameHeader {
  opcode: number;
  /** Where the payload starts, past a length that is 7, 16 or 64 bits wide. */
  start: number;
  size: number;
}

/** The header of the frame at the front of the buffer, once all of it is there. */
function readFrameHeader(pending: Buffer): FrameHeader | undefined {
  if (pending.length < 2) return undefined;
  const opcode = pending.readUInt8(0) & WS_OPCODE_MASK;
  const declared = pending.readUInt8(1) & WS_LENGTH_MASK;
  if (declared === WS_LENGTH_16) {
    return pending.length < 4 ? undefined : { opcode, start: 4, size: pending.readUInt16BE(2) };
  }
  if (declared === WS_LENGTH_64) {
    return pending.length < 10
      ? undefined
      : { opcode, start: 10, size: Number(pending.readBigUInt64BE(2)) };
  }
  return { opcode, start: 2, size: declared };
}

/**
 * Feeds whole frames out of a byte stream that splits and joins them freely.
 * Text is handed on as it arrives; a close frame ends the stream. Anything
 * else the inspector sends is skipped rather than interpreted.
 */
function createFrameReader(
  onText: (text: string) => void,
  onClose: () => void
): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  return (chunk: Buffer): void => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const header = readFrameHeader(pending);
      if (header === undefined) return;
      const end = header.start + header.size;
      if (pending.length < end) return;
      const payload = pending.subarray(header.start, end);
      pending = pending.subarray(end);
      if (header.opcode === WS_CLOSE_FRAME) {
        onClose();
        return;
      }
      if (header.opcode === WS_TEXT_FRAME) onText(payload.toString('utf8'));
    }
  };
}

/**
 * Speaks the inspector protocol over a socket this module owns outright.
 *
 * Two properties a standard `WebSocket` cannot give it, both of which this
 * reporting surface depends on. It declares an `Origin`, which wrangler's
 * inspector proxy refuses an upgrade without. And it can let go: the proxy
 * never answers a closing handshake, so a socket asked to close politely stays
 * open forever and holds the process with it. This one is unreferenced from
 * the moment it exists, so it can never keep a run alive, and closing it is a
 * hang-up rather than a request.
 */
function connectInspector(url: string, handlers: InspectorHandlers): InspectorConnection {
  const { hostname, port, pathname, host } = new URL(url);
  let socket: Socket | undefined;
  const request = http.request({
    hostname,
    port,
    path: pathname,
    agent: false,
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      Origin: `http://${host}`,
    },
  });

  request.on('socket', (pending: Socket) => {
    pending.unref();
  });
  request.on('upgrade', (_response, upgraded: Socket, head: Buffer) => {
    socket = upgraded;
    upgraded.unref();
    const read = createFrameReader(handlers.onMessage, handlers.onClosed);
    upgraded.on('data', read);
    upgraded.on('close', handlers.onClosed);
    upgraded.on('error', handlers.onClosed);
    read(head);
    handlers.onOpen();
  });
  // Anything that is not an upgrade — a refusal, a reset, a proxy that is not
  // there — leaves nothing to read, which is this probe's ordinary quiet state.
  request.on('response', handlers.onClosed);
  request.on('error', handlers.onClosed);
  request.end();

  return {
    send: (payload: string): void => {
      socket?.write(encodeCommand(payload));
    },
    close: (): void => {
      if (socket === undefined) {
        request.destroy();
        return;
      }
      socket.destroy();
    },
  };
}

/**
 * Connection attempts in a row that may fail before the probe stops trying.
 * A connection that opened and then dropped does not spend the budget, so an
 * isolate lost and replaced any number of times is followed throughout; an
 * inspector that opens nothing is attempted this many times, over as many
 * samples, and then left alone, so a dead one is not dialled once per sample
 * for the length of a run.
 */
const MAX_CONSECUTIVE_CONNECT_FAILURES = 5;

/**
 * Reads the isolate's heap over wrangler's inspector.
 *
 * `Runtime.getHeapUsage` and nothing else: wrangler's inspector proxy silently
 * drops `HeapProfiler.collectGarbage`, so a figure here is live heap including
 * whatever is merely uncollected, never a post-collection figure.
 *
 * A connection that drops is reopened by the next read, within
 * {@link MAX_CONSECUTIVE_CONNECT_FAILURES}, because the reading is wanted for
 * the whole run and not only for the first isolate the run has.
 *
 * Every probe sent is kept with the instant it went and the instant its reply
 * came, which is what the isolate-stall windows are read from. A reply is
 * matched by the id the inspector echoes: wrangler's inspector proxy forwards a
 * client's requests and the runtime's replies unchanged, and numbers its own
 * requests far above any this probe reaches. A probe that loses its connection,
 * or is still waiting at stop, is ended there unanswered.
 */
export function createInspectorHeapProbe(
  url: string,
  connect: InspectorConnect = connectInspector
): HeapProbe {
  let connection: InspectorConnection | undefined;
  let latest: number | undefined;
  let live = false;
  let connecting = false;
  let stopped = false;
  let failures = 0;
  let lastId = 0;
  const rounds: HeapProbeRound[] = [];
  /** Sent instant by request id, for every probe still waiting on its reply. */
  const waiting = new Map<number, number>();

  /** Ends every probe still waiting, unanswered: nothing can answer it any more. */
  function abandonWaiting(): void {
    const endedMs = Date.now();
    for (const sentMs of waiting.values()) rounds.push({ sentMs, endedMs, answered: false });
    waiting.clear();
  }

  function recordReply(id: number | undefined): void {
    if (id === undefined) return;
    const sentMs = waiting.get(id);
    if (sentMs === undefined) return;
    waiting.delete(id);
    rounds.push({ sentMs, endedMs: Date.now(), answered: true });
  }

  function request(): void {
    if (!live || connection === undefined) return;
    lastId += 1;
    const sentMs = Date.now();
    try {
      connection.send(JSON.stringify({ id: lastId, method: 'Runtime.getHeapUsage' }));
      waiting.set(lastId, sentMs);
    } catch {
      // The isolate went away mid-request. Handled by going quiet until the
      // next read, which is where a fresh connection is attempted.
      live = false;
      latest = undefined;
      abandonWaiting();
    }
  }

  /** Attempts one connection, unless the probe is already busy or has given up. */
  function open(): void {
    if (stopped || connecting || failures >= MAX_CONSECUTIVE_CONNECT_FAILURES) return;
    connecting = true;
    try {
      connection = connect(url, {
        onOpen: (): void => {
          connecting = false;
          failures = 0;
          live = true;
          request();
        },
        onMessage: (data: string): void => {
          const message = parseFrame(data);
          latest = readHeapUsage(message) ?? latest;
          recordReply(readReplyId(message));
        },
        onClosed: (): void => {
          // An attempt that never opened spends the budget; a connection that
          // opened and then dropped does not, because something answered on
          // the other end and the next read can expect it to answer again.
          if (connecting) failures += 1;
          connecting = false;
          live = false;
          latest = undefined;
          abandonWaiting();
        },
      });
    } catch {
      // Nothing to connect to. Handled the same way as an attempt that opened
      // nothing: the budget is spent and the next read tries once more.
      connecting = false;
      failures += 1;
    }
  }

  open();

  return {
    read(): number | undefined {
      if (!live) {
        open();
        return undefined;
      }
      request();
      return latest;
    },
    stop(): HeapProbeRound[] {
      stopped = true;
      live = false;
      try {
        connection?.close();
      } catch {
        // Already gone; there is nothing left to close.
        connection = undefined;
      }
      abandonWaiting();
      return [...rounds];
    },
  };
}

/**
 * The text V8 prints as it aborts an isolate it cannot grow, once per abort.
 * Wrangler's debug log is the file to look for it in: every level lands there
 * before the terminal's own level filter runs.
 */
const HEAP_OOM_MARK = 'JavaScript heap out of memory';

const LOG_READ_CHUNK_BYTES = 1024 * 1024;

interface HeapOomCounter {
  /** Positions the scan at the log's end, so an earlier run is not counted. */
  begin: () => void;
  /** Counts the aborts in whatever the worker appended since the last call. */
  scan: () => void;
  count: () => number | undefined;
}

function occurrences(haystack: string, needle: string): number {
  let found = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    found += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return found;
}

/** The log's size now, or nothing while the worker has yet to write it. */
function logSize(logPath: string): number | undefined {
  let handle: number;
  try {
    handle = openSync(logPath, 'r');
  } catch {
    // Not written yet, or gone. Handled by having nothing to read this time.
    return undefined;
  }
  try {
    return fstatSync(handle).size;
  } finally {
    closeSync(handle);
  }
}

function createHeapOomCounter(logPath: string | null): HeapOomCounter {
  let offset = 0;
  let aborts = 0;
  // The tail of the last read, short enough that it can hold no whole mark of
  // its own: it is what makes a mark split across two reads count once.
  let carry = '';

  function scan(): void {
    if (logPath === null) return;
    let handle: number;
    try {
      handle = openSync(logPath, 'r');
    } catch {
      // Same as above: nothing to read yet.
      return;
    }
    try {
      const { size } = fstatSync(handle);
      // A worker restart truncates the log, so the bytes before the old offset
      // are a different session's and have never been read.
      if (size < offset) {
        offset = 0;
        carry = '';
      }
      const buffer = Buffer.alloc(LOG_READ_CHUNK_BYTES);
      while (offset < size) {
        const wanted = Math.min(LOG_READ_CHUNK_BYTES, size - offset);
        const read = readSync(handle, buffer, 0, wanted, offset);
        offset += read;
        const text = carry + buffer.subarray(0, read).toString('utf8');
        aborts += occurrences(text, HEAP_OOM_MARK);
        carry = text.slice(1 - HEAP_OOM_MARK.length);
      }
    } finally {
      closeSync(handle);
    }
  }

  return {
    begin(): void {
      if (logPath === null) return;
      offset = logSize(logPath) ?? 0;
    },
    scan,
    count: (): number | undefined => (logPath === null ? undefined : aborts),
  };
}

/**
 * The inspector of the API worker this run is driving, when it has one.
 *
 * `/ws` is where wrangler's inspector proxy accepts the DevTools socket — the
 * path its own target listing hands out as `webSocketDebuggerUrl`. The root
 * path answers the listing, not the protocol, so a socket opened there reads
 * nothing at all.
 */
export function openInspectorHeapProbe(connect?: InspectorConnect): HeapProbe | null {
  const port = process.env['HB_API_INSPECTOR_PORT'];
  if (port === undefined || port === '') return null;
  return createInspectorHeapProbe(`ws://127.0.0.1:${port}/ws`, connect);
}

/** Wrangler's debug log for this run's API worker, when the run has a port. */
function runWorkerLogPath(): string | null {
  const port = process.env['HB_API_PORT'];
  return port === undefined || port === '' ? null : wranglerDebugLogPath(port);
}

/** One device's cumulative disk counters at one instant. */
interface DiskCounters {
  /** Milliseconds the device had a request in flight. */
  busyMs: number;
  /** Those milliseconds, each weighted by the requests in flight during it. */
  queuedMs: number;
}

/** A mounted btrfs's cumulative commit counters at one instant. */
interface CommitCounters {
  devices: string[];
  commits: number;
  commitMs: number;
}

/** Everything a kernel reading differences against the one before it. */
interface KernelCounters {
  atMs: number;
  disks: Map<string, DiskCounters>;
  /** By filesystem id, which is stable while it stays mounted. */
  btrfs: Map<string, CommitCounters>;
}

/** Where a `/proc/diskstats` row, split on whitespace, holds each field read from it. */
const DISKSTATS_FIELD = { device: 2, busyMs: 12, queuedMs: 13 } as const;

/**
 * Every device the kernel lists is kept, partitions included. A whole device's
 * busy time can read below its partition's, so a series of whole devices alone
 * would understate the saturation it exists to show.
 */
function readDiskCounters(root: string): Map<string, DiskCounters> {
  const disks = new Map<string, DiskCounters>();
  for (const row of readFileSync(path.join(root, 'proc', 'diskstats'), 'utf8').split('\n')) {
    const fields = row.trim().split(/\s+/);
    const device = fields[DISKSTATS_FIELD.device];
    if (device === undefined) continue;
    disks.set(device, {
      busyMs: Number(fields[DISKSTATS_FIELD.busyMs]),
      queuedMs: Number(fields[DISKSTATS_FIELD.queuedMs]),
    });
  }
  return disks;
}

/**
 * What a `/proc` or `/sys` read fails with when the entry it names went away
 * between being listed and being read, or is not this process's to see. Either
 * way there is nothing there to count.
 */
const GONE_CODES = new Set(['ENOENT', 'ESRCH', 'EACCES']);

/** What `read` answers, or nothing where there was nothing there to read. */
function unlessGone<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (GONE_CODES.has(String((error as NodeJS.ErrnoException).code))) return undefined;
    throw error;
  }
}

function readOrNone(file: string): string | undefined {
  return unlessGone(() => readFileSync(file, 'utf8'));
}

function listOrNone(directory: string): string[] {
  return unlessGone(() => readdirSync(directory)) ?? [];
}

function commitCounter(stats: string, name: string, file: string): number {
  const value = new RegExp(String.raw`^${name} (\d+)$`, 'm').exec(stats)?.[1];
  if (value === undefined) throw new Error(`${file} holds no \`${name}\` counter`);
  return Number(value);
}

/**
 * Every mounted btrfs has a directory under `/sys/fs/btrfs` named for its id;
 * an entry with no `commit_stats` in it, such as `features`, is not one.
 */
function readCommitCounters(root: string): Map<string, CommitCounters> {
  const base = path.join(root, 'sys', 'fs', 'btrfs');
  const filesystems = new Map<string, CommitCounters>();
  for (const fsid of listOrNone(base)) {
    const file = path.join(base, fsid, 'commit_stats');
    const stats = readOrNone(file);
    if (stats === undefined) continue;
    filesystems.set(fsid, {
      devices: listOrNone(path.join(base, fsid, 'devices')).toSorted((a, b) => a.localeCompare(b)),
      commits: commitCounter(stats, 'commits', file),
      commitMs: commitCounter(stats, 'total_commit_ms', file),
    });
  }
  return filesystems;
}

function readKernelCounters(root: string): KernelCounters {
  return { atMs: Date.now(), disks: readDiskCounters(root), btrfs: readCommitCounters(root) };
}

/**
 * Each device's load between two readings. A device first seen in the later
 * reading has no interval to measure and is left out; a counter that went
 * backwards restarted, and reads as idle rather than negative.
 */
function diskLoads(previous: KernelCounters, current: KernelCounters): DiskLoad[] {
  const elapsedMs = current.atMs - previous.atMs;
  const perMs = (delta: number): number => (elapsedMs > 0 ? Math.max(0, delta) / elapsedMs : 0);
  const loads: DiskLoad[] = [];
  for (const [device, now] of current.disks) {
    const before = previous.disks.get(device);
    if (before === undefined) continue;
    loads.push({
      device,
      utilisationPct: Math.min(100, round(perMs(now.busyMs - before.busyMs) * 100)),
      inFlight: round(perMs(now.queuedMs - before.queuedMs)),
    });
  }
  return loads;
}

/** Each btrfs's commits between two readings, on the same terms as {@link diskLoads}. */
function btrfsCommits(previous: KernelCounters, current: KernelCounters): BtrfsCommits[] {
  const commits: BtrfsCommits[] = [];
  for (const [fsid, now] of current.btrfs) {
    const before = previous.btrfs.get(fsid);
    if (before === undefined) continue;
    commits.push({
      devices: now.devices,
      commits: Math.max(0, now.commits - before.commits),
      commitMs: Math.max(0, now.commitMs - before.commitMs),
    });
  }
  return commits;
}

const PROCESS_ID = /^\d+$/;

/**
 * The kernel reads a thread's `wchan` as `0` when it will not name the function
 * the thread waits in, as it will not to a process that may not trace the
 * thread. Those threads are counted together under this name rather than as
 * waiting in a function called `0`.
 */
const HIDDEN_WCHAN = '(hidden)';

/** A thread's state, read after the last `)`: the name before it can hold anything, a `)` included. */
function threadState(stat: string): string {
  return stat.charAt(stat.lastIndexOf(')') + 2);
}

/** What the thread at `task` waits in, where it is in D state and still there to read. */
function dStateWait(task: string): string | undefined {
  const stat = readOrNone(path.join(task, 'stat'));
  if (stat === undefined || threadState(stat) !== 'D') return undefined;
  const wchan = readOrNone(path.join(task, 'wchan'))?.trim();
  return wchan === '0' ? HIDDEN_WCHAN : wchan;
}

function tallyDState(root: string): Record<string, number> {
  const proc = path.join(root, 'proc');
  const tally = new Map<string, number>();
  for (const pid of readdirSync(proc).filter((entry) => PROCESS_ID.test(entry))) {
    const tasks = path.join(proc, pid, 'task');
    for (const tid of listOrNone(tasks)) {
      const wait = dStateWait(path.join(tasks, tid));
      if (wait !== undefined) tally.set(wait, (tally.get(wait) ?? 0) + 1);
    }
  }
  return Object.fromEntries(tally);
}

type KernelSeries = Pick<ResourceSample, 'disks' | 'btrfs' | 'dState'>;

const KERNEL_NOT_MEASURED: KernelSeries = { disks: null, btrfs: null, dState: null };

/** Reads the kernel's series for each sample, as differences from the reading before. */
function createKernelReader(root: string): { read: () => KernelSeries } {
  let previous = readKernelCounters(root);
  return {
    read(): KernelSeries {
      const current = readKernelCounters(root);
      const series = {
        disks: diskLoads(previous, current),
        btrfs: btrfsCommits(previous, current),
        dState: tallyDState(root),
      };
      previous = current;
      return series;
    },
  };
}

/** The RAM root a Linux sampler walks: the one it was given, or this checkout's. */
function ramRootOf(configured: string | null | undefined): string | null {
  return configured === undefined ? (e2eRamPaths()?.root ?? null) : configured;
}

export function createResourceSampler(
  intervalMs: number = DEFAULT_INTERVAL_MS,
  options: ResourceSamplerOptions = {}
): ResourceSampler {
  const openHeapProbe = options.openHeapProbe ?? openInspectorHeapProbe;
  const host = options.host ?? { platform: process.platform, root: path.sep };
  const ramRoot = host.platform === 'linux' ? ramRootOf(options.ramRoot) : null;
  const measureRamRoot = options.measureRamRoot ?? ramRootUsedBytes;
  const oomCounter = createHeapOomCounter(
    options.oomLogPath === undefined ? runWorkerLogPath() : options.oomLogPath
  );
  const samples: ResourceSample[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let startMs = 0;
  let previousCpus: CpuTimes = [];
  let heapProbe: HeapProbe | null = null;
  let kernel: { read: () => KernelSeries } | null = null;
  let walking = false;
  let stopped = false;

  /**
   * Walks the root for `sample`. A sample taken while the last walk is still
   * running starts none and is not measured, so walks never pile up behind a
   * stalled filesystem. A walk that fails leaves its sample not measured too,
   * because this series is reporting only and must never be able to fail a run.
   */
  async function measureRamRootFor(sample: ResourceSample): Promise<void> {
    if (ramRoot === null || walking) return;
    walking = true;
    try {
      const bytes = await measureRamRoot(ramRoot);
      if (!stopped) sample.ramRootBytes = bytes;
    } catch {
      // A walk that failed measured nothing, so its sample stays not measured.
      sample.ramRootBytes = null;
    } finally {
      walking = false;
    }
  }

  return {
    start(): void {
      startMs = Date.now();
      previousCpus = os.cpus();
      heapProbe = openHeapProbe();
      kernel = host.platform === 'linux' ? createKernelReader(host.root) : null;
      oomCounter.begin();
      timer = setInterval(() => {
        const { sample, cpus } = takeSample(previousCpus, startMs, heapProbe?.read());
        previousCpus = cpus;
        const taken: ResourceSample = {
          ...sample,
          ...(kernel?.read() ?? KERNEL_NOT_MEASURED),
          ramRootBytes: null,
        };
        samples.push(taken);
        void measureRamRootFor(taken);
        // Read along with the samples rather than in one pass at the end: the
        // log is written at gigabytes per run, and the reader is a reporter.
        oomCounter.scan();
      }, intervalMs);
      // Don't keep the process alive solely for sampling.
      timer.unref();
    },
    stop(): { summary: ResourceSummary; samples: ResourceSample[] } {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      const probeRounds = heapProbe?.stop() ?? [];
      heapProbe = null;
      oomCounter.scan();
      const durationMs = startMs > 0 ? Date.now() - startMs : 0;
      const runFrameRounds = probeRounds.map((round) => ({
        ...round,
        sentMs: round.sentMs - startMs,
        endedMs: round.endedMs - startMs,
      }));
      return {
        summary: {
          ...summarizeSamples(samples, durationMs, oomCounter.count()),
          isolateStalls: detectIsolateStalls(runFrameRounds),
        },
        samples: [...samples],
      };
    },
  };
}
