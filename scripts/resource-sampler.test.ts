import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { SECOND_MS, TEST_DAY_START, freezeClock, setClock } from '@hushbox/shared/test-time';
import {
  computeCpuPercent,
  summarizeSamples,
  formatResourceStdout,
  createResourceSampler,
  createInspectorHeapProbe,
  openInspectorHeapProbe,
  type HeapProbe,
  type InspectorConnection,
  type InspectorHandlers,
  type ResourceSample,
  type ResourceSampler,
  type ResourceSamplerOptions,
  type ResourceSummary,
} from './resource-sampler.js';
import { renderResourceSection } from './lib/playwright/debug-render.js';
import { e2eRamPaths } from './lib/stack/ram-root.js';
import type { Socket } from 'node:net';
import type { HeapProbeRound } from './lib/playwright/stall-windows.js';
import type { ResourceScan } from './resource-scan.js';

type Cpu = ReturnType<typeof os.cpus>[number];

function cpu(idle: number, busy: number): Cpu {
  return { model: 'x', speed: 1, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } };
}

function summary(over: Partial<ResourceSummary> = {}): ResourceSummary {
  return {
    durationMs: 1000,
    sampleCount: 1,
    cores: 4,
    totalMemBytes: 8 * 1024 ** 3,
    cpu: { peak: 0, avg: 0 },
    mem: { peak: 0, avg: 0 },
    load: { peak: 0 },
    isolateStalls: null,
    diskPeaks: null,
    dStateWaits: null,
    ramRootPeakBytes: null,
    ...over,
  };
}

/** A sample off Linux, holding what `over` gives it and flat readings otherwise. */
function sampleAt(t: number, over: Partial<ResourceSample> = {}): ResourceSample {
  return {
    t,
    cpuPct: 1,
    memPct: 1,
    load1: 0,
    disks: null,
    btrfs: null,
    dState: null,
    ramRootBytes: null,
    ...over,
  };
}

function scan(over: Partial<ResourceScan> = {}): ResourceScan {
  return { totalHits: 0, categories: [], ...over };
}

describe('computeCpuPercent', () => {
  it('computes busy percentage from idle/total deltas', () => {
    // total delta 100, idle delta 50 → 50% busy
    expect(computeCpuPercent([cpu(0, 0)], [cpu(50, 50)])).toBe(50);
  });

  it('returns 0 when there is no elapsed cpu time', () => {
    expect(computeCpuPercent([cpu(10, 10)], [cpu(10, 10)])).toBe(0);
  });

  it('returns 0 when there are no cores to compare', () => {
    expect(computeCpuPercent([], [])).toBe(0);
  });
});

