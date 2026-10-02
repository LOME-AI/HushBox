import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, SERVICE_NAMES, createDb, serviceEvidence } from '@hushbox/db';
import { evidenceDatabaseUrl } from '@hushbox/db/test-db';
import { WebSearchResults } from '@hushbox/shared';
import { AI_RECORDING_VERSION, CASSETTE_FILE_SUFFIX } from '@hushbox/shared/cassettes';
import { requireEnv } from '@hushbox/shared/require-env';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { SHOULD_RUN, deriveIntegrationEnv, processEnvContext } from './integration.setup.js';
import { BraveSearchError, createBraveSearchProvider } from './brave-search.js';
import { resolveSearchProvider } from './resolve-search-provider.js';
import { CASSETTE_ROOT } from './resolve-model-provider.js';
import { beginCassetteScope, endCassetteScope } from './cassette/recording-fetch.js';
import { createCassetteStore } from './cassette/cassette-store.js';
import { createFixtureFetch } from './cassette/failure-fixtures.js';
import type { Database } from '@hushbox/db';
import type { Cassette } from './cassette/cassette-store.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { SearchProvider } from '../ports/index.js';

/**
 * Brave web search through the same gate inference takes. On the credentialled
 * CI-vitest run the search is real: the first run records it through the
 * record-on-miss cassette and later runs replay that recording, and either way
 * a `brave-search` evidence row lands for `verify:evidence` to require. Every
 * other run, pull-request CI included, searches through the fake and writes no
 * row. The query is fixed so its recording keys identically on every run.
 */

const FIXED_QUERY = { query: 'open source web browser' } as const;
const REAL_SEARCH_TIMEOUT_MS = 30_000;
const BRAVE_SEARCH_PATH = '/res/v1/web/search';

interface RecordedCapture {
  readonly error: Error;
  readonly code: string;
}

