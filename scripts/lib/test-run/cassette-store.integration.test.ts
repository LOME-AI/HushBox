/**
 * The cassette store against a real S3 API — the local MinIO the repo already
 * runs as R2 parity infrastructure. The properties under test (a conditional
 * write that refuses to overwrite, listing, byte-exact round trips) are server
 * behaviours, so a stubbed transport cannot prove them.
 *
 * Each test gets its own bucket. A restore is the union of everything the
 * store holds of the current recording generation, so a bucket shared across
 * tests would make every count depend on execution order — and an assertion
 * that has to be loosened to survive that ordering is an assertion that no
 * longer discriminates.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AwsClient } from 'aws4fetch';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI_RECORDING_VERSION, CASSETTE_OBJECT_PREFIX } from '@hushbox/shared/cassettes';

import {
  createCassetteStoreClient,
  downloadCassettes,
  objectKeyForRelativePath,
  runCassetteSync,
  uploadCassettes,
  type CassetteStoreClient,
  type CassetteStoreConfig,
} from './cassette-store.js';
import type { Socket } from 'node:net';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the cassette-store integration test`);
  }
  return value;
}

const BASE = {
  endpoint: requireEnv('R2_S3_ENDPOINT').replace(/\/+$/, ''),
  accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
};

let config: CassetteStoreConfig;
let client: CassetteStoreClient;
const roots: string[] = [];

const scratchAws = new AwsClient({
  accessKeyId: BASE.accessKeyId,
  secretAccessKey: BASE.secretAccessKey,
  service: 's3',
  region: 'auto',
});

/** Bucket lifecycle for the scratch bucket — outside the store's own surface. */
async function send(method: string, key?: string): Promise<Response> {
  const url =
    `${config.endpoint}/${encodeURIComponent(config.bucket)}` +
    (key === undefined
      ? ''
      : `/${key
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/')}`);
  return scratchAws.fetch(url, { method });
}

function assertOk(response: Response, operation: string): void {
  if (!response.ok && response.status !== 204) {
    throw new Error(`scratch bucket ${operation} returned ${String(response.status)}`);
  }
}

