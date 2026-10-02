import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_RECORDING_VERSION, CASSETTE_OBJECT_PREFIX } from '@hushbox/shared/cassettes';

import {
  CASSETTE_STORE_VARIABLES,
  createCassetteStoreClient,
  downloadCassettes,
  listLocalCassetteFiles,
  objectKeyForRelativePath,
  parseListObjectsPage,
  readCassetteStoreConfig,
  relativePathForObjectKey,
  runCassetteSync,
  uploadCassettes,
  type CassetteStoreConfig,
} from './cassette-store.js';
import { StagedWriteFailed } from '../staged-write.js';

const CONFIG: CassetteStoreConfig = {
  endpoint: 'https://account.r2.cloudflarestorage.com',
  bucket: 'bucket-name',
  accessKeyId: 'access-key',
  secretAccessKey: 'secret-key',
};

const temporaryRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cassette-store-'));
  temporaryRoots.push(root);
  return root;
}

function writeCassette(root: string, relativePath: string, body: string): void {
  const file = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop() ?? '', { recursive: true, force: true });
  }
});

describe('readCassetteStoreConfig', () => {
  it('returns undefined when none of the store variables are set', () => {
    expect(readCassetteStoreConfig({})).toBeUndefined();
  });

  it('treats an empty-string variable as unset', () => {
    const env = Object.fromEntries(CASSETTE_STORE_VARIABLES.map((name) => [name, '']));

    expect(readCassetteStoreConfig(env)).toBeUndefined();
  });

  it('derives the R2 endpoint from the account id', () => {
    const config = readCassetteStoreConfig({
      CASSETTE_R2_ACCOUNT_ID: 'acct',
      CASSETTE_R2_ACCESS_KEY_ID: 'ak',
      CASSETTE_R2_SECRET_ACCESS_KEY: 'sk',
      CASSETTE_R2_BUCKET: 'bkt',
    });

    expect(config).toEqual({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      bucket: 'bkt',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
    });
  });

  it('names every missing variable when the store is only partly configured', () => {
    expect(() => readCassetteStoreConfig({ CASSETTE_R2_ACCOUNT_ID: 'acct' })).toThrow(
      /CASSETTE_R2_ACCESS_KEY_ID, CASSETTE_R2_SECRET_ACCESS_KEY, CASSETTE_R2_BUCKET/
    );
  });
});

describe('object key mapping', () => {
  it('maps a versioned cassette path under the shared object prefix', () => {
    expect(objectKeyForRelativePath('v2/abc123.json')).toBe(
      `${CASSETTE_OBJECT_PREFIX}v2/abc123.json`
    );
  });

  it('converts native path separators to the object separator', () => {
    expect(objectKeyForRelativePath(path.join('v2', 'abc123.json'))).toBe(
      `${CASSETTE_OBJECT_PREFIX}v2/abc123.json`
    );
  });

  it('round-trips an object key back to its relative path', () => {
    expect(relativePathForObjectKey(`${CASSETTE_OBJECT_PREFIX}v2/abc123.json`)).toBe(
      'v2/abc123.json'
    );
  });

  it('rejects an object key outside the cassette prefix', () => {
    expect(relativePathForObjectKey('other/v2/abc123.json')).toBeUndefined();
  });

  it('rejects an object key that would escape the cassette directory', () => {
    expect(relativePathForObjectKey(`${CASSETTE_OBJECT_PREFIX}../secrets.json`)).toBeUndefined();
  });

  it('rejects an object key that would escape only once Windows resolves it', () => {
    expect(
      relativePathForObjectKey(String.raw`${CASSETTE_OBJECT_PREFIX}v2/..\..\evil.json`)
    ).toBeUndefined();
  });

  it('rejects an object key carrying a Windows path separator at all', () => {
    expect(
      relativePathForObjectKey(String.raw`${CASSETTE_OBJECT_PREFIX}v2\nested.json`)
    ).toBeUndefined();
  });

  it('rejects an object key that is not a cassette file', () => {
    expect(relativePathForObjectKey(`${CASSETTE_OBJECT_PREFIX}v2/notes.txt`)).toBeUndefined();
  });
});