function recordingTelemetry(captures: RecordedCapture[]): Telemetry {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    captureError: (error, code) => {
      captures.push({ error, code });
    },
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function countEvidence(db: Database): Promise<number> {
  const rows = await db
    .select()
    .from(serviceEvidence)
    .where(eq(serviceEvidence.service, SERVICE_NAMES.BRAVE_SEARCH));
  return rows.length;
}

const GATE = deriveIntegrationEnv(processEnvContext());

/** The worker's own database, where another run's evidence row cannot disturb a before/after count. */
const workerDb = createDb(requireEnv('DATABASE_URL', process.env['DATABASE_URL']), {
  neonDev: LOCAL_NEON_DEV_CONFIG,
});

/** The database `verify:evidence` reads in a later process, reached only on the credentialled run. */
let evidenceDb: Database | undefined;

function realEvidenceDb(): Database {
  evidenceDb ??= createDb(evidenceDatabaseUrl(process.env), { neonDev: LOCAL_NEON_DEV_CONFIG });
  return evidenceDb;
}

/** The provider this run's gate selects: Brave through the cassette, or the fake. */
function gatedProvider(captures: RecordedCapture[]): SearchProvider {
  const telemetry = recordingTelemetry(captures);
  if (GATE.useMock) {
    return resolveSearchProvider({
      useMock: true,
      apiKey: '',
      isCI: GATE.isCI,
      db: undefined,
      telemetry,
    });
  }
  return resolveSearchProvider({
    useMock: false,
    apiKey: requireEnv('BRAVE_SEARCH_API_KEY', process.env['BRAVE_SEARCH_API_KEY']),
    isCI: GATE.isCI,
    db: realEvidenceDb(),
    telemetry,
  });
}

interface BraveRecording {
  /**
   * The file exactly as the store wrote it, followed by each response body
   * decoded: the store keeps bodies as base64 chunks, which a scan of the raw
   * file cannot read.
   */
  readonly bytes: string;
  /** The request headers the recording kept. */
  readonly requestHeaders: readonly string[];
}

/** Every Brave recording stored under `root`, read back from disk. */
function braveRecordings(root: string = CASSETTE_ROOT): BraveRecording[] {
  const store = createCassetteStore({ rootDir: root });
  return store.list().flatMap((key) => {
    const cassette: Cassette | undefined = store.read(key);
    const file = path.join(root, AI_RECORDING_VERSION, `${key}${CASSETTE_FILE_SUFFIX}`);
    if (cassette?.request?.pathAndQuery.startsWith(BRAVE_SEARCH_PATH) !== true) return [];
    if (!existsSync(file)) return [];
    const bodies = cassette.exchanges.map((exchange) =>
      exchange.chunks.map((chunk) => Buffer.from(chunk, 'base64').toString('utf8')).join('')
    );
    return [
      {
        bytes: [readFileSync(file, 'utf8'), ...bodies].join('\n'),
        requestHeaders: Object.keys(cassette.request.headers).map((name) => name.toLowerCase()),
      },
    ];
  });
}

/** A stored Brave exchange whose response body carries `planted`, as a real recording would store it. */
function recordingCarrying(planted: string): Cassette {
  const body = JSON.stringify({
    type: 'search',
    web: { results: [{ title: planted, url: 'https://a.example/' }] },
  });
  return {
    version: 1,
    exchanges: [
      {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        chunks: [Buffer.from(body, 'utf8').toString('base64')],
      },
    ],
    recordedAt: isoAt(TEST_DAY_START),
    request: {
      method: 'GET',
      pathAndQuery: `${BRAVE_SEARCH_PATH}?q=planted`,
      headers: { accept: 'application/json' },
    },
  };
}

/** Brave's documented error envelope, as a synthetic exchange: live failures are never recorded. */
function braveErrorCassette(status: number): Cassette {
  const body = JSON.stringify({
    type: 'ErrorResponse',
    time: 0,
    error: { id: 'error-id', status, code: 'INTERNAL', detail: null, meta: null },
  });
  return {
    version: 1,
    exchanges: [
      {
        status,
        statusText: 'Error',
        headers: { 'content-type': 'application/json' },
        chunks: [Buffer.from(body, 'utf8').toString('base64')],
      },
    ],
    recordedAt: isoAt(TEST_DAY_START),
  };
}

/** A transport that never answers and rejects only when its request is aborted. */
function silentFetch(): typeof fetch {
  return (input, init): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      new Request(input, init).signal.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
}

describe('Brave web search through the cassette layer', () => {
  beforeAll(() => {
    beginCassetteScope();
  });

  beforeEach(() => {
    beginCassetteScope();
  });

  afterAll(async () => {
    endCassetteScope();
    await workerDb.$client.end();
    await evidenceDb?.$client.end();
  });

  it(
    'answers a fixed query with results the shared contract accepts',
    { timeout: REAL_SEARCH_TIMEOUT_MS },
    async () => {
      const captures: RecordedCapture[] = [];

      const results = await gatedProvider(captures).search(FIXED_QUERY, { signal: signal() });

      expect(WebSearchResults.safeParse(results).success).toBe(true);
      expect(captures).toEqual([]);
    }
  );

  it.skipIf(!SHOULD_RUN)(
    'writes a brave-search evidence row for a search through the cassette layer',
    { timeout: REAL_SEARCH_TIMEOUT_MS },
    async () => {
      const before = await countEvidence(realEvidenceDb());

      await gatedProvider([]).search(FIXED_QUERY, { signal: signal() });

      expect(await countEvidence(realEvidenceDb())).toBeGreaterThan(before);
    }
  );

  it.skipIf(!SHOULD_RUN)(
    'keeps the key out of the bytes of every recorded Brave exchange',
    { timeout: REAL_SEARCH_TIMEOUT_MS },
    async () => {
      const key = requireEnv('BRAVE_SEARCH_API_KEY', process.env['BRAVE_SEARCH_API_KEY']);
      await gatedProvider([]).search(FIXED_QUERY, { signal: signal() });

      const recordings = braveRecordings();
      expect(recordings.length).toBeGreaterThan(0);
      expect(recordings.filter((recording) => recording.bytes.includes(key))).toEqual([]);
    }
  );

  it('finds a key planted in a recorded Brave response body, so "keeps the key out of the bytes of every recorded Brave exchange" is evidence', () => {
    const planted = 'brave-planted-body-key';
    const root = mkdtempSync(path.join(tmpdir(), 'brave-cassette-'));
    try {
      createCassetteStore({ rootDir: root }).write('0000000000000000', recordingCarrying(planted));

      const carrying = braveRecordings(root).filter((recording) =>
        recording.bytes.includes(planted)
      );
      expect(carrying).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!SHOULD_RUN)(
    'keeps the key header out of the request every Brave recording kept',
    { timeout: REAL_SEARCH_TIMEOUT_MS },
    async () => {
      await gatedProvider([]).search(FIXED_QUERY, { signal: signal() });

      const recordings = braveRecordings();
      expect(recordings.length).toBeGreaterThan(0);
      expect(
        recordings.filter((recording) => recording.requestHeaders.includes('x-subscription-token'))
      ).toEqual([]);
    }
  );

  it('writes no evidence row on the fake path, even in CI', async () => {
    const before = await countEvidence(workerDb);

    await resolveSearchProvider({
      useMock: true,
      apiKey: '',
      isCI: GATE.isCI,
      db: workerDb,
      telemetry: recordingTelemetry([]),
    }).search(FIXED_QUERY, { signal: signal() });

    expect(await countEvidence(workerDb)).toBe(before);
  });

  it('throws, capturing search_provider_unavailable, when Brave answers a server error', async () => {
    const captures: RecordedCapture[] = [];
    const provider = createBraveSearchProvider({
      apiKey: 'integration-test-key',
      telemetry: recordingTelemetry(captures),
      fetch: createFixtureFetch(braveErrorCassette(500)),
    });

    await expect(provider.search(FIXED_QUERY, { signal: signal() })).rejects.toBeInstanceOf(
      BraveSearchError
    );
    expect(captures.map((capture) => capture.code)).toEqual(['search_provider_unavailable']);
  });

  it('throws, capturing search_provider_unavailable, when Brave does not answer in time', async () => {
    const captures: RecordedCapture[] = [];
    const provider = createBraveSearchProvider({
      apiKey: 'integration-test-key',
      telemetry: recordingTelemetry(captures),
      fetch: silentFetch(),
      timeoutMs: 50,
    });

    await expect(provider.search(FIXED_QUERY, { signal: signal() })).rejects.toBeInstanceOf(
      BraveSearchError
    );
    expect(captures.map((capture) => capture.code)).toEqual(['search_provider_unavailable']);
  });
});
