/**
 * Object-store transport for the CI HTTP cassettes.
 *
 * One object per cassette, keyed by the same version-and-hash layout the
 * harness uses on disk, in one bucket shared by every repository and branch.
 * Per-object storage is what makes the three properties the previous snapshot
 * cache bought with unique cache keys structural instead of conventional:
 *
 *   - saves never overwrite: uploads carry `If-None-Match: *`, so an object
 *     that exists wins and the second writer is told so (412);
 *   - nothing goes stale: a restore is the union of every object ever stored
 *     of the current generation, not the newest snapshot, so no run can lose
 *     an earlier run's recording;
 *   - a failed save cannot poison the store: each PUT is one whole object, and
 *     a request already recorded is never rewritten by a later run.
 *
 * A restore is scoped to the current recording generation. The store has no
 * eviction, so every generation ever recorded is still in the bucket, and the
 * harness reads only the current one — fetching the rest would grow the
 * restore by a dead generation on every bump, forever.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { AwsClient } from 'aws4fetch';
import {
  AI_RECORDING_VERSION,
  CASSETTE_FILE_SUFFIX,
  CASSETTE_OBJECT_PREFIX,
} from '@hushbox/shared/cassettes';

import { stagedWriteSync } from '../staged-write.js';

/** Key prefix of the generation the harness reads; everything else is retired. */
const CURRENT_GENERATION_PREFIX = `${CASSETTE_OBJECT_PREFIX}${AI_RECORDING_VERSION}/`;

const ACCOUNT_ID_VARIABLE = 'CASSETTE_R2_ACCOUNT_ID';
const ACCESS_KEY_ID_VARIABLE = 'CASSETTE_R2_ACCESS_KEY_ID';
const SECRET_ACCESS_KEY_VARIABLE = 'CASSETTE_R2_SECRET_ACCESS_KEY';
const BUCKET_VARIABLE = 'CASSETTE_R2_BUCKET';

/** The four secrets that configure the store, in the order they are reported. */
export const CASSETTE_STORE_VARIABLES = [
  ACCOUNT_ID_VARIABLE,
  ACCESS_KEY_ID_VARIABLE,
  SECRET_ACCESS_KEY_VARIABLE,
  BUCKET_VARIABLE,
] as const;

/** Objects are fetched in parallel; R2 round-trips dominate a restore. */
const TRANSFER_CONCURRENCY = 8;

const EMPTY_PAYLOAD_SHA256 = createHash('sha256').update('').digest('hex');

export interface CassetteStoreConfig {
  /** Origin of the S3 API, without a trailing slash. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * Reads the store configuration from an environment.
 *
 * Absent entirely (fork pull requests, an unprovisioned store) is a legal
 * state and yields `undefined` — the caller degrades to a cold cache. Present
 * in part is a misconfiguration and throws, because silently running cold on a
 * trusted runner would spend money on every run without anyone noticing.
 */
export function readCassetteStoreConfig(env: NodeJS.ProcessEnv): CassetteStoreConfig | undefined {
  const valueOf = (name: string): string => env[name] ?? '';
  const isSet = (name: string): boolean => valueOf(name).length > 0;
  if (!CASSETTE_STORE_VARIABLES.some((name) => isSet(name))) return undefined;

  const missing = CASSETTE_STORE_VARIABLES.filter((name) => !isSet(name));
  if (missing.length > 0) {
    throw new Error(`cassette store is partly configured — missing ${missing.join(', ')}`);
  }

  return {
    endpoint: `https://${valueOf(ACCOUNT_ID_VARIABLE)}.r2.cloudflarestorage.com`,
    bucket: valueOf(BUCKET_VARIABLE),
    accessKeyId: valueOf(ACCESS_KEY_ID_VARIABLE),
    secretAccessKey: valueOf(SECRET_ACCESS_KEY_VARIABLE),
  };
}

/** Maps a path relative to the cassette directory onto its object key. */
export function objectKeyForRelativePath(relativePath: string): string {
  return `${CASSETTE_OBJECT_PREFIX}${relativePath.split(path.sep).join('/')}`;
}

/**
 * Inverse of {@link objectKeyForRelativePath}, or `undefined` when the key is
 * not a cassette this tool may write. Keys come from a shared bucket, so a key
 * that would escape the cassette directory is refused rather than trusted.
 *
 * A backslash is rejected outright rather than treated as a separator to
 * traverse: `/` is the only separator an object key has, but Windows resolves
 * `\` as one too, so a segment like `..\..\evil` is inert on POSIX and an
 * escape on Windows. Refusing the character keeps the check platform-agnostic
 * instead of correct on whichever platform happened to run the test.
 */
export function relativePathForObjectKey(key: string): string | undefined {
  if (!key.startsWith(CASSETTE_OBJECT_PREFIX)) return undefined;
  const relativePath = key.slice(CASSETTE_OBJECT_PREFIX.length);
  if (!relativePath.endsWith(CASSETTE_FILE_SUFFIX) || relativePath.includes('\\')) {
    return undefined;
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return undefined;
  }
  return relativePath;
}

/** Cassette files under `rootDir`, as `/`-separated relative paths. */
export function listLocalCassetteFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  const found: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child, relativePath);
      } else if (entry.name.endsWith(CASSETTE_FILE_SUFFIX)) {
        found.push(relativePath);
      }
    }
  };
  walk(rootDir, '');
  return found;
}

