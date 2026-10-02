import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRAVE_SEARCH_API_KEY_PLACEHOLDER } from '@hushbox/shared';
import { resolveSearchProvider } from './resolve-search-provider.js';
import { createFakeSearchProvider } from './fake-search-provider.js';
import { createCassetteStore } from './cassette/cassette-store.js';
import type { BraveSearchProviderOptions } from './brave-search.js';
import type { CassetteStore } from './cassette/cassette-store.js';
import type { Database } from '@hushbox/db';
import type { WebSearchResults } from '@hushbox/shared';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { SearchProvider } from '../ports/index.js';

const QUERY = { query: 'tide tables' } as const;

function signal(): AbortSignal {
  return new AbortController().signal;
}

function silentTelemetry(): Telemetry {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    captureError: () => {},
  };
}

interface SpyingDb {
  readonly db: Database;
  readonly insert: ReturnType<typeof vi.fn>;
  readonly values: ReturnType<typeof vi.fn>;
}

/** A db whose `insert(...).values(...)` resolves; the spies count and read evidence writes. */
function spyingDb(): SpyingDb {
  const values = vi.fn(() => Promise.resolve());
  const insert = vi.fn(() => ({ values }));
  // The evidence write reaches only `insert().values()`; the rest of Database is unreachable here.
  return { db: { insert } as unknown as Database, insert, values };
}

const SHAPED: WebSearchResults = {
  results: [{ title: 'T', url: 'https://a.example/', snippet: 'S' }],
};

function answeringProvider(): SearchProvider {
  return { search: (): Promise<WebSearchResults> => Promise.resolve(SHAPED) };
}

function failingProvider(): SearchProvider {
  return { search: (): Promise<WebSearchResults> => Promise.reject(new Error('search failed')) };
}

/** Temporary cassette roots, outside the repository, removed after each test. */
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface FreshStore {
  readonly root: string;
  readonly store: CassetteStore;
}

function freshStore(): FreshStore {
  const root = mkdtempSync(path.join(tmpdir(), 'brave-cassette-'));
  roots.push(root);
  return { root, store: createCassetteStore({ rootDir: root }) };
}

/** An upstream answering one Brave-shaped result titled `title`, with any extra response headers given. */
function upstreamAnswering(headers: Record<string, string> = {}, title = 'T'): typeof fetch {
  return (): Promise<Response> =>
    Promise.resolve(
      Response.json(
        { web: { results: [{ title, url: 'https://a.example/' }] } },
        { status: 200, headers: { 'content-type': 'application/json', ...headers } }
      )
    );
}

interface BraveBuild {
  readonly calls: BraveSearchProviderOptions[];
  readonly createBrave: (options: BraveSearchProviderOptions) => SearchProvider;
}

function recordingBuild(provider: SearchProvider): BraveBuild {
  const calls: BraveSearchProviderOptions[] = [];
  return {
    calls,
    createBrave: (options): SearchProvider => {
      calls.push(options);
      return provider;
    },
  };
}

describe('resolveSearchProvider: the fake whenever the model provider is the mock', () => {
  const MOCK_INPUTS = [
    { label: 'outside CI', isCI: false, apiKey: '', withDb: false },
    { label: 'in CI', isCI: true, apiKey: '', withDb: true },
    { label: 'holding a real key', isCI: false, apiKey: 'real-key', withDb: true },
    {
      label: 'holding the placeholder key in CI',
      isCI: true,
      apiKey: BRAVE_SEARCH_API_KEY_PLACEHOLDER,
      withDb: false,
    },
  ] as const;

  it.each(MOCK_INPUTS)('answers with the fake results $label', async ({ isCI, apiKey, withDb }) => {
    const build = recordingBuild(answeringProvider());
    const provider = resolveSearchProvider(
      {
        useMock: true,
        apiKey,
        isCI,
        db: withDb ? spyingDb().db : undefined,
        telemetry: silentTelemetry(),
      },
      { createBrave: build.createBrave }
    );

    const fake = await createFakeSearchProvider().search(QUERY, { signal: signal() });
    expect(await provider.search(QUERY, { signal: signal() })).toEqual(fake);
  });

  it.each(MOCK_INPUTS)('never builds the Brave adapter $label', ({ isCI, apiKey, withDb }) => {
    const build = recordingBuild(answeringProvider());
    resolveSearchProvider(
      {
        useMock: true,
        apiKey,
        isCI,
        db: withDb ? spyingDb().db : undefined,
        telemetry: silentTelemetry(),
      },
      { createBrave: build.createBrave }
    );

    expect(build.calls).toEqual([]);
  });

  it('records no evidence on the fake path, even in CI', async () => {
    const { db, insert } = spyingDb();
    const provider = resolveSearchProvider({
      useMock: true,
      apiKey: 'real-key',
      isCI: true,
      db,
      telemetry: silentTelemetry(),
    });

    await provider.search(QUERY, { signal: signal() });

    expect(insert).not.toHaveBeenCalled();
  });
});