describe('summarizeSamples', () => {
  beforeEach(() => {
    vi.spyOn(os, 'cpus').mockReturnValue([cpu(0, 0), cpu(0, 0)]);
    vi.spyOn(os, 'totalmem').mockReturnValue(16 * 1024 ** 3);
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns zeros for no samples', () => {
    const s = summarizeSamples([], 5000);
    expect(s).toMatchObject({ sampleCount: 0, cores: 2, cpu: { peak: 0, avg: 0 } });
    expect(s.totalMemBytes).toBe(16 * 1024 ** 3);
  });

  it('computes peak and average across samples', () => {
    const samples: ResourceSample[] = [
      sampleAt(0, { cpuPct: 40, memPct: 50, load1: 2 }),
      sampleAt(1, { cpuPct: 80, memPct: 60, load1: 3 }),
    ];
    const s = summarizeSamples(samples, 2000);
    expect(s.cpu).toEqual({ peak: 80, avg: 60 });
    expect(s.mem).toEqual({ peak: 60, avg: 55 });
    expect(s.load.peak).toBe(3);
    expect(s.sampleCount).toBe(2);
  });
  it('summarizes API heap peak and average over the samples that carry one', () => {
    const s = summarizeSamples(
      [sampleAt(0, { heapMb: 100 }), sampleAt(1000, { heapMb: 300 }), sampleAt(2000)],
      3000
    );
    expect(s.heap).toEqual({ peak: 300, avg: 200 });
  });

  it('omits the heap figure when no sample carries one', () => {
    expect(summarizeSamples([sampleAt(0)], 1000).heap).toBeUndefined();
  });

  it('names each device’s peak utilisation, busiest first', () => {
    const s = summarizeSamples(
      [
        sampleAt(0, {
          disks: [
            { device: 'sda', utilisationPct: 20, inFlight: 1 },
            { device: 'loop3', utilisationPct: 40, inFlight: 9 },
          ],
        }),
        sampleAt(1000, {
          disks: [
            { device: 'sda', utilisationPct: 5, inFlight: 0 },
            { device: 'loop3', utilisationPct: 100, inFlight: 30 },
            { device: 'loop0', utilisationPct: 0, inFlight: 0 },
          ],
        }),
      ],
      2000
    );

    expect(s.diskPeaks).toEqual([
      { device: 'loop3', peakUtilisationPct: 100 },
      { device: 'sda', peakUtilisationPct: 20 },
      { device: 'loop0', peakUtilisationPct: 0 },
    ]);
  });

  it('counts the D-state waits over every sample, most frequent first', () => {
    const s = summarizeSamples(
      [
        sampleAt(0, { dState: { folio_wait_bit_common: 3, btrfs_commit_transaction: 1 } }),
        sampleAt(1000, { dState: {} }),
        sampleAt(2000, { dState: { btrfs_commit_transaction: 4 } }),
      ],
      3000
    );

    expect(s.dStateWaits).toEqual([
      { wchan: 'btrfs_commit_transaction', seen: 5 },
      { wchan: 'folio_wait_bit_common', seen: 3 },
    ]);
  });

  it('keeps the five most frequent D-state waits, ties in name order', () => {
    const s = summarizeSamples(
      [sampleAt(0, { dState: { f: 1, e: 1, d: 2, c: 3, b: 4, a: 5 } })],
      1000
    );

    expect(s.dStateWaits?.map(({ wchan }) => wchan)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('takes the RAM root’s peak over the samples that measured it', () => {
    const s = summarizeSamples(
      [
        sampleAt(0, { ramRootBytes: 300 }),
        sampleAt(1000, { ramRootBytes: null }),
        sampleAt(2000, { ramRootBytes: 800 }),
      ],
      3000
    );

    expect(s.ramRootPeakBytes).toBe(800);
  });

  it('states every Linux series not measured when no sample measured it', () => {
    const s = summarizeSamples([sampleAt(0), sampleAt(1000)], 2000);

    expect(s).toMatchObject({ diskPeaks: null, dStateWaits: null, ramRootPeakBytes: null });
  });

  it('states every Linux series not measured when there are no samples', () => {
    expect(summarizeSamples([], 0)).toMatchObject({
      diskPeaks: null,
      dStateWaits: null,
      ramRootPeakBytes: null,
    });
  });
});

describe('formatResourceStdout', () => {
  it('renders metrics and the error line (minutes duration)', () => {
    const out = formatResourceStdout({
      summary: summary({
        durationMs: 125_000,
        cpu: { peak: 62, avg: 38 },
        mem: { peak: 44, avg: 30 },
        load: { peak: 19 },
        cores: 24,
      }),
      samples: [],
      scan: scan({
        totalHits: 3,
        categories: [{ name: 'process/thread limit', count: 3, tests: ['a'] }],
      }),
    });
    expect(out).toContain('2m5s');
    expect(out).toContain('CPU     62% / 38%');
    expect(out).toContain('24 cores');
    expect(out).toContain('resource-limit errors: 3');
  });

  it('omits the error line when there are no hits (seconds duration)', () => {
    const out = formatResourceStdout({
      summary: summary({ durationMs: 5000 }),
      samples: [],
      scan: scan(),
    });
    expect(out).toContain('5s');
    expect(out).not.toContain('resource-limit errors');
  });

  it('renders the API heap beside the host metrics', () => {
    const out = formatResourceStdout({
      summary: summary({ heap: { peak: 412.5, avg: 190 } }),
      samples: [],
      scan: scan(),
    });
    expect(out).toContain('API heap  412.5M / 190M');
  });

  it('omits the API heap line when the isolate was never readable', () => {
    const out = formatResourceStdout({ summary: summary(), samples: [], scan: scan() });
    expect(out).not.toContain('API heap');
  });

  it('renders the heap-OOM abort count, zero included', () => {
    const zero = formatResourceStdout({
      summary: summary({ heapOomAborts: 0 }),
      samples: [],
      scan: scan(),
    });
    const some = formatResourceStdout({
      summary: summary({ heapOomAborts: 3 }),
      samples: [],
      scan: scan(),
    });
    expect(zero).toContain('heap-OOM aborts: 0');
    expect(some).toContain('heap-OOM aborts: 3');
  });

  it('omits the heap-OOM abort count when no worker log was read', () => {
    const out = formatResourceStdout({ summary: summary(), samples: [], scan: scan() });
    expect(out).not.toContain('heap-OOM aborts');
  });
});

/** A host whose readings never move, so a test asserts only what it varies. */
function mockHost(): void {
  vi.spyOn(os, 'cpus').mockReturnValue([cpu(1, 1)]);
  vi.spyOn(os, 'totalmem').mockReturnValue(1000);
  vi.spyOn(os, 'freemem').mockReturnValue(400);
  vi.spyOn(os, 'loadavg').mockReturnValue([1, 1, 1]);
}

describe('createResourceSampler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('collects one sample per interval and summarizes', () => {
    vi.useFakeTimers();
    let n = 0;
    vi.spyOn(os, 'cpus').mockImplementation(() => {
      n += 1;
      return [cpu(n * 50, n * 50)];
    });
    vi.spyOn(os, 'totalmem').mockReturnValue(1000);
    vi.spyOn(os, 'freemem').mockReturnValue(400);
    vi.spyOn(os, 'loadavg').mockReturnValue([1.5, 1, 1]);

    const sampler = createResourceSampler(1000);
    sampler.start();
    vi.advanceTimersByTime(3000);
    const { summary: s, samples } = sampler.stop();

    expect(samples).toHaveLength(3);
    expect(s.sampleCount).toBe(3);
    expect(samples[0]?.cpuPct).toBe(50);
    expect(samples[0]?.memPct).toBe(60);
    expect(samples[0]?.load1).toBe(1.5);
  });

  it('records 0% memory when total memory reports as zero', () => {
    vi.useFakeTimers();
    vi.spyOn(os, 'cpus').mockReturnValue([cpu(1, 1)]);
    vi.spyOn(os, 'totalmem').mockReturnValue(0);
    vi.spyOn(os, 'freemem').mockReturnValue(0);
    vi.spyOn(os, 'loadavg').mockReturnValue([0, 0, 0]);

    const sampler = createResourceSampler(1000);
    sampler.start();
    vi.advanceTimersByTime(1000);
    const { samples } = sampler.stop();
    expect(samples[0]?.memPct).toBe(0);
  });

  it('records the API heap reading, in MB, with each sample', () => {
    vi.useFakeTimers();
    mockHost();
    const readings = [undefined, 120 * 1024 ** 2, 130.55 * 1024 ** 2];
    let taken = 0;
    const probe: HeapProbe = {
      read: (): number | undefined => {
        const reading = readings[taken];
        taken += 1;
        return reading;
      },
      stop: (): HeapProbeRound[] => [],
    };

    const sampler = createResourceSampler(1000, { openHeapProbe: () => probe });
    sampler.start();
    vi.advanceTimersByTime(3000);
    const { samples, summary: s } = sampler.stop();

    expect(samples.map((sample) => sample.heapMb)).toEqual([undefined, 120, 130.6]);
    expect(s.heap).toEqual({ peak: 130.6, avg: 125.3 });
  });

  it('closes the heap probe when sampling stops', () => {
    vi.useFakeTimers();
    mockHost();
    const stop = vi.fn((): HeapProbeRound[] => []);
    const sampler = createResourceSampler(1000, {
      openHeapProbe: () => ({ read: () => undefined, stop }),
    });
    sampler.start();
    sampler.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('samples without a heap reading when no probe can be opened', () => {
    vi.useFakeTimers();
    mockHost();
    const sampler = createResourceSampler(1000, { openHeapProbe: () => null });
    sampler.start();
    vi.advanceTimersByTime(1000);
    const { samples, summary: s } = sampler.stop();
    expect(samples[0]?.heapMb).toBeUndefined();
    expect(s.heap).toBeUndefined();
  });

  it('states isolate stalls as not measured when no probe can be opened', () => {
    vi.useFakeTimers();
    mockHost();
    const sampler = createResourceSampler(1000, { openHeapProbe: () => null });
    sampler.start();
    vi.advanceTimersByTime(1000);

    expect(sampler.stop().summary.isolateStalls).toBeNull();
  });

  it('derives isolate stalls from the probe record, in the frame of the resource timeline', () => {
    freezeClock(TEST_DAY_START);
    mockHost();
    const promptReplyMs = 2 * SECOND_MS + 5;
    const lateProbeMs = 4 * SECOND_MS;
    const releaseMs = 9 * SECOND_MS;
    const probe: HeapProbe = {
      read: (): undefined => undefined,
      stop: (): HeapProbeRound[] => [
        {
          sentMs: TEST_DAY_START + 2 * SECOND_MS,
          endedMs: TEST_DAY_START + promptReplyMs,
          answered: true,
        },
        {
          sentMs: TEST_DAY_START + lateProbeMs,
          endedMs: TEST_DAY_START + releaseMs,
          answered: true,
        },
      ],
    };
    const sampler = createResourceSampler(1000, { openHeapProbe: () => probe });
    sampler.start();
    vi.advanceTimersByTime(10 * SECOND_MS);

    expect(sampler.stop().summary.isolateStalls).toEqual([
      {
        onsetAfterMs: promptReplyMs,
        onsetByMs: lateProbeMs,
        releaseMs,
        seconds: (releaseMs - lateProbeMs) / SECOND_MS,
      },
    ]);
  });

  it('is safe to stop without starting', () => {
    const { summary: s, samples } = createResourceSampler().stop();
    expect(samples).toEqual([]);
    expect(s.sampleCount).toBe(0);
    expect(s.durationMs).toBe(0);
  });
});

/**
 * The smallest thing that answers `Runtime.getHeapUsage` over a real socket:
 * an HTTP upgrade, then unmasked text frames. Enough to exercise the probe's
 * own WebSocket rather than a stand-in for it.
 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HEAP_USED_BYTES = 7_340_032;

interface InspectorStub {
  url: string;
  methods: () => string[];
  origins: () => (string | undefined)[];
  liveSockets: () => number;
  sendClose: () => void;
  hangUp: () => Promise<void>;
  close: () => Promise<void>;
}

function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length < 65_536) {
    const header = Buffer.from([0x81, 126, 0, 0]);
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header.writeUInt8(0x81, 0);
  header.writeUInt8(127, 1);
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

/** A frame this probe has no reading to take from, and does not answer. */
const PING_FRAME = Buffer.from([0x89, 0x00]);

const CLOSE_FRAME = Buffer.from([0x88, 0x00]);

/**
 * Writes pieces one at a time, each far enough after the last that the two
 * cannot arrive in one chunk — so a split is the reader's problem rather than
 * the network's — and never interleaves one caller's pieces with another's.
 */
function createPacedWriter(socket: Socket): (pieces: readonly Buffer[]) => void {
  const queue: Buffer[] = [];
  let pumping = false;
  const pump = (): void => {
    const next = queue.shift();
    if (next === undefined || socket.destroyed) {
      queue.length = 0;
      pumping = false;
      return;
    }
    socket.write(next);
    setTimeout(pump, 15);
  };
  return (pieces: readonly Buffer[]): void => {
    queue.push(...pieces);
    if (pumping) return;
    pumping = true;
    setTimeout(pump, 0);
  };
}

/**
 * What the inspector pushes alongside the answers: unasked-for events, at
 * lengths that reach past both of the wider length forms.
 */
function noiseFrames(): Buffer[] {
  return [300, 70_000].map((size) =>
    encodeTextFrame(
      JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { text: 'x'.repeat(size) } })
    )
  );
}