describe('listLocalCassetteFiles', () => {
  it('returns an empty list when the cassette directory does not exist', () => {
    expect(listLocalCassetteFiles(path.join(makeRoot(), 'absent'))).toEqual([]);
  });

  it('finds cassette files nested under their version directory', () => {
    const root = makeRoot();
    writeCassette(root, 'v2/aaa.json', '{}');
    writeCassette(root, 'v3/bbb.json', '{}');

    expect(listLocalCassetteFiles(root).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'v2/aaa.json',
      'v3/bbb.json',
    ]);
  });

  it('ignores partial writes left behind by a crashed recording', () => {
    const root = makeRoot();
    writeCassette(root, 'v2/aaa.json', '{}');
    writeCassette(root, 'v2/aaa.json.0e1a7c64-3b6f-4a12-9d5e-7c8f2b41a903.tmp', '{}');

    expect(listLocalCassetteFiles(root)).toEqual(['v2/aaa.json']);
  });
});

describe('parseListObjectsPage', () => {
  it('reads every key out of a list response', () => {
    const page = parseListObjectsPage(
      '<ListBucketResult><Contents><Key>cassettes/v2/a.json</Key></Contents>' +
        '<Contents><Key>cassettes/v2/b.json</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>'
    );

    expect(page).toEqual({ keys: ['cassettes/v2/a.json', 'cassettes/v2/b.json'] });
  });

  it('carries the continuation token when the page is truncated', () => {
    const page = parseListObjectsPage(
      '<ListBucketResult><Contents><Key>cassettes/v2/a.json</Key></Contents>' +
        '<IsTruncated>true</IsTruncated><NextContinuationToken>tok/en+1</NextContinuationToken></ListBucketResult>'
    );

    expect(page.nextToken).toBe('tok/en+1');
  });

  it('decodes XML entities in a key', () => {
    const page = parseListObjectsPage(
      '<ListBucketResult><Contents><Key>cassettes/v2/a&amp;b.json</Key></Contents></ListBucketResult>'
    );

    expect(page.keys).toEqual(['cassettes/v2/a&b.json']);
  });
});

interface StubCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

function stubFetch(handler: (call: StubCall) => Response): {
  fetch: typeof globalThis.fetch;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const fetchStub = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const call: StubCall = {
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return Promise.resolve(handler(call));
  });
  return { fetch: fetchStub as unknown as typeof globalThis.fetch, calls };
}

/** The `SignedHeaders=` list out of a recorded call's authorization header. */
function signedHeadersOf(call: StubCall | undefined): string {
  return (/SignedHeaders=([^,]*)/.exec(call?.headers['authorization'] ?? '') ?? [])[1] ?? '';
}

function listResponse(keys: readonly string[]): Response {
  const contents = keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join('');
  return new Response(
    `<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`,
    {
      status: 200,
    }
  );
}