interface ListObjectsPage {
  readonly keys: string[];
  readonly nextToken?: string;
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeXml(value: string): string {
  return value.replaceAll(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity] ?? entity);
}

/** Text content of every `<tag>…</tag>` in document order. */
function tagValues(xml: string, tag: string): string[] {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  return [...xml.matchAll(new RegExp(`${open}[^<]*${close}`, 'g'))].map((match) =>
    decodeXml(match[0].slice(open.length, -close.length))
  );
}

function firstTagValue(xml: string, tag: string): string | undefined {
  return tagValues(xml, tag)[0];
}

/** Extracts keys and the continuation token from one ListObjectsV2 response. */
export function parseListObjectsPage(xml: string): ListObjectsPage {
  const keys = tagValues(xml, 'Key');
  const nextToken =
    firstTagValue(xml, 'IsTruncated') === 'true'
      ? firstTagValue(xml, 'NextContinuationToken')
      : undefined;
  return nextToken === undefined ? { keys } : { keys, nextToken };
}

export interface CassetteStoreClient {
  /** Every key under `prefix`, following continuation tokens to the end. */
  listKeys(prefix: string): Promise<string[]>;
  get(key: string): Promise<Uint8Array<ArrayBuffer>>;
  /** `true` when this call stored the object, `false` when one already existed. */
  putIfAbsent(key: string, body: Uint8Array<ArrayBuffer>): Promise<boolean>;
}

interface CreateCassetteStoreClientOptions {
  readonly config: CassetteStoreConfig;
  readonly fetch: typeof globalThis.fetch;
}

function failed(operation: string, key: string, status: number): Error {
  return new Error(`cassette store ${operation} of ${key} returned ${String(status)}`);
}

/** Transport codes meaning the peer closed the connection before answering. */
const CLOSED_CONNECTION_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'EPIPE',
]);

/**
 * Whether a rejection is a connection the peer closed under an in-flight
 * request — no status, no body, nothing received.
 */
function isClosedConnection(error: unknown): boolean {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return false;
  const { code } = cause as { readonly code: unknown };
  return typeof code === 'string' && CLOSED_CONNECTION_CODES.has(code);
}

interface StoreRequest {
  readonly url: string;
  readonly method: string;
  readonly body?: Uint8Array<ArrayBuffer>;
  readonly headers?: Readonly<Record<string, string>>;
}