/** One client text frame, unmasked. Short payloads only, which is all we send. */
function decodeTextFrame(frame: Buffer): string {
  const length = frame[1]! & 0x7f;
  const mask = frame.subarray(2, 6);
  const payload = Buffer.from(frame.subarray(6, 6 + length));
  for (const [index, byte] of payload.entries()) payload[index] = byte ^ mask[index % 4]!;
  return payload.toString('utf8');
}

async function startInspectorStub(): Promise<InspectorStub> {
  const methods: string[] = [];
  const origins: (string | undefined)[] = [];
  const sockets: Socket[] = [];
  const writers = new Map<Socket, (pieces: readonly Buffer[]) => void>();
  const hungUp = new Set<Socket>();
  const server: Server = createServer();

  server.on('upgrade', (request, socket: Socket) => {
    sockets.push(socket);
    origins.push(request.headers.origin);
    const write = createPacedWriter(socket);
    writers.set(socket, write);
    // A client that hangs up mid-write leaves this end writing into a socket
    // that is already gone: the same hang-up the end event reports, arriving
    // by another route, and not a failure of the run.
    socket.on('error', () => {
      hungUp.add(socket);
    });
    // An upgraded server socket stays half-open after the client hangs up, so
    // the hang-up itself is the signal, not the socket's own destruction.
    socket.on('end', () => {
      hungUp.add(socket);
    });
    // SHA-1 is what the WebSocket handshake specifies for this value, and the
    // value is a protocol echo rather than a security claim.
    // eslint-disable-next-line sonarjs/hashing -- the handshake's own algorithm
    const accept = createHash('sha1')
      .update(`${String(request.headers['sec-websocket-key'])}${WS_GUID}`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
        `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.on('data', (frame: Buffer) => {
      const call = JSON.parse(decodeTextFrame(frame)) as { id: number; method: string };
      methods.push(call.method);
      const reply = encodeTextFrame(
        JSON.stringify({ id: call.id, result: { usedSize: HEAP_USED_BYTES, totalSize: 1 } })
      );
      if (methods.length > 1) {
        write([reply]);
        return;
      }
      const [short, long] = noiseFrames();
      // What the first reply has to survive: a frame of a kind it does not
      // read, two events long enough to need the wider length fields, and
      // every one of them torn at a boundary a reader might assume is whole.
      write([
        PING_FRAME,
        short!.subarray(0, 3),
        short!.subarray(3),
        long!.subarray(0, 5),
        long!.subarray(5),
        reply.subarray(0, 1),
        reply.subarray(1),
      ]);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const destroyAll = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  return {
    url: `ws://127.0.0.1:${String(port)}/`,
    methods: (): string[] => [...methods],
    origins: (): (string | undefined)[] => [...origins],
    liveSockets: (): number =>
      sockets.filter((socket) => !socket.destroyed && !hungUp.has(socket)).length,
    sendClose: (): void => {
      for (const socket of sockets) writers.get(socket)?.([CLOSE_FRAME]);
    },
    hangUp: destroyAll,
    close: async (): Promise<void> => {
      await destroyAll();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        })
      );
    },
  };
}