describe('createCassetteStoreClient', () => {
  it('follows continuation tokens until the listing is complete', async () => {
    const { fetch, calls } = stubFetch((call) =>
      call.url.includes('continuation-token')
        ? listResponse(['cassettes/v2/b.json'])
        : new Response(
            '<ListBucketResult><Contents><Key>cassettes/v2/a.json</Key></Contents>' +
              '<IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken></ListBucketResult>',
            { status: 200 }
          )
    );
    const client = createCassetteStoreClient({ config: CONFIG, fetch });

    await expect(client.listKeys(CASSETTE_OBJECT_PREFIX)).resolves.toEqual([
      'cassettes/v2/a.json',
      'cassettes/v2/b.json',
    ]);
    expect(calls).toHaveLength(2);
  });

  it('throws a status-bearing error when listing fails', async () => {
    const { fetch } = stubFetch(() => new Response('nope', { status: 503 }));
    const client = createCassetteStoreClient({ config: CONFIG, fetch });

    await expect(client.listKeys(CASSETTE_OBJECT_PREFIX)).rejects.toThrow(/503/);
  });

  it('returns the object bytes on get', async () => {
    const { fetch } = stubFetch(() => new Response('{"a":1}', { status: 200 }));
    const client = createCassetteStoreClient({ config: CONFIG, fetch });

    const bytes = await client.get('cassettes/v2/a.json');

    expect(new TextDecoder().decode(bytes)).toBe('{"a":1}');
  });

  it('throws when a get fails', async () => {
    const { fetch } = stubFetch(() => new Response('', { status: 404 }));
    const client = createCassetteStoreClient({ config: CONFIG, fetch });

    await expect(client.get('cassettes/v2/a.json')).rejects.toThrow(/404/);
  });

  it('sends the never-overwrite precondition on put', async () => {
    const { fetch, calls } = stubFetch(() => new Response('', { status: 200 }));
    const client = createCassetteStoreClient({ config: CONFIG, fetch });

    await expect(
      client.putIfAbsent('cassettes/v2/a.json', new TextEncoder().encode('{}'))
    ).resolves.toBe(true);
    expect(calls[0]?.headers['if-none-match']).toBe('*');
  });

  it('covers the never-overwrite precondition with the signature', async () => {
    const { fetch, calls } = stubFetch(() => new Response('', { status: 200 }));
    const client = createCassetteStoreClient({ config: CONFIG, fetch });

    await client.putIfAbsent('cassettes/v2/a.json', new TextEncoder().encode('{}'));

    expect(signedHeadersOf(calls[0])).toContain('if-none-match');
  });

  it('binds the body to the signature through the payload digest', async () => {
    const { fetch, calls } = stubFetch(() => new Response('', { status: 200 }));
    const client = createCassetteStoreClient({ config: CONFIG, fetch });

    await client.putIfAbsent('cassettes/v2/a.json', new TextEncoder().encode('{}'));

    expect(calls[0]?.headers['x-amz-content-sha256']).toBe(
      createHash('sha256').update('{}').digest('hex')
    );
  });

  it('addresses an object at its path-style URL under the bucket', async () => {
    const { fetch, calls } = stubFetch(() => new Response('{}', { status: 200 }));
    const client = createCassetteStoreClient({ config: CONFIG, fetch });

    await client.get('cassettes/v2/a.json');

    expect(calls[0]?.url).toBe(
      'https://account.r2.cloudflarestorage.com/bucket-name/cassettes/v2/a.json'
    );
  });

  it('reports an existing object rather than replacing it', async () => {
    const { fetch } = stubFetch(() => new Response('', { status: 412 }));
    const client = createCassetteStoreClient({ config: CONFIG, fetch });

    await expect(
      client.putIfAbsent('cassettes/v2/a.json', new TextEncoder().encode('{}'))
    ).resolves.toBe(false);
  });

  /**
   * The object store closes a keep-alive connection after answering a
   * conditional PUT with 412, and does not say so in the response, so the next
   * request can be dispatched onto a socket the peer has already closed.
   */
  function closedConnection(): TypeError {
    const cause = new Error('other side closed');
    return new TypeError('fetch failed', {
      cause: Object.assign(cause, { code: 'UND_ERR_SOCKET' }),
    });
  }

  /** A fetch whose first `failures` calls reject, and which then answers 200. */
  function failingFetch(rejections: readonly Error[]): {
    fetch: typeof globalThis.fetch;
    attempts: () => number;
  } {
    let attempts = 0;
    const stub = vi.fn(() => {
      const rejection = rejections[attempts];
      attempts += 1;
      return rejection === undefined
        ? Promise.resolve(new Response('{"a":1}', { status: 200 }))
        : Promise.reject(rejection);
    });
    return { fetch: stub as unknown as typeof globalThis.fetch, attempts: () => attempts };
  }

  it('resends a request the peer closed the connection under', async () => {
    const { fetch, attempts } = failingFetch([closedConnection()]);
    const client = createCassetteStoreClient({ config: CONFIG, fetch });

    const bytes = await client.get('cassettes/v2/a.json');

    expect(new TextDecoder().decode(bytes)).toBe('{"a":1}');
    expect(attempts()).toBe(2);
  });

  it('surfaces a closed connection that outlives the resend', async () => {
    const { fetch, attempts } = failingFetch([closedConnection(), closedConnection()]);
    const client = createCassetteStoreClient({ config: CONFIG, fetch });

    await expect(client.get('cassettes/v2/a.json')).rejects.toThrow(/fetch failed/);
    expect(attempts()).toBe(2);
  });

  it('does not resend a request the transport never got out', async () => {
    const unresolvable = new TypeError('fetch failed', {
      cause: new Error('getaddrinfo ENOTFOUND host'),
    });
    const { fetch, attempts } = failingFetch([unresolvable]);
    const client = createCassetteStoreClient({ config: CONFIG, fetch });

    await expect(client.get('cassettes/v2/a.json')).rejects.toThrow(/fetch failed/);
    expect(attempts()).toBe(1);
  });

  it('throws when a put fails for any reason other than the precondition', async () => {
    const { fetch } = stubFetch(() => new Response('', { status: 500 }));
    const client = createCassetteStoreClient({ config: CONFIG, fetch });

    await expect(
      client.putIfAbsent('cassettes/v2/a.json', new TextEncoder().encode('{}'))
    ).rejects.toThrow(/500/);
  });
});