describe('resolveSearchProvider: production', () => {
  it('builds the Brave adapter over plain fetch with the key it was given', () => {
    const build = recordingBuild(answeringProvider());
    resolveSearchProvider(
      {
        useMock: false,
        apiKey: 'real-key',
        isCI: false,
        db: spyingDb().db,
        telemetry: silentTelemetry(),
      },
      { createBrave: build.createBrave }
    );

    expect(build.calls.map((options) => [options.apiKey, options.fetch])).toEqual([
      ['real-key', undefined],
    ]);
  });

  it('hands the telemetry it was given to the Brave adapter', () => {
    const telemetry = silentTelemetry();
    const build = recordingBuild(answeringProvider());
    resolveSearchProvider(
      { useMock: false, apiKey: 'real-key', isCI: false, db: spyingDb().db, telemetry },
      { createBrave: build.createBrave }
    );

    expect(build.calls.map((options) => options.telemetry === telemetry)).toEqual([true]);
  });

  it('records no evidence after a successful search', async () => {
    const { db, insert } = spyingDb();
    const build = recordingBuild(answeringProvider());
    const provider = resolveSearchProvider(
      { useMock: false, apiKey: 'real-key', isCI: false, db, telemetry: silentTelemetry() },
      { createBrave: build.createBrave }
    );

    await provider.search(QUERY, { signal: signal() });

    expect(insert).not.toHaveBeenCalled();
  });
});