export function createCassetteStoreClient(
  options: CreateCassetteStoreClientOptions
): CassetteStoreClient {
  const { config, fetch } = options;

  // aws4fetch keeps the secret on this instance and keys its derived-signing-key
  // cache by it, so inspecting or serializing the client renders the plaintext secret.
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    // R2 is region-less; `auto` is what its S3 API expects in the credential scope.
    region: 'auto',
  });

  const bucketUrl = `${config.endpoint}/${encodeURIComponent(config.bucket)}`;
  const objectUrl = (key: string): string =>
    `${bucketUrl}/${key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')}`;

  const sendOnce = async (request: StoreRequest): Promise<Response> => {
    // The payload digest is stated rather than left to the library: aws4fetch
    // signs S3 requests as UNSIGNED-PAYLOAD when the header is absent, which
    // would leave the bytes being stored outside the signature.
    const payloadHash =
      request.body === undefined
        ? EMPTY_PAYLOAD_SHA256
        : createHash('sha256').update(request.body).digest('hex');
    const signed = await aws.sign(request.url, {
      method: request.method,
      headers: { ...request.headers, 'x-amz-content-sha256': payloadHash },
    });
    return fetch(signed.url, {
      method: request.method,
      headers: Object.fromEntries(signed.headers),
      ...(request.body === undefined ? {} : { body: request.body }),
    });
  };

  /**
   * One resend when the peer closed the connection under the request.
   *
   * Measured against the local object store: it answers a conditional PUT with
   * 412 and then closes the connection without a `Connection: close` header, so
   * the pool keeps the socket and the next request races the close notice —
   * whichever arrives first decides. Nothing was received when this happens, so
   * a resend hides no server answer, and every request this store makes is safe
   * to repeat — a resent conditional write lands as "already present", never as
   * an overwrite.
   *
   * The bound of one is a deliberate stopping point, not a guarantee that the
   * fault cannot recur: the resend takes a fresh socket, but the pool holds
   * other sockets doomed by other rejections, and a resend has been measured
   * failing the same way (twenty-one sequences in thirty-two hundred). One
   * resend covers the race this store actually loses; unbounded retrying would
   * turn an outage into a stall, and the sync is best-effort by design.
   */
  const send = async (request: StoreRequest): Promise<Response> => {
    try {
      return await sendOnce(request);
    } catch (error: unknown) {
      if (!isClosedConnection(error)) throw error;
      return sendOnce(request);
    }
  };

  return {
    async listKeys(prefix: string): Promise<string[]> {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const query = new URLSearchParams({ 'list-type': '2', prefix });
        if (token !== undefined) query.set('continuation-token', token);
        const response = await send({ url: `${bucketUrl}?${query.toString()}`, method: 'GET' });
        if (!response.ok) throw failed('list', config.bucket, response.status);
        const page = parseListObjectsPage(await response.text());
        keys.push(...page.keys);
        token = page.nextToken;
      } while (token !== undefined);
      return keys;
    },

    async get(key: string): Promise<Uint8Array<ArrayBuffer>> {
      const response = await send({ url: objectUrl(key), method: 'GET' });
      if (!response.ok) throw failed('get', key, response.status);
      const body = await response.arrayBuffer();
      return new Uint8Array(body);
    },

    async putIfAbsent(key: string, body: Uint8Array<ArrayBuffer>): Promise<boolean> {
      const response = await send({
        url: objectUrl(key),
        method: 'PUT',
        body,
        headers: { 'if-none-match': '*' },
      });
      // 412 is the precondition doing its job: another run recorded this exact
      // request first and its object stands. 409 is the same race reported by
      // stores that answer conditional writes with a conflict.
      if (response.status === 412 || response.status === 409) return false;
      if (!response.ok) throw failed('put', key, response.status);
      return true;
    },
  };
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  action: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      await action(items[index] as T);
    }
  });
  await Promise.all(workers);
}

interface DownloadResult {
  readonly downloaded: number;
  readonly alreadyLocal: number;
}

/**
 * Restores every cassette of the current generation that is not already on
 * disk. Retired generations are left in the bucket: the harness reads only
 * `{rootDir}/{AI_RECORDING_VERSION}`, so restoring them costs a download per
 * object and buys nothing.
 */