describe('downloadCassettes', () => {
  it('writes every remote cassette into the local directory', async () => {
    const root = makeRoot();
    const client = {
      listKeys: () => Promise.resolve(['cassettes/v2/a.json', 'cassettes/v2/b.json']),
      get: (key: string) => Promise.resolve(new TextEncoder().encode(`{"key":"${key}"}`)),
      putIfAbsent: () => Promise.resolve(true),
    };

    await expect(downloadCassettes(client, root)).resolves.toEqual({
      downloaded: 2,
      alreadyLocal: 0,
    });
    expect(readFileSync(path.join(root, 'v2', 'a.json'), 'utf8')).toBe(
      '{"key":"cassettes/v2/a.json"}'
    );
  });

  it('leaves a cassette already present on disk untouched', async () => {
    const root = makeRoot();
    writeCassette(root, 'v2/a.json', '{"local":true}');
    const client = {
      listKeys: () => Promise.resolve(['cassettes/v2/a.json']),
      get: () => Promise.reject(new Error('must not fetch an existing cassette')),
      putIfAbsent: () => Promise.resolve(true),
    };

    await expect(downloadCassettes(client, root)).resolves.toEqual({
      downloaded: 0,
      alreadyLocal: 1,
    });
    expect(readFileSync(path.join(root, 'v2', 'a.json'), 'utf8')).toBe('{"local":true}');
  });

  it('restores only the recording generation the harness reads', async () => {
    const root = makeRoot();
    const stored = [
      `${CASSETTE_OBJECT_PREFIX}v1/retired.json`,
      `${CASSETTE_OBJECT_PREFIX}${AI_RECORDING_VERSION}/current.json`,
    ];
    const client = {
      listKeys: (prefix: string) => Promise.resolve(stored.filter((key) => key.startsWith(prefix))),
      get: (key: string) => Promise.resolve(new TextEncoder().encode(`{"key":"${key}"}`)),
      putIfAbsent: () => Promise.resolve(true),
    };

    await expect(downloadCassettes(client, root)).resolves.toEqual({
      downloaded: 1,
      alreadyLocal: 0,
    });
    expect(existsSync(path.join(root, 'v1', 'retired.json'))).toBe(false);
  });

  it('names the cassette it could not land when a restore cannot write', async () => {
    const root = makeRoot();
    // A file where the generation's directory would go, so the restore cannot
    // create the tree it needs and cannot clear its staging file either.
    writeFileSync(path.join(root, AI_RECORDING_VERSION), 'not a directory');
    const client = {
      listKeys: () => Promise.resolve([`${CASSETTE_OBJECT_PREFIX}${AI_RECORDING_VERSION}/a.json`]),
      get: () => Promise.resolve(new TextEncoder().encode('{}')),
      putIfAbsent: () => Promise.resolve(true),
    };

    await expect(downloadCassettes(client, root)).rejects.toBeInstanceOf(StagedWriteFailed);
  });

  it('skips a remote key that does not name a cassette file', async () => {
    const root = makeRoot();
    const client = {
      listKeys: () => Promise.resolve(['cassettes/../escape.json', 'other/thing.json']),
      get: () => Promise.reject(new Error('must not fetch a rejected key')),
      putIfAbsent: () => Promise.resolve(true),
    };

    await expect(downloadCassettes(client, root)).resolves.toEqual({
      downloaded: 0,
      alreadyLocal: 0,
    });
  });
});

describe('uploadCassettes', () => {
  it('uploads only the cassettes the store does not already hold', async () => {
    const root = makeRoot();
    writeCassette(root, 'v2/a.json', '{"a":1}');
    writeCassette(root, 'v2/b.json', '{"b":2}');
    const put: string[] = [];
    const client = {
      listKeys: () => Promise.resolve(['cassettes/v2/a.json']),
      get: () => Promise.reject(new Error('unused')),
      putIfAbsent: (key: string) => {
        put.push(key);
        return Promise.resolve(true);
      },
    };

    await expect(uploadCassettes(client, root)).resolves.toEqual({
      uploaded: 1,
      alreadyPresent: 1,
    });
    expect(put).toEqual(['cassettes/v2/b.json']);
  });

  it('counts a concurrent writer that won the race as already present', async () => {
    const root = makeRoot();
    writeCassette(root, 'v2/a.json', '{"a":1}');
    const client = {
      listKeys: () => Promise.resolve([]),
      get: () => Promise.reject(new Error('unused')),
      putIfAbsent: () => Promise.resolve(false),
    };

    await expect(uploadCassettes(client, root)).resolves.toEqual({
      uploaded: 0,
      alreadyPresent: 1,
    });
  });

  it('uploads nothing when there are no local cassettes', async () => {
    const client = {
      listKeys: () => Promise.resolve([]),
      get: () => Promise.reject(new Error('unused')),
      putIfAbsent: () => Promise.reject(new Error('must not put')),
    };

    await expect(uploadCassettes(client, makeRoot())).resolves.toEqual({
      uploaded: 0,
      alreadyPresent: 0,
    });
  });
});