describe('resolveSearchProvider: CI-vitest', () => {
  it('builds the Brave adapter over a fetch that records into the cassette store', async () => {
    const { store } = freshStore();
    const build = recordingBuild(answeringProvider());
    resolveSearchProvider(
      {
        useMock: false,
        apiKey: 'real-key',
        isCI: true,
        db: spyingDb().db,
        telemetry: silentTelemetry(),
      },
      { createBrave: build.createBrave, store, realFetch: upstreamAnswering() }
    );

    const [options] = build.calls;
    await options?.fetch?.('https://api.search.brave.com/res/v1/web/search?q=tide');

    expect(store.list()).toHaveLength(1);
  });

  it('hands the telemetry it was given to the Brave adapter', () => {
    const telemetry = silentTelemetry();
    const build = recordingBuild(answeringProvider());
    resolveSearchProvider(
      { useMock: false, apiKey: 'real-key', isCI: true, db: spyingDb().db, telemetry },
      { createBrave: build.createBrave, store: freshStore().store }
    );

    expect(build.calls.map((options) => options.telemetry === telemetry)).toEqual([true]);
  });

  it('records one brave-search evidence row after a successful search', async () => {
    const { db, values } = spyingDb();
    const build = recordingBuild(answeringProvider());
    const provider = resolveSearchProvider(
      { useMock: false, apiKey: 'real-key', isCI: true, db, telemetry: silentTelemetry() },
      { createBrave: build.createBrave, store: freshStore().store }
    );

    await provider.search(QUERY, { signal: signal() });

    expect(values.mock.calls).toEqual([[{ service: 'brave-search', details: null }]]);
  });

  it('records no evidence when the search throws', async () => {
    const { db, insert } = spyingDb();
    const build = recordingBuild(failingProvider());
    // The default store stays untouched: the injected Brave factory never fetches.
    const provider = resolveSearchProvider(
      { useMock: false, apiKey: 'real-key', isCI: true, db, telemetry: silentTelemetry() },
      { createBrave: build.createBrave }
    );

    await expect(provider.search(QUERY, { signal: signal() })).rejects.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('resolveSearchProvider: fail fast', () => {
  it('refuses an empty key on the production path', () => {
    expect(() =>
      resolveSearchProvider({
        useMock: false,
        apiKey: '',
        isCI: false,
        db: undefined,
        telemetry: silentTelemetry(),
      })
    ).toThrow(/BRAVE_SEARCH_API_KEY/);
  });

  it('refuses an empty key on the CI path', () => {
    expect(() =>
      resolveSearchProvider({
        useMock: false,
        apiKey: '',
        isCI: true,
        db: spyingDb().db,
        telemetry: silentTelemetry(),
      })
    ).toThrow(/BRAVE_SEARCH_API_KEY/);
  });

  it('refuses the local placeholder key on the CI path', () => {
    expect(() =>
      resolveSearchProvider({
        useMock: false,
        apiKey: BRAVE_SEARCH_API_KEY_PLACEHOLDER,
        isCI: true,
        db: spyingDb().db,
        telemetry: silentTelemetry(),
      })
    ).toThrow(/placeholder/);
  });

  it('refuses the CI path without a db for the evidence row', () => {
    expect(() =>
      resolveSearchProvider({
        useMock: false,
        apiKey: 'real-key',
        isCI: true,
        db: undefined,
        telemetry: silentTelemetry(),
      })
    ).toThrow(/db/);
  });
});

describe('resolveSearchProvider: the key never reaches a recorded cassette', () => {
  const KEY = 'brave-cassette-bytes-key';

  /**
   * Every byte under `root` as the store wrote it, followed by each recorded
   * body decoded: the store keeps bodies as base64 chunks, which a scan of the
   * raw file cannot read.
   */
  function recordedBytes(root: string, store: CassetteStore): string {
    const texts: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) walk(full);
        else texts.push(readFileSync(full, 'utf8'));
      }
    };
    walk(root);
    for (const key of store.list()) {
      for (const exchange of store.read(key)?.exchanges ?? []) {
        texts.push(
          exchange.chunks.map((chunk) => Buffer.from(chunk, 'base64').toString('utf8')).join('')
        );
      }
    }
    return texts.join('\n');
  }

  /** Leaked text in `bytes`: the key itself, or its header's name in any case. */
  function leaks(bytes: string): string[] {
    const found: string[] = [];
    if (bytes.includes(KEY)) found.push('the key');
    if (bytes.toLowerCase().includes('x-subscription-token')) found.push('the key header');
    return found;
  }

  /** Records one real Brave-adapter search through the CI path into a fresh store under the temp dir. */
  async function recordOneSearch(upstream: typeof fetch): Promise<string> {
    const { root, store } = freshStore();
    const provider = resolveSearchProvider(
      { useMock: false, apiKey: KEY, isCI: true, db: spyingDb().db, telemetry: silentTelemetry() },
      { store, realFetch: upstream }
    );

    await provider.search(QUERY, { signal: signal() });

    expect(store.list()).toHaveLength(1);
    return recordedBytes(root, store);
  }

  it('records the exchange with neither the key nor its header in the bytes', async () => {
    const bytes = await recordOneSearch(upstreamAnswering());

    expect(leaks(bytes)).toEqual([]);
  });

  it('finds the key when a recorded response header carries it, so its silence is evidence', async () => {
    const bytes = await recordOneSearch(upstreamAnswering({ 'x-subscription-token': KEY }));

    expect(leaks(bytes)).toEqual(['the key', 'the key header']);
  });

  it('finds the key when a recorded response body carries it, so its silence is evidence', async () => {
    const bytes = await recordOneSearch(upstreamAnswering({}, KEY));

    expect(leaks(bytes)).toEqual(['the key']);
  });
});