export async function downloadCassettes(
  client: CassetteStoreClient,
  rootDir: string
): Promise<DownloadResult> {
  const remoteKeys = await client.listKeys(CURRENT_GENERATION_PREFIX);
  const wanted = remoteKeys.flatMap((key) => {
    const relativePath = relativePathForObjectKey(key);
    return relativePath === undefined ? [] : [{ key, relativePath }];
  });

  let downloaded = 0;
  let alreadyLocal = 0;
  await forEachWithConcurrency(wanted, TRANSFER_CONCURRENCY, async ({ key, relativePath }) => {
    const file = path.join(rootDir, ...relativePath.split('/'));
    if (existsSync(file)) {
      alreadyLocal += 1;
      return;
    }
    stagedWriteSync(file, await client.get(key));
    downloaded += 1;
  });

  return { downloaded, alreadyLocal };
}

interface UploadResult {
  readonly uploaded: number;
  readonly alreadyPresent: number;
}

/**
 * Stores every local cassette the bucket does not already hold. The listing
 * makes the common case one request instead of one per cassette; the
 * precondition on each PUT is what actually guarantees no overwrite, so a
 * cassette stored between the listing and the PUT is still safe.
 */
export async function uploadCassettes(
  client: CassetteStoreClient,
  rootDir: string
): Promise<UploadResult> {
  const local = listLocalCassetteFiles(rootDir);
  if (local.length === 0) return { uploaded: 0, alreadyPresent: 0 };

  const remote = new Set(await client.listKeys(CASSETTE_OBJECT_PREFIX));
  const candidates = local
    .map((relativePath) => ({ relativePath, key: objectKeyForRelativePath(relativePath) }))
    .filter(({ key }) => !remote.has(key));

  let uploaded = 0;
  await forEachWithConcurrency(candidates, TRANSFER_CONCURRENCY, async ({ key, relativePath }) => {
    const body = new Uint8Array(readFileSync(path.join(rootDir, ...relativePath.split('/'))));
    if (await client.putIfAbsent(key, body)) uploaded += 1;
  });

  return { uploaded, alreadyPresent: local.length - uploaded };
}

interface CassetteSyncOptions {
  readonly env: NodeJS.ProcessEnv;
  /** Directory holding the version subdirectories of cassettes. */
  readonly rootDir: string;
  readonly fetch: typeof globalThis.fetch;
  readonly log: (message: string) => void;
}

const LABEL = 'cassette store:';
const COLD = 'running with a cold cache, misses will be recorded live';

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function syncSummary(
  command: 'download' | 'upload',
  client: CassetteStoreClient,
  rootDir: string
): Promise<string> {
  if (command === 'download') {
    const { downloaded, alreadyLocal } = await downloadCassettes(client, rootDir);
    return `restored ${String(downloaded)}, already on disk ${String(alreadyLocal)}`;
  }
  const { uploaded, alreadyPresent } = await uploadCassettes(client, rootDir);
  return `stored ${String(uploaded)}, already in the store ${String(alreadyPresent)}`;
}

/**
 * Runs one sync command and returns the process exit code.
 *
 * An unreachable store is not a failure: the suite still passes by recording
 * live, so the step reports loudly and exits 0. Only a misconfiguration —
 * some secrets present, some absent — fails, because that is a mistake nobody
 * would otherwise notice.
 */
export async function runCassetteSync(
  command: string,
  options: CassetteSyncOptions
): Promise<number> {
  const { env, rootDir, fetch, log } = options;

  if (command !== 'download' && command !== 'upload') {
    log(`${LABEL} unknown command '${command}' — expected download or upload`);
    return 1;
  }

  let config: CassetteStoreConfig | undefined;
  try {
    config = readCassetteStoreConfig(env);
  } catch (error: unknown) {
    log(`${LABEL} ${reasonOf(error)}`);
    return 1;
  }

  if (config === undefined) {
    log(`${LABEL} not configured — ${COLD}`);
    return 0;
  }

  const client = createCassetteStoreClient({ config, fetch });
  try {
    log(`${LABEL} ${await syncSummary(command, client, rootDir)}`);
  } catch (error: unknown) {
    log(`${LABEL} UNREACHABLE (${reasonOf(error)}) — ${COLD}`);
  }
  return 0;
}