describe('createInspectorHeapProbe', () => {
  function fakeInspector(): {
    handlers: InspectorHandlers;
    sent: string[];
    closed: () => number;
    connect: (url: string, handlers: InspectorHandlers) => InspectorConnection;
    urls: string[];
  } {
    const sent: string[] = [];
    const urls: string[] = [];
    let closes = 0;
    let captured: InspectorHandlers | undefined;
    const connect = (url: string, handlers: InspectorHandlers): InspectorConnection => {
      urls.push(url);
      captured = handlers;
      return {
        send: (payload: string): void => {
          sent.push(payload);
        },
        close: (): void => {
          closes += 1;
        },
      };
    };
    return {
      get handlers(): InspectorHandlers {
        if (captured === undefined) throw new Error('nothing connected');
        return captured;
      },
      sent,
      urls,
      closed: (): number => closes,
      connect,
    };
  }

  const heapUsage = (id: number, usedSize: number): string =>
    JSON.stringify({ id, result: { usedSize, totalSize: usedSize * 2 } });

  it('answers nothing before the inspector has reported a reading', () => {
    const inspector = fakeInspector();
    const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', inspector.connect);
    inspector.handlers.onOpen();
    expect(probe.read()).toBeUndefined();
  });

  it('answers the used-heap bytes the inspector reported', () => {
    const inspector = fakeInspector();
    const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', inspector.connect);
    inspector.handlers.onOpen();
    inspector.handlers.onMessage(heapUsage(1, 1_234_567));
    expect(probe.read()).toBe(1_234_567);
  });

  it('asks the isolate for a fresh reading on open and on every read', () => {
    const inspector = fakeInspector();
    const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', inspector.connect);
    inspector.handlers.onOpen();
    probe.read();
    probe.read();
    expect(inspector.sent.map((payload) => JSON.parse(payload) as { method: string })).toEqual([
      { id: 1, method: 'Runtime.getHeapUsage' },
      { id: 2, method: 'Runtime.getHeapUsage' },
      { id: 3, method: 'Runtime.getHeapUsage' },
    ]);
  });

  it('discards a frame it cannot read a heap size out of', () => {
    const inspector = fakeInspector();
    const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', inspector.connect);
    inspector.handlers.onOpen();
    inspector.handlers.onMessage('not json');
    inspector.handlers.onMessage(JSON.stringify({ method: 'Runtime.executionContextCreated' }));
    expect(probe.read()).toBeUndefined();
  });

  it('answers nothing on the read that follows a dropped connection', () => {
    const inspector = fakeInspector();
    const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', inspector.connect);
    inspector.handlers.onOpen();
    inspector.handlers.onMessage(heapUsage(1, 999));
    inspector.handlers.onClosed();
    expect(probe.read()).toBeUndefined();
  });

  it('reconnects after the isolate is lost, and answers again', () => {
    const inspector = fakeInspector();
    const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', inspector.connect);
    inspector.handlers.onOpen();
    inspector.handlers.onMessage(heapUsage(1, 111));
    inspector.handlers.onClosed();

    expect(probe.read()).toBeUndefined();
    inspector.handlers.onOpen();
    inspector.handlers.onMessage(heapUsage(1, 222));

    expect(probe.read()).toBe(222);
    expect(inspector.urls).toHaveLength(2);
  });

  it('follows an isolate lost and respawned far more often than a dead one is retried', () => {
    const inspector = fakeInspector();
    const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', inspector.connect);
    for (let round = 0; round < 20; round += 1) {
      inspector.handlers.onOpen();
      inspector.handlers.onClosed();
      probe.read();
    }
    inspector.handlers.onOpen();
    inspector.handlers.onMessage(heapUsage(1, 333));

    expect(probe.read()).toBe(333);
    expect(inspector.urls).toHaveLength(21);
  });

  it('stops attempting an inspector that never answers', () => {
    let attempts = 0;
    const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', (_url, handlers) => {
      attempts += 1;
      handlers.onClosed();
      return { send: (): void => undefined, close: (): void => undefined };
    });
    for (let read = 0; read < 20; read += 1) probe.read();
    const settled = attempts;
    for (let read = 0; read < 20; read += 1) probe.read();

    expect(settled).toBeGreaterThan(1);
    expect(attempts).toBe(settled);
  });

  it('opens nothing more once it has been stopped', () => {
    const inspector = fakeInspector();
    const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', inspector.connect);
    inspector.handlers.onClosed();
    probe.stop();

    expect(probe.read()).toBeUndefined();
    expect(inspector.urls).toHaveLength(1);
  });

  it('opens one connection at a time while an attempt is still in flight', () => {
    const inspector = fakeInspector();
    const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', inspector.connect);
    probe.read();
    probe.read();

    expect(inspector.urls).toHaveLength(1);
  });

  it('answers nothing when the connection cannot be opened at all', () => {
    const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', () => {
      throw new Error('ECONNREFUSED');
    });
    expect(probe.read()).toBeUndefined();
    expect(() => {
      probe.stop();
    }).not.toThrow();
  });

  it('answers nothing when the reading cannot be requested', () => {
    const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', (_url, handlers) => {
      handlers.onOpen();
      return {
        send: (): void => {
          throw new Error('socket is closing');
        },
        close: (): void => undefined,
      };
    });
    expect(probe.read()).toBeUndefined();
  });

  it('gives up quietly on a connection that cannot be closed', () => {
    const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', () => ({
      send: (): void => undefined,
      close: (): void => {
        throw new Error('already gone');
      },
    }));
    expect(() => {
      probe.stop();
    }).not.toThrow();
  });

  describe('its record of the probes it sent', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const WAIT_MS = 3 * SECOND_MS;

    it('times a probe from its send to its reply', () => {
      freezeClock(TEST_DAY_START);
      const inspector = fakeInspector();
      const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', inspector.connect);
      inspector.handlers.onOpen();
      setClock(TEST_DAY_START + WAIT_MS);
      inspector.handlers.onMessage(heapUsage(1, 999));

      expect(probe.stop()).toEqual([
        { sentMs: TEST_DAY_START, endedMs: TEST_DAY_START + WAIT_MS, answered: true },
      ]);
    });

    it('ends a probe the connection closed on as never answered, at the close', () => {
      freezeClock(TEST_DAY_START);
      const inspector = fakeInspector();
      const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', inspector.connect);
      inspector.handlers.onOpen();
      setClock(TEST_DAY_START + WAIT_MS);
      inspector.handlers.onClosed();
      setClock(TEST_DAY_START + 2 * WAIT_MS);

      expect(probe.stop()).toEqual([
        { sentMs: TEST_DAY_START, endedMs: TEST_DAY_START + WAIT_MS, answered: false },
      ]);
    });

    it('ends a probe still outstanding when stopped as never answered, at the stop', () => {
      freezeClock(TEST_DAY_START);
      const inspector = fakeInspector();
      const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', inspector.connect);
      inspector.handlers.onOpen();
      setClock(TEST_DAY_START + WAIT_MS);

      expect(probe.stop()).toEqual([
        { sentMs: TEST_DAY_START, endedMs: TEST_DAY_START + WAIT_MS, answered: false },
      ]);
    });

    it('answers no probe with a reply to a request it is not waiting on', () => {
      freezeClock(TEST_DAY_START);
      const inspector = fakeInspector();
      const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', inspector.connect);
      inspector.handlers.onOpen();
      inspector.handlers.onMessage(heapUsage(7, 999));
      setClock(TEST_DAY_START + WAIT_MS);

      expect(probe.stop()).toEqual([
        { sentMs: TEST_DAY_START, endedMs: TEST_DAY_START + WAIT_MS, answered: false },
      ]);
    });

    it('records no probe it could not send', () => {
      const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', (_url, handlers) => {
        handlers.onOpen();
        return {
          send: (): void => {
            throw new Error('socket is closing');
          },
          close: (): void => undefined,
        };
      });
      probe.read();

      expect(probe.stop()).toEqual([]);
    });

    it('ends the probes it was waiting on when a send fails, at the failure', () => {
      freezeClock(TEST_DAY_START);
      let opened: InspectorHandlers | undefined;
      let sends = 0;
      const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', (_url, handlers) => {
        opened = handlers;
        return {
          send: (): void => {
            sends += 1;
            if (sends > 1) throw new Error('socket is closing');
          },
          close: (): void => undefined,
        };
      });
      opened?.onOpen();
      setClock(TEST_DAY_START + WAIT_MS);
      probe.read();
      setClock(TEST_DAY_START + 2 * WAIT_MS);

      expect(probe.stop()).toEqual([
        { sentMs: TEST_DAY_START, endedMs: TEST_DAY_START + WAIT_MS, answered: false },
      ]);
    });
  });

  it('closes the connection when stopped', () => {
    const inspector = fakeInspector();
    const probe = createInspectorHeapProbe('ws://127.0.0.1:1/', inspector.connect);
    probe.stop();
    expect(inspector.closed()).toBe(1);
  });

  it('reads a heap figure off a real socket', async () => {
    const stub = await startInspectorStub();
    const probe = createInspectorHeapProbe(stub.url);
    try {
      await vi.waitFor(() => {
        expect(probe.read()).toBe(7_340_032);
      });
      expect(stub.methods()).toContain('Runtime.getHeapUsage');
    } finally {
      probe.stop();
      await stub.close();
    }
  });

  it('records the reply to a probe sent over a real socket as answered', async () => {
    const stub = await startInspectorStub();
    const probe = createInspectorHeapProbe(stub.url);
    try {
      await vi.waitFor(() => {
        expect(probe.read()).toBe(7_340_032);
      });
    } finally {
      const rounds = probe.stop();
      await stub.close();
      expect(rounds.filter((round) => round.answered)).not.toHaveLength(0);
    }
  });

  it("declares the inspector's own origin, which the proxy refuses an upgrade without", async () => {
    const stub = await startInspectorStub();
    const probe = createInspectorHeapProbe(stub.url);
    try {
      await vi.waitFor(() => {
        expect(probe.read()).toBe(7_340_032);
      });
      expect(stub.origins()).toEqual([new URL(stub.url).origin.replace('ws:', 'http:')]);
    } finally {
      probe.stop();
      await stub.close();
    }
  });

  it('reads a reply out of a stream of unasked-for frames torn at every boundary', async () => {
    const stub = await startInspectorStub();
    const probe = createInspectorHeapProbe(stub.url);
    try {
      await vi.waitFor(
        () => {
          expect(probe.read()).toBe(7_340_032);
        },
        { timeout: 4000 }
      );
    } finally {
      probe.stop();
      await stub.close();
    }
  });

  it('lets go of the socket when stopped, without waiting on the far end', async () => {
    const stub = await startInspectorStub();
    const probe = createInspectorHeapProbe(stub.url);
    try {
      await vi.waitFor(() => {
        expect(probe.read()).toBe(7_340_032);
      });
      probe.stop();
      await vi.waitFor(() => {
        expect(stub.liveSockets()).toBe(0);
      });
    } finally {
      await stub.close();
    }
  });

  it('answers nothing once the inspector closes the connection politely', async () => {
    const stub = await startInspectorStub();
    const probe = createInspectorHeapProbe(stub.url);
    try {
      await vi.waitFor(
        () => {
          expect(probe.read()).toBe(7_340_032);
        },
        { timeout: 4000 }
      );
      stub.sendClose();
      await vi.waitFor(() => {
        expect(probe.read()).toBeUndefined();
      });
    } finally {
      probe.stop();
      await stub.close();
    }
  });

  it('answers nothing once a real inspector hangs up', async () => {
    const stub = await startInspectorStub();
    const probe = createInspectorHeapProbe(stub.url);
    try {
      await vi.waitFor(() => {
        expect(probe.read()).toBe(7_340_032);
      });
      await stub.hangUp();
      await vi.waitFor(() => {
        expect(probe.read()).toBeUndefined();
      });
    } finally {
      probe.stop();
      await stub.close();
    }
  });

  it('reads again from a real inspector that hung up on it', async () => {
    const stub = await startInspectorStub();
    const probe = createInspectorHeapProbe(stub.url);
    try {
      await vi.waitFor(() => {
        expect(probe.read()).toBe(7_340_032);
      });
      await stub.hangUp();
      await vi.waitFor(() => {
        expect(probe.read()).toBeUndefined();
      });
      await vi.waitFor(
        () => {
          expect(probe.read()).toBe(7_340_032);
        },
        { timeout: 4000 }
      );
      expect(stub.origins()).toHaveLength(2);
    } finally {
      probe.stop();
      await stub.close();
    }
  });

  it('reports the connection closed when nothing is listening on the port', async () => {
    const probe = createInspectorHeapProbe('ws://127.0.0.1:1/');
    await vi.waitFor(() => {
      expect(probe.read()).toBeUndefined();
    });
    probe.stop();
  });
});