function makeRoot(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cassette-store-live-'));
  roots.push(root);
  for (const [relativePath, body] of Object.entries(files)) {
    const file = path.join(root, ...relativePath.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  return root;
}

beforeEach(async () => {
  config = { ...BASE, bucket: `hushbox-cassette-store-${crypto.randomUUID()}` };
  client = createCassetteStoreClient({ config, fetch: globalThis.fetch });
  assertOk(await send('PUT'), 'create');
});

afterEach(async () => {
  for (const key of await client.listKeys(CASSETTE_OBJECT_PREFIX)) {
    assertOk(await send('DELETE', key), 'object delete');
  }
  assertOk(await send('DELETE'), 'delete');
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

describe('cassette store against a live object store', () => {
  it('round-trips a recording into a clean workspace byte for byte', async () => {
    const recorded = '{"version":1,"exchanges":[],"recordedAt":"day"}';

    await expect(
      uploadCassettes(client, makeRoot({ [`${AI_RECORDING_VERSION}/roundtrip.json`]: recorded }))
    ).resolves.toEqual({ uploaded: 1, alreadyPresent: 0 });

    const restored = makeRoot();
    await expect(downloadCassettes(client, restored)).resolves.toEqual({
      downloaded: 1,
      alreadyLocal: 0,
    });
    expect(readFileSync(path.join(restored, AI_RECORDING_VERSION, 'roundtrip.json'), 'utf8')).toBe(
      recorded
    );
  });

  it('leaves a retired generation in the store rather than restoring it', async () => {
    await uploadCassettes(
      client,
      makeRoot({
        'v1/retired.json': '{"retired":true}',
        [`${AI_RECORDING_VERSION}/current.json`]: '{"current":true}',
      })
    );

    const restored = makeRoot();
    await expect(downloadCassettes(client, restored)).resolves.toEqual({
      downloaded: 1,
      alreadyLocal: 0,
    });
    expect(readdirSync(restored)).toEqual([AI_RECORDING_VERSION]);
    // The retired object really is in the bucket, so not restoring it is a
    // result rather than an upload that never happened.
    expect(await client.listKeys(CASSETTE_OBJECT_PREFIX)).toContain(
      `${CASSETTE_OBJECT_PREFIX}v1/retired.json`
    );
  });

  it('refuses a write to a key the store already holds', async () => {
    const key = objectKeyForRelativePath('v9/precondition.json');
    await expect(
      client.putIfAbsent(key, new TextEncoder().encode('{"take":"first"}'))
    ).resolves.toBe(true);

    await expect(
      client.putIfAbsent(key, new TextEncoder().encode('{"take":"second"}'))
    ).resolves.toBe(false);
    expect(new TextDecoder().decode(await client.get(key))).toBe('{"take":"first"}');
  });

  it('does not re-upload a recording another run already stored', async () => {
    await uploadCassettes(client, makeRoot({ 'v9/once.json': '{"take":"first"}' }));

    await expect(
      uploadCassettes(client, makeRoot({ 'v9/once.json': '{"take":"second"}' }))
    ).resolves.toEqual({ uploaded: 0, alreadyPresent: 1 });
    expect(
      new TextDecoder().decode(await client.get(objectKeyForRelativePath('v9/once.json')))
    ).toBe('{"take":"first"}');
  });

  it('serves the union of what every run recorded, not the newest run', async () => {
    const version = AI_RECORDING_VERSION;
    await uploadCassettes(client, makeRoot({ [`${version}/from-run-a.json`]: '{"a":1}' }));
    await uploadCassettes(client, makeRoot({ [`${version}/from-run-b.json`]: '{"b":2}' }));

    const restored = makeRoot();
    await expect(downloadCassettes(client, restored)).resolves.toEqual({
      downloaded: 2,
      alreadyLocal: 0,
    });
    expect(readFileSync(path.join(restored, version, 'from-run-a.json'), 'utf8')).toBe('{"a":1}');
    expect(readFileSync(path.join(restored, version, 'from-run-b.json'), 'utf8')).toBe('{"b":2}');
  });

  it('records nothing a second time once a run has restored the store', async () => {
    await uploadCassettes(
      client,
      makeRoot({ [`${AI_RECORDING_VERSION}/settled.json`]: '{"s":1}' })
    );

    const runner = makeRoot();
    await expect(downloadCassettes(client, runner)).resolves.toEqual({
      downloaded: 1,
      alreadyLocal: 0,
    });

    // Both halves discriminate: `uploaded: 0` alone would also hold if the
    // restore had been a no-op and there were no local cassettes to store.
    await expect(uploadCassettes(client, runner)).resolves.toEqual({
      uploaded: 0,
      alreadyPresent: 1,
    });
  });

  it('lists every object stored under the cassette prefix', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `v8/page-${String(index).padStart(2, '0')}.json`,
        `{"i":${String(index)}}`,
      ])
    );
    await uploadCassettes(client, makeRoot(many));

    await expect(client.listKeys(CASSETTE_OBJECT_PREFIX)).resolves.toHaveLength(12);
  });
});

/**
 * Recovery from the way the local object store ends a conditional write.
 *
 * Measured against it: it answers a second `If-None-Match: *` PUT with 412 and
 * then closes the keep-alive connection, sending no `Connection: close` on the
 * 412. The pool therefore keeps the socket and the next request races the close
 * notice — under load on the store the request goes out first and dies, at a
 * measured 28–38% of runs. The server below takes that losing side by
 * construction, holding the close until the next request has been written, so
 * the recovery is pinned on every run rather than at the real store's rate. The
 * cost of modelling the peer: nothing here is evidence about the real service,
 * whose close pattern this fixture only mirrors.
 */