describe('runCassetteSync', () => {
  const CONFIGURED_ENV = {
    CASSETTE_R2_ACCOUNT_ID: 'acct',
    CASSETTE_R2_ACCESS_KEY_ID: 'ak',
    CASSETTE_R2_SECRET_ACCESS_KEY: 'sk',
    CASSETTE_R2_BUCKET: 'bkt',
  };

  it('skips with a loud line and succeeds when the store is not configured', async () => {
    const lines: string[] = [];
    const { fetch } = stubFetch(() => new Response('', { status: 500 }));

    await expect(
      runCassetteSync('download', {
        env: {},
        rootDir: makeRoot(),
        fetch,
        log: (line) => lines.push(line),
      })
    ).resolves.toBe(0);
    expect(lines.join('\n')).toContain('not configured');
    expect(lines.join('\n')).toContain('cold cache');
  });

  it('degrades to a cold cache with a loud line when the store is unreachable', async () => {
    const lines: string[] = [];
    const fetchStub = vi.fn(() =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND'))
    ) as unknown as typeof globalThis.fetch;

    await expect(
      runCassetteSync('download', {
        env: CONFIGURED_ENV,
        rootDir: makeRoot(),
        fetch: fetchStub,
        log: (line) => lines.push(line),
      })
    ).resolves.toBe(0);
    expect(lines.join('\n')).toContain('UNREACHABLE');
    expect(lines.join('\n')).toContain('cold cache');
  });

  it('never fails the job when an upload cannot reach the store', async () => {
    const lines: string[] = [];
    const root = makeRoot();
    writeCassette(root, 'v2/a.json', '{}');
    const { fetch } = stubFetch(() => new Response('', { status: 503 }));

    await expect(
      runCassetteSync('upload', {
        env: CONFIGURED_ENV,
        rootDir: root,
        fetch,
        log: (line) => lines.push(line),
      })
    ).resolves.toBe(0);
    expect(lines.join('\n')).toContain('UNREACHABLE');
  });

  it('fails fast when the store is only partly configured', async () => {
    const lines: string[] = [];
    const { fetch } = stubFetch(() => new Response('', { status: 200 }));

    await expect(
      runCassetteSync('download', {
        env: { CASSETTE_R2_BUCKET: 'bkt' },
        rootDir: makeRoot(),
        fetch,
        log: (line) => lines.push(line),
      })
    ).resolves.toBe(1);
    expect(lines.join('\n')).toContain('CASSETTE_R2_ACCOUNT_ID');
  });

  it('reports what a successful download restored', async () => {
    const lines: string[] = [];
    const { fetch } = stubFetch((call) =>
      call.url.includes('list-type')
        ? listResponse(['cassettes/v2/a.json'])
        : new Response('{"a":1}', { status: 200 })
    );

    await expect(
      runCassetteSync('download', {
        env: CONFIGURED_ENV,
        rootDir: makeRoot(),
        fetch,
        log: (line) => lines.push(line),
      })
    ).resolves.toBe(0);
    expect(lines.join('\n')).toContain('restored 1');
  });

  it('reports what a successful upload stored', async () => {
    const lines: string[] = [];
    const root = makeRoot();
    writeCassette(root, 'v2/a.json', '{}');
    const { fetch } = stubFetch((call) =>
      call.url.includes('list-type') ? listResponse([]) : new Response('', { status: 200 })
    );

    await expect(
      runCassetteSync('upload', {
        env: CONFIGURED_ENV,
        rootDir: root,
        fetch,
        log: (line) => lines.push(line),
      })
    ).resolves.toBe(0);
    expect(lines.join('\n')).toContain('stored 1');
  });

  it('rejects an unknown command', async () => {
    const lines: string[] = [];
    const { fetch } = stubFetch(() => new Response('', { status: 200 }));

    await expect(
      runCassetteSync('sideload', {
        env: CONFIGURED_ENV,
        rootDir: makeRoot(),
        fetch,
        log: (line) => lines.push(line),
      })
    ).resolves.toBe(1);
    expect(lines.join('\n')).toContain('sideload');
  });
});