describe('openInspectorHeapProbe', () => {
  const INSPECTOR_PORT = 'HB_API_INSPECTOR_PORT';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('opens no probe when this run has no inspector port', () => {
    vi.stubEnv(INSPECTOR_PORT, '');
    expect(openInspectorHeapProbe()).toBeNull();
    Reflect.deleteProperty(process.env, INSPECTOR_PORT);
    expect(openInspectorHeapProbe()).toBeNull();
  });

  it("connects to the loopback inspector on this run's port", () => {
    vi.stubEnv(INSPECTOR_PORT, '13100');
    const urls: string[] = [];
    const probe = openInspectorHeapProbe((url) => {
      urls.push(url);
      return { send: (): void => undefined, close: (): void => undefined };
    });
    expect(urls).toEqual(['ws://127.0.0.1:13100/ws']);
    probe?.stop();
  });
});

describe('createResourceSampler (heap-OOM aborts)', () => {
  const ABORT_LINE =
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n';
  let logDir: string;
  let logPath: string;

  beforeEach(() => {
    logDir = mkdtempSync(path.join(os.tmpdir(), 'resource-sampler-'));
    logPath = path.join(logDir, 'worker.log');
    vi.useFakeTimers();
    mockHost();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(logDir, { recursive: true, force: true });
  });

  function sample(): ResourceSummary {
    const sampler = createResourceSampler(1000, { openHeapProbe: () => null, oomLogPath: logPath });
    sampler.start();
    appendFileSync(logPath, ABORT_LINE);
    vi.advanceTimersByTime(1000);
    appendFileSync(logPath, `a line${ABORT_LINE}`);
    return sampler.stop().summary;
  }

  it('counts the heap-OOM aborts the worker logged during the window', () => {
    writeFileSync(logPath, 'listening\n');
    expect(sample().heapOomAborts).toBe(2);
  });

  it('counts nothing the log already held when sampling started', () => {
    writeFileSync(logPath, `${ABORT_LINE}${ABORT_LINE}`);
    expect(sample().heapOomAborts).toBe(2);
  });

  it('counts an abort logged after the worker restarted and truncated the log', () => {
    writeFileSync(logPath, 'a long first session that is then replaced\n'.repeat(20));
    const sampler = createResourceSampler(1000, {
      openHeapProbe: () => null,
      oomLogPath: logPath,
    });
    sampler.start();
    writeFileSync(logPath, ABORT_LINE);
    expect(sampler.stop().summary.heapOomAborts).toBe(1);
  });

  it('counts an abort split across two reads only once', () => {
    writeFileSync(logPath, 'listening\n');
    const sampler = createResourceSampler(1000, {
      openHeapProbe: () => null,
      oomLogPath: logPath,
    });
    sampler.start();
    appendFileSync(logPath, 'FATAL ERROR: JavaScript heap ou');
    vi.advanceTimersByTime(1000);
    appendFileSync(logPath, 't of memory\n');
    expect(sampler.stop().summary.heapOomAborts).toBe(1);
  });

  it('reports no aborts rather than failing when the log is not there', () => {
    const sampler = createResourceSampler(1000, {
      openHeapProbe: () => null,
      oomLogPath: path.join(logDir, 'never-written.log'),
    });
    sampler.start();
    vi.advanceTimersByTime(1000);
    expect(sampler.stop().summary.heapOomAborts).toBe(0);
  });

  it('names no worker log when this run has no API port', () => {
    vi.stubEnv('HB_API_PORT', '');
    const blank = createResourceSampler(1000, { openHeapProbe: () => null });
    blank.start();
    expect(blank.stop().summary.heapOomAborts).toBeUndefined();

    Reflect.deleteProperty(process.env, 'HB_API_PORT');
    const absent = createResourceSampler(1000, { openHeapProbe: () => null });
    absent.start();
    expect(absent.stop().summary.heapOomAborts).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('reports nothing at all when this run names no worker log', () => {
    const sampler = createResourceSampler(1000, { openHeapProbe: () => null, oomLogPath: null });
    sampler.start();
    expect(sampler.stop().summary.heapOomAborts).toBeUndefined();
  });
});

describe('createResourceSampler (the Linux kernel’s view)', () => {
  let hostRoot: string;

  beforeEach(() => {
    hostRoot = mkdtempSync(path.join(os.tmpdir(), 'resource-sampler-host-'));
    writeAt(path.join('proc', 'diskstats'), '');
    vi.useFakeTimers();
    mockHost();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(hostRoot, { recursive: true, force: true });
  });

  /** Writes `text` at `relative` under the fixture host, making its directories. */
  function writeAt(relative: string, text: string): void {
    const file = path.join(hostRoot, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }

  interface DiskCounters {
    device: string;
    busyMs: number;
    queuedMs: number;
  }

  /**
   * `/proc/diskstats` as the kernel lays it out, aligned and with every field a
   * current kernel prints. The counters these rows do not name are zero.
   */
  function writeDiskstats(disks: readonly DiskCounters[]): void {
    const rows = disks.map(
      ({ device, busyMs, queuedMs }) =>
        `   7       0 ${device} 0 0 0 0 0 0 0 0 0 ${String(busyMs)} ${String(queuedMs)} 0 0 0 0 0 0\n`
    );
    writeAt(path.join('proc', 'diskstats'), rows.join(''));
  }

  function markPartition(device: string): void {
    writeAt(path.join('sys', 'class', 'block', device, 'partition'), '1\n');
  }

  /** A sampler reading nothing but the fixture host's kernel. */
  function linuxSampler(over: Partial<ResourceSamplerOptions> = {}): ResourceSampler {
    return createResourceSampler(1000, {
      openHeapProbe: () => null,
      oomLogPath: null,
      host: { platform: 'linux', root: hostRoot },
      ramRoot: null,
      ...over,
    });
  }

  /** The one sample a sampler takes over one interval in which the disks moved from `before` to `after`. */
  function sampleAcross(
    before: readonly DiskCounters[],
    after: readonly DiskCounters[]
  ): ResourceSample | undefined {
    writeDiskstats(before);
    const sampler = linuxSampler();
    sampler.start();
    writeDiskstats(after);
    vi.advanceTimersByTime(1000);
    return sampler.stop().samples[0];
  }

  describe('its disk series', () => {
    it('records the share of the interval each device was busy', () => {
      const sample = sampleAcross(
        [
          { device: 'sda', busyMs: 1000, queuedMs: 0 },
          { device: 'loop3', busyMs: 0, queuedMs: 0 },
        ],
        [
          { device: 'sda', busyMs: 1250, queuedMs: 0 },
          { device: 'loop3', busyMs: 1000, queuedMs: 0 },
        ]
      );

      expect(
        sample?.disks?.map(({ device, utilisationPct }) => ({ device, utilisationPct }))
      ).toEqual([
        { device: 'sda', utilisationPct: 25 },
        { device: 'loop3', utilisationPct: 100 },
      ]);
    });

    it('records the requests each device held in flight, averaged over the interval', () => {
      const sample = sampleAcross(
        [{ device: 'dm-0', busyMs: 0, queuedMs: 500 }],
        [{ device: 'dm-0', busyMs: 1000, queuedMs: 3500 }]
      );

      expect(sample?.disks?.[0]?.inFlight).toBe(3);
    });

    /**
     * A whole device and its partition over one interval, the partition the
     * busier, as a disk holding one partitioned filesystem reads: the whole
     * device's busy time understates its partition's.
     */
    function sampleDiskAndPartition(): ResourceSampler {
      markPartition('sda1');
      writeDiskstats([
        { device: 'sda', busyMs: 0, queuedMs: 0 },
        { device: 'sda1', busyMs: 0, queuedMs: 0 },
      ]);
      const sampler = linuxSampler();
      sampler.start();
      writeDiskstats([
        { device: 'sda', busyMs: 425, queuedMs: 6840 },
        { device: 'sda1', busyMs: 601, queuedMs: 6820 },
      ]);
      vi.advanceTimersByTime(1000);
      return sampler;
    }

    it('records a partition beside its whole device', () => {
      const sample = sampleDiskAndPartition().stop().samples[0];

      expect(sample?.disks).toEqual([
        { device: 'sda', utilisationPct: 42.5, inFlight: 6.8 },
        { device: 'sda1', utilisationPct: 60.1, inFlight: 6.8 },
      ]);
    });

    it('reports a busy partition beside its whole device', () => {
      const { summary: sampled, samples } = sampleDiskAndPartition().stop();

      expect(renderResourceSection({ summary: sampled, samples, scan: scan() })).toContain(
        '**Disk utilisation, peak per device:** sda1 60.1% · sda 42.5%'
      );
    });

    it('caps a device’s utilisation at the whole interval', () => {
      const sample = sampleAcross(
        [{ device: 'loop3', busyMs: 0, queuedMs: 0 }],
        [{ device: 'loop3', busyMs: 1040, queuedMs: 0 }]
      );

      expect(sample?.disks?.[0]?.utilisationPct).toBe(100);
    });

    it('records nothing for a device that appeared since the last reading', () => {
      const sample = sampleAcross(
        [{ device: 'sda', busyMs: 0, queuedMs: 0 }],
        [
          { device: 'sda', busyMs: 0, queuedMs: 0 },
          { device: 'loop7', busyMs: 900, queuedMs: 900 },
        ]
      );

      expect(sample?.disks?.map(({ device }) => device)).toEqual(['sda']);
    });

    it('records a device whose counters restarted as idle rather than negative', () => {
      const sample = sampleAcross(
        [{ device: 'loop3', busyMs: 5000, queuedMs: 5000 }],
        [{ device: 'loop3', busyMs: 10, queuedMs: 10 }]
      );

      expect(sample?.disks).toEqual([{ device: 'loop3', utilisationPct: 0, inFlight: 0 }]);
    });

    it('records no load for an interval in which the clock did not advance', () => {
      writeDiskstats([{ device: 'sda', busyMs: 0, queuedMs: 0 }]);
      const sampler = linuxSampler();
      sampler.start();
      writeDiskstats([{ device: 'sda', busyMs: 700, queuedMs: 700 }]);
      vi.setSystemTime(Date.now() - 1000);
      vi.advanceTimersByTime(1000);

      expect(sampler.stop().samples[0]?.disks).toEqual([
        { device: 'sda', utilisationPct: 0, inFlight: 0 },
      ]);
    });
  });

  describe('its btrfs series', () => {
    /** One mounted btrfs: its commit record, and its member devices as sysfs lists them. */
    function writeBtrfs(
      fsid: string,
      devices: readonly string[],
      commits: { count: number; totalMs: number }
    ): void {
      const base = path.join('sys', 'fs', 'btrfs', fsid);
      writeAt(
        path.join(base, 'commit_stats'),
        `commits ${String(commits.count)}\ncur_commit_ms 0\nlast_commit_ms 12\n` +
          `max_commit_ms 900\ntotal_commit_ms ${String(commits.totalMs)}\n`
      );
      for (const device of devices) writeAt(path.join(base, 'devices', device), '');
    }

    function btrfsAcross(before: () => void, after: () => void): ResourceSample | undefined {
      before();
      const sampler = linuxSampler();
      sampler.start();
      after();
      vi.advanceTimersByTime(1000);
      return sampler.stop().samples[0];
    }

    it('records each mounted btrfs’s commits and commit time over the interval, by its devices', () => {
      const sample = btrfsAcross(
        () => {
          writeBtrfs('fs-docker', ['loop3'], { count: 100, totalMs: 5000 });
          writeBtrfs('fs-cache', ['sdf1', 'sde1'], { count: 7, totalMs: 70 });
        },
        () => {
          writeBtrfs('fs-docker', ['loop3'], { count: 103, totalMs: 9500 });
          writeBtrfs('fs-cache', ['sdf1', 'sde1'], { count: 7, totalMs: 70 });
        }
      );

      expect(sample?.btrfs).toEqual(
        expect.arrayContaining([
          { devices: ['loop3'], commits: 3, commitMs: 4500 },
          { devices: ['sde1', 'sdf1'], commits: 0, commitMs: 0 },
        ])
      );
      expect(sample?.btrfs).toHaveLength(2);
    });

    it('passes over an entry that holds no commit record', () => {
      mkdirSync(path.join(hostRoot, 'sys', 'fs', 'btrfs', 'features'), { recursive: true });
      const sample = btrfsAcross(
        () => {
          writeBtrfs('fs-docker', ['loop3'], { count: 1, totalMs: 1 });
        },
        () => {
          writeBtrfs('fs-docker', ['loop3'], { count: 2, totalMs: 2 });
        }
      );

      expect(sample?.btrfs).toEqual([{ devices: ['loop3'], commits: 1, commitMs: 1 }]);
    });

    it('records none on a host with no btrfs mounted', () => {
      const sample = btrfsAcross(
        () => undefined,
        () => undefined
      );

      expect(sample?.btrfs).toEqual([]);
    });

    it('records nothing for a btrfs mounted since the last reading', () => {
      const sample = btrfsAcross(
        () => undefined,
        () => {
          writeBtrfs('fs-docker', ['loop3'], { count: 40, totalMs: 400 });
        }
      );

      expect(sample?.btrfs).toEqual([]);
    });

    it('refuses a commit record it cannot read, naming it', () => {
      writeAt(path.join('sys', 'fs', 'btrfs', 'fs-odd', 'commit_stats'), 'transactions 4\n');

      expect(() => {
        linuxSampler().start();
      }).toThrow(path.join('fs-odd', 'commit_stats'));
    });
  });

  describe('its tally of threads in uninterruptible sleep', () => {
    /**
     * One thread's `stat` and `wchan`. The name is one a thread can really
     * carry — spaces and a closing parenthesis inside the parentheses — which
     * is why the state is read after the last `)`, never by field position.
     */
    function writeThread(pid: number, tid: number, state: string, wchan?: string): void {
      const task = path.join('proc', String(pid), 'task', String(tid));
      writeAt(
        path.join(task, 'stat'),
        `${String(tid)} (Web Content) x) ${state} 1 ${String(pid)} 0\n`
      );
      if (wchan !== undefined) writeAt(path.join(task, 'wchan'), wchan);
    }

    function tallyAfterOneInterval(): ResourceSample['dState'] | undefined {
      const sampler = linuxSampler();
      sampler.start();
      vi.advanceTimersByTime(1000);
      return sampler.stop().samples[0]?.dState;
    }

    it('counts every process’s threads in D state by the kernel function each waits in', () => {
      writeThread(10, 10, 'D', 'folio_wait_bit_common');
      writeThread(10, 11, 'D', 'folio_wait_bit_common');
      writeThread(10, 12, 'S', 'do_epoll_wait');
      writeThread(20, 21, 'D', 'btrfs_commit_transaction');
      writeThread(30, 30, 'R', '0');

      expect(tallyAfterOneInterval()).toEqual({
        folio_wait_bit_common: 2,
        btrfs_commit_transaction: 1,
      });
    });

    it('counts the threads whose wait the kernel will not name together, under one name', () => {
      writeThread(10, 10, 'D', '0');
      writeThread(20, 20, 'D', '0');

      expect(tallyAfterOneInterval()).toEqual({ '(hidden)': 2 });
    });

    it('counts no thread that exited while it was being read', () => {
      mkdirSync(path.join(hostRoot, 'proc', '40'), { recursive: true });
      mkdirSync(path.join(hostRoot, 'proc', '50', 'task', '51'), { recursive: true });
      writeThread(60, 60, 'D');

      expect(tallyAfterOneInterval()).toEqual({});
    });

    // Unlistable, so a tally that took a hidden process for an error would
    // fail the run instead of counting what it can see.
    it.skipIf(process.platform === 'win32')(
      'counts no thread of a process this one may not read',
      () => {
        writeThread(10, 10, 'D', 'folio_wait_bit_common');
        const hidden = path.join(hostRoot, 'proc', '10', 'task');
        chmodSync(hidden, 0o000);

        try {
          expect(tallyAfterOneInterval()).toEqual({});
        } finally {
          chmodSync(hidden, 0o700);
        }
      }
    );

    it('surfaces a thread record it cannot read for any other reason', () => {
      mkdirSync(path.join(hostRoot, 'proc', '70', 'task', '70', 'stat'), { recursive: true });
      const sampler = linuxSampler();
      sampler.start();

      expect(() => {
        vi.advanceTimersByTime(1000);
      }).toThrow(/EISDIR/);
    });
  });

  describe('its RAM root series', () => {
    const RAM_ROOT = path.join(path.sep, 'ram', 'hushbox-e2e-fixture');

    /** Walks that end only when the test ends them, one per call, in the order they began. */
    function heldWalks(): {
      measureRamRoot: (root: string) => Promise<number>;
      roots: string[];
      finish: (bytes: number) => Promise<void>;
      fail: () => Promise<void>;
    } {
      const roots: string[] = [];
      const pending: PromiseWithResolvers<number>[] = [];
      return {
        roots,
        measureRamRoot: (root: string): Promise<number> => {
          roots.push(root);
          const walk = Promise.withResolvers<number>();
          pending.push(walk);
          return walk.promise;
        },
        // The sampler awaited the walk before the test did, so it has taken the
        // outcome by the time the test's own await returns.
        finish: async (bytes: number): Promise<void> => {
          const walk = pending.shift();
          walk?.resolve(bytes);
          await walk?.promise;
        },
        fail: async (): Promise<void> => {
          const walk = pending.shift();
          walk?.reject(new Error('EACCES: a store the walk cannot list'));
          await walk?.promise.catch(() => undefined);
        },
      };
    }

    it('records the bytes the root occupies with the sample its walk began at', async () => {
      const walks = heldWalks();
      const sampler = linuxSampler({ ramRoot: RAM_ROOT, measureRamRoot: walks.measureRamRoot });
      sampler.start();
      vi.advanceTimersByTime(1000);
      await walks.finish(48 * 1024 ** 2);

      expect(walks.roots).toEqual([RAM_ROOT]);
      expect(sampler.stop().samples[0]?.ramRootBytes).toBe(48 * 1024 ** 2);
    });

    it('starts no walk while the last one is still running', async () => {
      const walks = heldWalks();
      const sampler = linuxSampler({ ramRoot: RAM_ROOT, measureRamRoot: walks.measureRamRoot });
      sampler.start();
      vi.advanceTimersByTime(2000);
      await walks.finish(1024);

      expect(walks.roots).toHaveLength(1);
      expect(sampler.stop().samples.map((sample) => sample.ramRootBytes)).toEqual([1024, null]);
    });

    it('walks again once the last walk has ended', async () => {
      const walks = heldWalks();
      const sampler = linuxSampler({ ramRoot: RAM_ROOT, measureRamRoot: walks.measureRamRoot });
      sampler.start();
      vi.advanceTimersByTime(1000);
      await walks.finish(1024);
      vi.advanceTimersByTime(1000);
      await walks.finish(2048);

      expect(sampler.stop().samples.map((sample) => sample.ramRootBytes)).toEqual([1024, 2048]);
    });

    it('leaves a sample whose walk failed not measured', async () => {
      const walks = heldWalks();
      const sampler = linuxSampler({ ramRoot: RAM_ROOT, measureRamRoot: walks.measureRamRoot });
      sampler.start();
      vi.advanceTimersByTime(1000);
      await walks.fail();

      expect(sampler.stop().samples[0]?.ramRootBytes).toBeNull();
    });

    it('keeps no reading that lands after sampling stopped', async () => {
      const walks = heldWalks();
      const sampler = linuxSampler({ ramRoot: RAM_ROOT, measureRamRoot: walks.measureRamRoot });
      sampler.start();
      vi.advanceTimersByTime(1000);
      const { samples } = sampler.stop();
      await walks.finish(1024);

      expect(samples[0]?.ramRootBytes).toBeNull();
    });

    it('walks nothing where it is given no root', () => {
      const walks = heldWalks();
      const sampler = linuxSampler({ ramRoot: null, measureRamRoot: walks.measureRamRoot });
      sampler.start();
      vi.advanceTimersByTime(1000);

      expect(walks.roots).toEqual([]);
      expect(sampler.stop().samples[0]?.ramRootBytes).toBeNull();
    });

    it('walks this checkout’s E2E RAM root when given none', () => {
      const walks = heldWalks();
      const withDefault = createResourceSampler(1000, {
        openHeapProbe: () => null,
        oomLogPath: null,
        host: { platform: 'linux', root: hostRoot },
        measureRamRoot: walks.measureRamRoot,
      });
      withDefault.start();
      vi.advanceTimersByTime(1000);
      withDefault.stop();

      expect(walks.roots).toEqual([e2eRamPaths()?.root]);
    });

    it('walks nothing when this checkout has no E2E RAM root', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
      const walks = heldWalks();
      const sampler = createResourceSampler(1000, {
        openHeapProbe: () => null,
        oomLogPath: null,
        host: { platform: 'linux', root: hostRoot },
        measureRamRoot: walks.measureRamRoot,
      });
      sampler.start();
      vi.advanceTimersByTime(1000);

      expect(walks.roots).toEqual([]);
      expect(sampler.stop().samples[0]?.ramRootBytes).toBeNull();
    });
  });

  it('measures none of the Linux series off Linux', () => {
    writeDiskstats([{ device: 'sda', busyMs: 0, queuedMs: 0 }]);
    let walks = 0;
    const sampler = createResourceSampler(1000, {
      openHeapProbe: () => null,
      oomLogPath: null,
      host: { platform: 'darwin', root: hostRoot },
      ramRoot: path.join(hostRoot, 'ram'),
      measureRamRoot: (): Promise<number> => {
        walks += 1;
        return Promise.resolve(1);
      },
    });
    sampler.start();
    writeDiskstats([{ device: 'sda', busyMs: 500, queuedMs: 500 }]);
    vi.advanceTimersByTime(1000);

    expect(sampler.stop().samples[0]).toMatchObject({
      disks: null,
      btrfs: null,
      dState: null,
      ramRootBytes: null,
    });
    expect(walks).toBe(0);
  });

  it('reads this machine’s own kernel when given no host', () => {
    const sampler = createResourceSampler(1000, {
      openHeapProbe: () => null,
      oomLogPath: null,
      ramRoot: null,
    });
    sampler.start();
    vi.advanceTimersByTime(1000);

    expect(Array.isArray(sampler.stop().samples[0]?.disks)).toBe(process.platform === 'linux');
  });
});