describe('a peer that closes a pooled connection after answering', () => {
  const STORED = '{"take":"first"}';
  const OVERWRITE = '{"take":"second"}';
  let server: Server;
  let closingClient: CassetteStoreClient;
  /** Set by a test to lose the response of the next write, after it is applied. */
  let losePutResponse = false;

  beforeEach(async () => {
    const stored = new Map<string, string>();
    const doomed = new WeakSet<Socket>();
    losePutResponse = false;

    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (doomed.has(request.socket)) {
          request.socket.destroy();
          return;
        }
        const key = request.url ?? '';
        if (request.method !== 'PUT') {
          // A read of a key this peer never stored is a not-found, never the
          // bytes a test expects: the read-back is the only evidence a write's
          // bytes reached the store, so a fallback would make "stored the first
          // writer's bytes" and "stored nothing" the same green.
          const body = stored.get(key);
          if (body === undefined) {
            response.writeHead(404).end();
            return;
          }
          response.writeHead(200).end(body);
          return;
        }
        // The precondition is honoured per request, not assumed from the key's
        // state: a write that arrives without `If-None-Match` overwrites, which
        // is what makes a resend that loses the header observable here. It is
        // applied before the response is lost, so a lost response leaves the
        // store's view and the peer's view disagreeing — the state a resend has
        // to be safe in.
        const conditional = request.headers['if-none-match'] === '*';
        const refused = conditional && stored.has(key);
        if (!refused) stored.set(key, Buffer.concat(chunks).toString('utf8'));
        if (losePutResponse) {
          losePutResponse = false;
          request.socket.destroy();
          return;
        }
        if (refused) {
          doomed.add(request.socket);
          response.writeHead(412).end();
          return;
        }
        response.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    closingClient = createCassetteStoreClient({
      config: { ...BASE, endpoint: `http://127.0.0.1:${String(port)}`, bucket: 'closing' },
      fetch: globalThis.fetch,
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it('serves the object the peer closed the connection under', async () => {
    const key = objectKeyForRelativePath(`${AI_RECORDING_VERSION}/closed.json`);
    const body = new TextEncoder().encode(STORED);

    await expect(closingClient.putIfAbsent(key, body)).resolves.toBe(true);
    await expect(closingClient.putIfAbsent(key, body)).resolves.toBe(false);

    expect(new TextDecoder().decode(await closingClient.get(key))).toBe(STORED);
  });

  it('reports a refused write as already present when the refusal is lost', async () => {
    const key = objectKeyForRelativePath(`${AI_RECORDING_VERSION}/refusal-lost.json`);
    await closingClient.putIfAbsent(key, new TextEncoder().encode(STORED));

    losePutResponse = true;
    const written = await closingClient.putIfAbsent(key, new TextEncoder().encode(OVERWRITE));

    expect(written).toBe(false);
    expect(new TextDecoder().decode(await closingClient.get(key))).toBe(STORED);
  });

  it('reports an accepted write as already present when its response is lost', async () => {
    const key = objectKeyForRelativePath(`${AI_RECORDING_VERSION}/accepted-lost.json`);

    losePutResponse = true;
    const written = await closingClient.putIfAbsent(key, new TextEncoder().encode(STORED));

    expect(written).toBe(false);
    expect(new TextDecoder().decode(await closingClient.get(key))).toBe(STORED);
  });
});

/**
 * The credential boundary: no credential, signature, endpoint or account id may
 * reach a log line, a surfaced error or a file left in the workspace, on any
 * failure path the store can take.
 *
 * The values below are sentinels rather than realistic credentials, so a hit is
 * unambiguous and needs no judgement about what a "real-looking" string is.
 *
 * The unresolvable-host case is the load-bearing one. A Node transport failure
 * names the host it could not resolve on the error's `cause` — one hop from what
 * the store reports, which is `error.message` and nothing further. Widening that,
 * or logging a response body, a request URL or an Authorization header, puts a
 * sentinel or a request shape straight into these assertions.
 */
describe('the credential boundary when a request fails', () => {
  const SENTINEL_ACCOUNT_ID = 'sentinel-account-id';
  const SENTINEL_ACCESS_KEY_ID = 'SENTINELACCESSKEYID';
  const SENTINEL_SECRET = 'SENTINELSECRETACCESSKEY';

  const SENTINEL_ENV = {
    CASSETTE_R2_ACCOUNT_ID: SENTINEL_ACCOUNT_ID,
    CASSETTE_R2_ACCESS_KEY_ID: SENTINEL_ACCESS_KEY_ID,
    CASSETTE_R2_SECRET_ACCESS_KEY: SENTINEL_SECRET,
    CASSETTE_R2_BUCKET: 'sentinel-bucket',
  };

  const SENTINEL_CONFIG: CassetteStoreConfig = {
    endpoint: `https://${SENTINEL_ACCOUNT_ID}.invalid`,
    bucket: 'sentinel-bucket',
    accessKeyId: SENTINEL_ACCESS_KEY_ID,
    secretAccessKey: SENTINEL_SECRET,
  };

  const SECRETS = [
    SENTINEL_ACCOUNT_ID,
    SENTINEL_ACCESS_KEY_ID,
    SENTINEL_SECRET,
    `AWS4${SENTINEL_SECRET}`,
  ] as const;

  const SHAPES = [
    ['a request signature', /Signature=[0-9a-f]{64}/],
    ['a credential scope', /Credential=/],
    ['a signing algorithm', /AWS4-HMAC-SHA256/],
    ['a server document', /<\/?[?A-Z][A-Za-z]*/],
  ] as const;

  /** The secret-shaped values present in `text`. Empty is the property. */
  function secretsIn(text: string): string[] {
    return SECRETS.filter((secret) => text.includes(secret));
  }

  /** `secretsIn`, plus the shapes that mean a request or a server document was echoed. */
  function disclosuresIn(text: string): string[] {
    return [
      ...secretsIn(text),
      ...SHAPES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name),
    ];
  }

  /** What a caller sees when an error escapes the store. */
  function surfaced(error: unknown): string {
    return error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  }

  /** Every file left under `root`, as one string, for the artifact channel. */
  function artifactsUnder(root: string): string {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
      .join('\n');
  }

  /** Sends the request the store built to `origin` instead, otherwise intact. */
  function redirectedTo(origin: string): typeof globalThis.fetch {
    return ((url: string, init?: RequestInit) => {
      const target = new URL(url);
      return globalThis.fetch(`${origin}${target.pathname}${target.search}`, init);
    }) as unknown as typeof globalThis.fetch;
  }

  async function syncWith(
    fetchImpl: typeof globalThis.fetch,
    options: {
      readonly env?: Readonly<Record<string, string>>;
      readonly seed?: Record<string, string>;
    } = {}
  ): Promise<{ readonly log: string; readonly artifacts: string }> {
    const lines: string[] = [];
    const root = makeRoot(options.seed ?? {});
    await runCassetteSync('download', {
      env: options.env ?? SENTINEL_ENV,
      rootDir: root,
      fetch: fetchImpl,
      log: (line: string) => lines.push(line),
    });
    return { log: lines.join('\n'), artifacts: artifactsUnder(root) };
  }

  /** Whatever the promise rejected with, so the error channel can be scanned. */
  async function rejection(work: Promise<unknown>): Promise<unknown> {
    try {
      await work;
      return undefined;
    } catch (error: unknown) {
      return error;
    }
  }

  it('discloses nothing when the live store rejects sentinel credentials', async () => {
    const toLiveStore = redirectedTo(BASE.endpoint);

    const { log, artifacts } = await syncWith(toLiveStore);
    const error = await rejection(
      createCassetteStoreClient({
        config: { ...SENTINEL_CONFIG, endpoint: `https://${SENTINEL_ACCOUNT_ID}.example` },
        fetch: toLiveStore,
      }).listKeys(CASSETTE_OBJECT_PREFIX)
    );

    expect(disclosuresIn(log)).toEqual([]);
    expect(disclosuresIn(artifacts)).toEqual([]);
    expect(secretsIn(surfaced(error))).toEqual([]);
    // The live store really rejected the request: without this the assertions
    // above could hold on a request that was never made.
    expect(log).toMatch(/returned 40[013]/);
    expect(error).toBeInstanceOf(Error);
  });

  it('discloses nothing when the account id makes the endpoint unparseable', async () => {
    const unreachedFetch = (() => {
      throw new Error('the store must not send a request it could not address');
    }) as unknown as typeof globalThis.fetch;

    const { log, artifacts } = await syncWith(unreachedFetch, {
      env: { ...SENTINEL_ENV, CASSETTE_R2_ACCOUNT_ID: `${SENTINEL_ACCOUNT_ID} unparseable` },
    });

    expect(disclosuresIn(log)).toEqual([]);
    expect(disclosuresIn(artifacts)).toEqual([]);
    expect(log).toContain('Invalid URL');
  });

  it('discloses nothing when the endpoint host cannot be resolved', async () => {
    // A real DNS failure cannot be produced here: the suite blocks outbound
    // fetch and its refusal names the host it blocked. This is undici's own
    // rejection shape instead, which puts the host on the cause — one hop from
    // the message the store reports, and that hop is what is under test.
    const unresolvable = (() =>
      Promise.reject(
        new TypeError('fetch failed', {
          cause: new Error(`getaddrinfo ENOTFOUND ${SENTINEL_ACCOUNT_ID}.invalid`),
        })
      )) as unknown as typeof globalThis.fetch;

    const { log, artifacts } = await syncWith(unresolvable);
    const error = await rejection(
      createCassetteStoreClient({ config: SENTINEL_CONFIG, fetch: unresolvable }).listKeys(
        CASSETTE_OBJECT_PREFIX
      )
    );

    expect(disclosuresIn(log)).toEqual([]);
    expect(disclosuresIn(artifacts)).toEqual([]);
    expect(secretsIn(surfaced(error))).toEqual([]);
    expect(log).toContain('UNREACHABLE');
    // The host really is one hop away, so keeping it there is a result.
    expect(secretsIn(String((error as Error).cause))).toEqual([SENTINEL_ACCOUNT_ID]);
  });

  it('discloses nothing when a rejected response echoes the secret back', async () => {
    const echoing = ((url: string) => {
      if (url.includes('list-type=2')) {
        return Promise.resolve(
          new Response(
            '<ListBucketResult>' +
              `<Contents><Key>${CASSETTE_OBJECT_PREFIX}v9/rejected.json</Key></Contents>` +
              '<IsTruncated>false</IsTruncated></ListBucketResult>',
            { status: 200 }
          )
        );
      }
      return Promise.resolve(
        new Response(
          `<Error><Code>SignatureDoesNotMatch</Code>` +
            `<AWSAccessKeyId>${SENTINEL_ACCESS_KEY_ID}</AWSAccessKeyId>` +
            `<StringToSign>AWS4${SENTINEL_SECRET}</StringToSign></Error>`,
          { status: 403 }
        )
      );
    }) as unknown as typeof globalThis.fetch;

    const { log, artifacts } = await syncWith(echoing, {
      seed: { 'v9/already-here.json': '{"kept":true}' },
    });

    expect(disclosuresIn(log)).toEqual([]);
    expect(disclosuresIn(artifacts)).toEqual([]);
    expect(log).toContain('UNREACHABLE');
    // The workspace really was scanned, so an empty artifact channel is a result.
    expect(artifacts).toContain('{"kept":true}');
  });
});
